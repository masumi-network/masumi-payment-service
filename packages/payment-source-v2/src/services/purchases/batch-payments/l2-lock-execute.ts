/**
 * The V2 Hydra L2 funds-lock itself: build it, reserve it, submit it, record it.
 *
 * Split from `./l2-lock`, which selects the requests and decides where each one
 * should run. This is what happens to one request once that decision is made,
 * and it is the half that carries the money-safety ordering: the request row
 * and the exact intended hash are written before NewTx, so an accepted lock can
 * never be retried or re-routed to L1 because a post-accept write failed.
 *
 * Mesh pinning (ADR-0005): V2 package, so `@meshsdk/core` is the beta.103 line.
 * The root (beta.96) `HydraProvider` is bridged into it via `asV2Provider`, and
 * the lock wallet is built bound to the head provider so coin selection draws
 * from the buyer's in-head UTxOs rather than L1.
 */
import { MeshTxBuilder, MeshWallet, resolveTxHash } from '@meshsdk/core';
import { PurchasingAction, TransactionLayer, TransactionStatus, Prisma } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { asV2Provider } from '../../provider-cast';
import { createDatumFromBlockchainIdentifierV2 } from '@masumi/payment-source-v2';
import { SmartContractState } from '@masumi/payment-core/smart-contract-state';
import {
	buildL2LockDatumParams,
	createTrustedL2LockWindow,
	mapPaidFundsToAssets,
	planL2LockValue,
	requireFreshL2LockHeadClock,
	retainInitialL2LockAfterSubmitFailure,
	resolveL2BuyerReturnAddress,
	selectInHeadFundingUtxos,
	type L2LockAttemptOutcome,
} from './l2-lock-helpers';
import { WALLET_SPLITTER_LOVELACE } from '../../../builders/batch-helpers';
import { convertNetwork, convertNetworkToId } from '@/utils/converter/network-convert';
import { decrypt } from '@/utils/security/encryption';
import { connectPreviousAction, createNextPurchaseAction } from '@/services/shared';
import { resolveHydraL2WindowOptions } from '@/utils/hydra/l2-slot-context';
import { requireHydraValidityUpperSlot } from '@/services/hydra-connection-manager/hydra-transaction-evidence';
import { calculateMinUtxo, DUMMY_RESULT_HASH } from '@/utils/min-utxo';
import { lockOpenHydraHeadForL2Reservation } from '../../l2-submission';
import { HydraTransactionRejectedError } from '@/lib/hydra/hydra/errors';

type PaymentSourceWithL2Relations = Prisma.PaymentSourceGetPayload<{
	include: {
		PaymentSourceConfig: true;
		PurchaseRequests: {
			include: {
				PaidFunds: true;
				SellerWallet: true;
				NextAction: true;
				HotWalletLimit: { select: { id: true } };
			};
		};
		HotWallets: {
			include: {
				Secret: true;
			};
		};
	};
}>;

export type L2PurchaseRequest = PaymentSourceWithL2Relations['PurchaseRequests'][number];
type L2HotWallet = PaymentSourceWithL2Relations['HotWallets'][number];

/**
 * Build + submit a single funds-lock transaction INSIDE an open Hydra head.
 * The buyer's in-head UTxOs (committed earlier) fund a script output carrying
 * the FundsLocked datum. Submit is synchronous via the head; on success the
 * request advances to FundsLockingInitiated with an L2 CurrentTransaction.
 */
export async function executeL2Lock(
	request: L2PurchaseRequest,
	paymentContract: PaymentSourceWithL2Relations,
	hotWallet: L2HotWallet,
	hydraHeadId: string,
): Promise<L2LockAttemptOutcome> {
	if (request.payByTime == null) {
		throw new Error('Pay by time is null, this is deprecated');
	}
	if (request.inputHash == null) {
		throw new Error('Purchase request has no input hash');
	}

	const hydraProvider = getHydraConnectionManager().getProvider(hydraHeadId);
	if (!hydraProvider) {
		throw new Error(`No active HydraProvider for head ${hydraHeadId}`);
	}
	// Initial lock moves new value into escrow, so no-clock / stale-clock fallback
	// is unsafe here. Anchor the body to a recent Tick and cap its upper validity
	// bound at payByTime. This also gives reconciliation deadline evidence from
	// signed CBOR rather than relying only on a websocket observation timestamp.
	const lockWindow = createTrustedL2LockWindow({
		network: convertNetwork(paymentContract.network),
		payByTime: request.payByTime,
		headClock: hydraProvider.getHeadClock(),
		windowOptions: resolveHydraL2WindowOptions(hydraProvider),
	});
	// Bridge the (root, beta.96) HydraProvider into the V2 (102) type surface.
	const hydraV2Provider = asV2Provider(hydraProvider);

	const mnemonic = decrypt(hotWallet.Secret.encryptedMnemonic).split(' ');
	// Wallet bound to the head provider → getUtxos() returns the buyer's
	// in-head UTxOs, so the Transaction selects head funds (not L1).
	const wallet = new MeshWallet({
		networkId: convertNetworkToId(paymentContract.network),
		fetcher: hydraV2Provider,
		submitter: hydraV2Provider,
		key: { type: 'mnemonic', words: mnemonic },
	});

	// MeshWallet builds its address set lazily on its first async call. The
	// synchronous getUsedAddress() below throws ("bech32.decode input: string
	// expected") on an uninitialised wallet, so prime it via the async API first
	// — the same ordering generateWalletExtended relies on. (The L1 batch path
	// gets an already-initialised wallet from loadHotWalletSession; this inline
	// wallet does not, which is why the init is needed only here.)
	await wallet.getUnusedAddresses();
	const buyerAddress = wallet.getUsedAddress().toBech32() as string;
	const sellerAddress = request.SellerWallet.walletAddress;
	const buyerReturnAddress = resolveL2BuyerReturnAddress(request.buyerReturnAddress, hotWallet.collectionAddress);

	const lockRequestFields = {
		buyerReturnAddress: request.buyerReturnAddress,
		sellerReturnAddress: request.sellerReturnAddress,
		blockchainIdentifier: request.blockchainIdentifier,
		inputHash: request.inputHash,
		payByTime: request.payByTime,
		submitResultTime: request.submitResultTime,
		unlockTime: request.unlockTime,
		externalDisputeUnlockTime: request.externalDisputeUnlockTime,
	};
	const protocolParameters = await hydraProvider.fetchProtocolParameters();
	if (!Number.isSafeInteger(protocolParameters.coinsPerUtxoSize) || protocolParameters.coinsPerUtxoSize <= 0) {
		throw new Error('Hydra protocol parameters contain an invalid coinsPerUtxoSize');
	}
	const nativeTokenCount = request.PaidFunds.filter(
		(fund) => fund.unit !== '' && fund.unit.toLowerCase() !== 'lovelace',
	).length;
	const valuePlan = planL2LockValue(request.PaidFunds, (collateralReturnLovelace) => {
		// Size for the larger ResultSubmitted continuation, as the L1 path does.
		// The validator preserves value across SubmitResult, so pre-funding here
		// prevents the seller from needing a separate ADA top-up later.
		const estimateDatum = createDatumFromBlockchainIdentifierV2({
			...buildL2LockDatumParams({
				request: lockRequestFields,
				buyerAddress,
				sellerAddress,
				buyerReturnAddress,
				collateralReturnLovelace,
			}),
			resultHash: DUMMY_RESULT_HASH,
			state: SmartContractState.ResultSubmitted,
		});
		return calculateMinUtxo({
			datum: estimateDatum.value,
			nativeTokenCount,
			coinsPerUtxoSize: protocolParameters.coinsPerUtxoSize,
			includeBuffers: true,
		}).minUtxoLovelace;
	});
	const datum = createDatumFromBlockchainIdentifierV2(
		buildL2LockDatumParams({
			request: lockRequestFields,
			buyerAddress,
			sellerAddress,
			buyerReturnAddress,
			collateralReturnLovelace: valuePlan.collateralReturnLovelace,
		}),
	);

	// Build the in-head lock on MeshTxBuilder with EXPLICIT inputs, mirroring the
	// proven 02-fund-in-head transfer (which completes on this exact head).
	//
	// We deliberately do NOT use selectUtxosFrom / automatic coin selection: when
	// mesh's selector adds an input it re-resolves the UTxO via
	// fetcher.fetchUTxOs(txHash) (MeshTxBuilder.getUTxOInfo). The Hydra provider
	// serves only full head snapshots, not per-tx UTxO queries, so that call never
	// returns and complete() stalls — the exact hang seen with both the legacy
	// `Transaction` class and selectUtxosFrom. Supplying each input's amount +
	// address up front keeps complete() fully offline. The lock is a script OUTPUT
	// with an inline datum and NO script execution → no redeemer, no collateral,
	// no script_data_hash, so no evaluation is needed.
	// A deposit still being folded in is already in the head's snapshot and is
	// not yet spendable: the head refuses anything consuming it with "all inputs
	// are spent", which reads like a malformed transaction and is really a race
	// with the fold. Dropping just those references keeps the head usable on the
	// funds it already had — only a wallet whose entire balance is the arriving
	// deposit has to wait, and that falls out of selection below.
	const pendingIncrementRefs = hydraProvider.getPendingIncrementUtxoRefs?.() ?? new Set<string>();
	const tFetchUtxos = Date.now();
	const allWalletUtxos = await wallet.getUtxos();
	const fetchUtxosMs = Date.now() - tFetchUtxos;
	const walletUtxos = allWalletUtxos.filter(
		(utxo) => !pendingIncrementRefs.has(`${utxo.input.txHash}#${utxo.input.outputIndex}`.toLowerCase()),
	);
	if (walletUtxos.length !== allWalletUtxos.length) {
		logger.info('L2 lock: leaving a deposit that is still being folded in out of coin selection', {
			purchaseRequestId: request.id,
			hydraHeadId,
			excludedUtxoCount: allWalletUtxos.length - walletUtxos.length,
		});
	}
	// Select explicit inputs of ANY form (pure-ADA or asset-carrying) that cover
	// the paid funds + a splitter self-send + a min-UTxO change floor; leftover
	// assets are returned by changeAddress below. See selectInHeadFundingUtxos for
	// why mesh's own coin selector cannot be used against the Hydra provider.
	const MIN_CHANGE_LOVELACE = 2_000_000n;
	const selected = selectInHeadFundingUtxos(
		walletUtxos,
		valuePlan.outputFunds,
		WALLET_SPLITTER_LOVELACE,
		MIN_CHANGE_LOVELACE,
		// Real min-UTxO of the (datum-less) change output given its leftover asset
		// count — an asset-heavy change can exceed the 2-ADA floor, and hitting that
		// only at submitTx would land AFTER the fail-closed reservation.
		(changeAssets) =>
			calculateMinUtxo({
				datum: Buffer.alloc(0),
				nativeTokenCount: changeAssets.length,
				coinsPerUtxoSize: protocolParameters.coinsPerUtxoSize,
				includeBuffers: true,
			}).minUtxoLovelace,
	);

	// isHydra zeroes the fee params; setFee('0') keeps the in-head value conserved
	// exactly. A non-zero fee skims value from the head on every op (fees are not
	// redistributed in-head), accumulating into the head's headAdaOverhead until
	// Close fails the strict-equality check (H65, ChangedHeadAdaOverhead).
	const txBuilder = new MeshTxBuilder({ fetcher: hydraV2Provider, isHydra: true });
	for (const u of selected) {
		// The 5th arg (scriptSize = 0) is ESSENTIAL on a Hydra head. Without it mesh
		// marks the input "incomplete" (isInputInfoComplete requires scriptSize to be
		// defined) and during complete() resolves it via fetcher.fetchUTxOs(txHash).
		// The buyer's in-head UTxOs were created by an L2-native tx whose hash exists
		// ONLY inside the head — a per-tx query the Hydra provider cannot answer, so
		// the build hangs forever. Passing scriptSize makes the input self-complete
		// (these are pure pubkey UTxOs, no script ref) so mesh never queries.
		txBuilder.txIn(u.input.txHash, u.input.outputIndex, u.output.amount, u.output.address, 0);
	}
	// Script OUTPUT with the FundsLocked inline datum (matches the spend builders'
	// txInInlineDatumPresent()). `datum` is { value, inline } from getDatumV2;
	// txOutInlineDatumValue takes the Mesh Data value. The splitter self-send keeps
	// the buyer wallet at >=2 in-head UTxOs after the lock so the eventual
	// collect-refund / authorize-withdrawal script spend has a separate collateral
	// input. Hydra validates the same Cardano slot validity interval as L1; use
	// the trusted head-clock window resolved above rather than wall-clock slots.
	txBuilder
		.txOut(paymentContract.smartContractAddress, mapPaidFundsToAssets(valuePlan.outputFunds))
		.txOutInlineDatumValue(datum.value)
		.txOut(buyerAddress, [{ unit: 'lovelace', quantity: WALLET_SPLITTER_LOVELACE.toString() }])
		.setFee('0')
		.changeAddress(buyerAddress)
		.setNetwork(convertNetwork(paymentContract.network))
		.invalidBefore(lockWindow.invalidBefore)
		.invalidHereafter(lockWindow.invalidAfter)
		.metadataValue(674, { msg: ['Masumi', 'PaymentBatched'] });

	const tBuild = Date.now();
	await txBuilder.complete();
	const buildMs = Date.now() - tBuild;
	const completeTx = txBuilder.txHex;

	const tSign = Date.now();
	const signedTx = await wallet.signTx(completeTx);
	const signMs = Date.now() - tSign;
	const intendedTxHash = resolveTxHash(signedTx);
	const invalidHereafterSlot = requireHydraValidityUpperSlot(signedTx);
	// Build/sign can take long enough for the original Tick to become stale or
	// for the head to cross payByTime. Re-check immediately before the atomic DB
	// reservation; the signed body's upper bound handles the remaining race to
	// NewTx without permitting a post-deadline lock.
	const reservationHeadTimeMs = requireFreshL2LockHeadClock({
		headClock: hydraProvider.getHeadClock(),
		payByTime: request.payByTime,
	});

	// Reserve request + wallet BEFORE NewTx. A positive node acknowledgement
	// followed by a DB outage must leave durable evidence that this exact signed
	// body owns the request; otherwise the loop below can submit it from another head wallet and
	// the same scheduler tick can also pick it up in the L1 pass.
	const tReserve = Date.now();
	const reservation = await reserveL2LockBeforeSubmit({
		request,
		hotWallet,
		hydraHeadId,
		intendedTxHash,
		invalidHereafterSlot,
		buyerReturnAddress,
		collateralReturnLovelace: valuePlan.collateralReturnLovelace,
		trustedHeadTimeMs: reservationHeadTimeMs,
	});

	const reserveMs = Date.now() - tReserve;

	const tSubmit = Date.now();
	let txHash: string;
	try {
		txHash = await hydraProvider.submitTx(signedTx);
	} catch (error) {
		// Neither transport failure nor TxInvalid proves that an initial lock's
		// wallet inputs remain fresh. A withholding node can relay a valid lock and
		// then report rejection; releasing this reservation would permit a second
		// lock from different inputs. Keep it fail-closed for reconciliation.
		// A rejection naming our own transaction hash is the one outcome that is
		// not ambiguous: the head refused this body. Record it so recovery can
		// hand the request back once the body's validity window has closed and it
		// can never be included after the fact. The reservation stays held either
		// way — this only decides whether it can ever be released.
		if (error instanceof HydraTransactionRejectedError) {
			await prisma.transaction
				.updateMany({
					where: { id: reservation.transactionId, status: TransactionStatus.Pending, l2RejectedByHeadAt: null },
					data: { l2RejectedByHeadAt: new Date(), l2RejectedByHeadReason: error.message.slice(0, 500) },
				})
				.catch((persistError: unknown) => {
					// The reservation is what protects the funds; failing to annotate it
					// only means recovery cannot release it automatically later.
					logger.warn('L2 lock: could not record the head rejection on the reservation', {
						purchaseRequestId: request.id,
						hydraHeadId,
						error: persistError instanceof Error ? persistError.message : persistError,
					});
				});
		}
		return retainInitialL2LockAfterSubmitFailure(intendedTxHash, error);
	}
	const submitMs = Date.now() - tSubmit;

	// Every phase, not just the transaction. The transaction was never the
	// expensive part — build, sign and submit come to about twenty milliseconds
	// against a lock that takes a quarter of a second — and without the rest
	// measured beside them it is impossible to say where the other 90% goes.
	logger.info('L2 lock tx timing', {
		purchaseRequestId: request.id,
		hydraHeadId,
		fetchUtxosMs,
		buildMs,
		signMs,
		reserveMs,
		submitMs,
	});

	if (txHash !== intendedTxHash) {
		const error = new Error(`Hydra returned divergent txHash ${txHash} vs intended ${intendedTxHash}`);
		logger.error('L2 funds-lock returned divergent txHash; preserving reservation fail-closed', {
			purchaseRequestId: request.id,
			hydraHeadId,
			txHash,
			intendedTxHash,
		});
		return { status: 'ambiguous', intendedTxHash, error };
	}

	const tFinalize = Date.now();
	try {
		await finalizeAcceptedL2Lock({
			request,
			reservation,
			txHash,
		});
		logger.info('L2 lock finalize timing', {
			purchaseRequestId: request.id,
			hydraHeadId,
			finalizeMs: Date.now() - tFinalize,
		});
	} catch (error) {
		// A positive node acknowledgement is not consensus proof. The pre-submit
		// reservation remains Pending with intendedTxHash until signed snapshot
		// evidence reconciles it, keeping both this loop and L1 fail-closed.
		logger.error('L2 funds-lock accepted but txHash persistence failed; reservation retained', {
			purchaseRequestId: request.id,
			walletId: hotWallet.id,
			hydraHeadId,
			transactionId: reservation.transactionId,
			txHash,
			error: error instanceof Error ? error.message : error,
		});
		return { status: 'accepted-db-pending', txHash, error };
	}

	logger.info('L2 funds-lock submitted to head', {
		purchaseRequestId: request.id,
		walletId: hotWallet.id,
		hydraHeadId,
		txHash,
	});
	return { status: 'accepted', txHash };
}

type L2LockReservation = {
	transactionId: string;
	initiatedActionId: string;
};

async function reserveL2LockBeforeSubmit(params: {
	request: L2PurchaseRequest;
	hotWallet: L2HotWallet;
	hydraHeadId: string;
	intendedTxHash: string;
	invalidHereafterSlot: bigint;
	buyerReturnAddress: string | null;
	collateralReturnLovelace: bigint;
	trustedHeadTimeMs: number;
}): Promise<L2LockReservation> {
	const {
		request,
		hotWallet,
		hydraHeadId,
		intendedTxHash,
		invalidHereafterSlot,
		buyerReturnAddress,
		collateralReturnLovelace,
		trustedHeadTimeMs,
	} = params;
	return await prisma.$transaction(
		async (tx) => {
			await lockOpenHydraHeadForL2Reservation(tx, hydraHeadId);
			const l2Transaction = await tx.transaction.create({
				data: {
					intendedTxHash,
					invalidHereafterSlot,
					status: TransactionStatus.Pending,
					layer: TransactionLayer.L2,
					l2ReservationPreviousActionId: request.nextActionId,
					l2ReservationPreviousTransactionId: request.currentTransactionId,
					l2ReservationPreviousLayer: request.layer,
					l2ReservationPreviousSmartContractWalletId: request.smartContractWalletId,
					l2ReservationPreviousBuyerReturnAddress: request.buyerReturnAddress,
					l2ReservationPreviousCollateralReturn: request.collateralReturnLovelace,
					HydraHead: { connect: { id: hydraHeadId } },
					lastCheckedAt: new Date(),
				},
				select: { id: true },
			});

			const claimedWallet = await tx.hotWallet.updateMany({
				where: {
					id: hotWallet.id,
					deletedAt: null,
					lockedAt: null,
					pendingTransactionId: null,
				},
				data: {
					lockedAt: new Date(),
					pendingTransactionId: l2Transaction.id,
				},
			});
			if (claimedWallet.count !== 1) {
				throw new Error(`L2 purchasing wallet ${hotWallet.id} was claimed concurrently`);
			}

			const updatedRequest = await tx.purchaseRequest.update({
				where: {
					id: request.id,
					nextActionId: request.nextActionId,
					currentTransactionId: null,
					// Bind the reservation to the exact deadline that was checked and
					// require it to remain ahead of the trusted head clock. A concurrent
					// deadline edit cannot turn a validated request into an expired lock.
					payByTime: { equals: request.payByTime, gt: BigInt(trustedHeadTimeMs) },
				},
				data: {
					layer: TransactionLayer.L2,
					...connectPreviousAction(request.nextActionId),
					...createNextPurchaseAction(PurchasingAction.FundsLockingInitiated),
					collateralReturnLovelace,
					SmartContractWallet: { connect: { id: hotWallet.id } },
					buyerReturnAddress,
					CurrentTransaction: { connect: { id: l2Transaction.id } },
				},
				select: { nextActionId: true },
			});

			return {
				transactionId: l2Transaction.id,
				initiatedActionId: updatedRequest.nextActionId,
			};
		},
		{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
	);
}

async function finalizeAcceptedL2Lock(params: {
	request: L2PurchaseRequest;
	reservation: L2LockReservation;
	txHash: string;
}): Promise<void> {
	const { request, reservation, txHash } = params;
	await prisma.$transaction(async (tx) => {
		await tx.transaction.update({
			where: {
				id: reservation.transactionId,
				status: TransactionStatus.Pending,
				intendedTxHash: txHash,
			},
			data: { txHash, lastCheckedAt: new Date() },
		});

		// Pair only the SAME payment source's seller row (blockchainIdentifier is
		// globally unique, so an unscoped lookup could grab a different source's
		// payment), and mirror datum-sync's `paymentRoutingAllowsHydra` gate: a row
		// that already has on-chain state or whose seller forced L1 must NOT be
		// stamped L2 + connected to this head reservation — doing so both violates
		// the seller's routing choice and, because the connected tx then counts as
		// a head blocker whose newOnChainState can never match, permanently blocks
		// the head's final reconciliation handoff.
		const paymentRequest = await tx.paymentRequest.findUnique({
			where: {
				blockchainIdentifier: request.blockchainIdentifier,
				paymentSourceId: request.paymentSourceId,
			},
			select: { id: true, currentTransactionId: true, layer: true, onChainState: true, forceLayer: true },
		});
		if (
			paymentRequest != null &&
			paymentRequest.currentTransactionId == null &&
			paymentRequest.onChainState == null &&
			paymentRequest.forceLayer !== TransactionLayer.L1
		) {
			await tx.transaction.update({
				where: { id: reservation.transactionId, status: TransactionStatus.Pending, intendedTxHash: txHash },
				data: { l2ReservationPeerPreviousLayer: paymentRequest.layer },
			});
			await tx.paymentRequest.update({
				where: { id: paymentRequest.id, currentTransactionId: null },
				data: {
					layer: TransactionLayer.L2,
					CurrentTransaction: { connect: { id: reservation.transactionId } },
				},
			});
		}
	});
}
