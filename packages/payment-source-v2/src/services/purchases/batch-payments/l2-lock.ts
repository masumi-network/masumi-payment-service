/**
 * V2 Hydra L2 funds-lock (head entry).
 *
 * ISOLATED from the L1 batch path on purpose. The L1 `executeSpecificBatchPayment`
 * carries money-safety machinery that is mostly L1-specific (cost-model mutex,
 * slot-bounded funding reconciliation). L2 still needs the same pre-submit
 * reservation principle: hydra-node can return TxValid synchronously, but only
 * signed snapshot evidence proves confirmation and the DB write can still fail.
 * The request and exact intended hash are therefore
 * persisted before NewTx so an accepted lock can never be retried or routed to
 * L1 merely because the post-accept txHash write failed.
 *   - the lock is a plain `sendAssets`-to-script with a datum and NO script
 *     execution, so there is no cost-model / script-data-hash concern.
 *
 * Mesh pinning (ADR-0005): this file is in the V2 package and imports
 * `@meshsdk/core` → **beta.103**. The (root, beta.96) `HydraProvider` is bridged
 * into the 103 type surface via `asV2Provider` — same pattern as the
 * `submit-result` L2 reference. The lock wallet is constructed bound to the head
 * provider so coin-selection draws from the buyer's IN-HEAD UTxOs (committed via
 * the head `commit` lifecycle), not L1.
 *
 * Requires a funded open head. In-head acceptance was validated on a Hydra
 * devnet with committed funds (see docs/hydra-l2-devnet-findings.md).
 */
import { MeshTxBuilder, MeshWallet, resolveTxHash } from '@meshsdk/core';
import {
	HotWalletType,
	PaymentSourceType,
	PurchaseErrorType,
	PurchasingAction,
	TransactionLayer,
	TransactionStatus,
	Prisma,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { resolveUsableHydraHeadForPurchase } from '@/utils/hydra/resolve-hydra-head';
import { resolveEffectiveForceLayer } from '@/utils/logic/force-layer';
import { asV2Provider } from '../../provider-cast';
import { createDatumFromBlockchainIdentifierV2 } from '@masumi/payment-source-v2';
import { SmartContractState } from '@masumi/payment-core/smart-contract-state';
import {
	buildL2LockDatumParams,
	createTrustedL2LockWindow,
	isHotWalletEligibleForL2Lock,
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

type L2PurchaseRequest = PaymentSourceWithL2Relations['PurchaseRequests'][number];
type L2HotWallet = PaymentSourceWithL2Relations['HotWallets'][number];

/**
 * Build + submit a single funds-lock transaction INSIDE an open Hydra head.
 * The buyer's in-head UTxOs (committed earlier) fund a script output carrying
 * the FundsLocked datum. Submit is synchronous via the head; on success the
 * request advances to FundsLockingInitiated with an L2 CurrentTransaction.
 */
async function executeL2Lock(
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
	const walletUtxos = await wallet.getUtxos();
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

	const tSubmit = Date.now();
	let txHash: string;
	try {
		txHash = await hydraProvider.submitTx(signedTx);
	} catch (error) {
		// Neither transport failure nor TxInvalid proves that an initial lock's
		// wallet inputs remain fresh. A withholding node can relay a valid lock and
		// then report rejection; releasing this reservation would permit a second
		// lock from different inputs. Keep it fail-closed for reconciliation.
		return retainInitialL2LockAfterSubmitFailure(intendedTxHash, error);
	}
	const submitMs = Date.now() - tSubmit;

	logger.info('L2 lock tx timing', {
		purchaseRequestId: request.id,
		hydraHeadId,
		buildMs,
		signMs,
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

	try {
		await finalizeAcceptedL2Lock({
			request,
			reservation,
			txHash,
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

/**
 * Route FundsLockingRequested V2 purchase requests through an open Hydra head
 * when one exists for (buyer hot wallet, seller). Runs BEFORE the L1 batch pass;
 * a handled request gets an L2 CurrentTransaction, so the L1 lock-and-query
 * (which filters `CurrentTransaction: { is: null }`) naturally skips it — no
 * explicit exclusion needed.
 *
 * Invoked under the batch-payments per-tick mutex, so L2 selection is serialized
 * with the L1 pass within a process.
 */
export async function processL2PurchaseLocks(): Promise<void> {
	const paymentSources = await prisma.paymentSource.findMany({
		where: {
			deletedAt: null,
			syncInProgress: false,
			disablePaymentAt: null,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		},
		include: {
			PaymentSourceConfig: true,
			PurchaseRequests: {
				where: {
					NextAction: {
						requestedAction: PurchasingAction.FundsLockingRequested,
						errorType: null,
					},
					CurrentTransaction: { is: null },
					onChainState: null,
				},
				include: {
					PaidFunds: true,
					SellerWallet: true,
					NextAction: true,
					HotWalletLimit: { select: { id: true } },
				},
			},
			HotWallets: {
				where: {
					type: HotWalletType.Purchasing,
					deletedAt: null,
				},
				include: {
					Secret: true,
				},
			},
		},
	});

	for (const paymentContract of paymentSources) {
		if (paymentContract.PurchaseRequests.length === 0) {
			continue;
		}
		// Track wallets used this tick in addition to the durable DB lease. The set
		// avoids repeated probes against this query's now-stale wallet objects.
		const usedWalletIds = new Set<string>();

		for (const request of paymentContract.PurchaseRequests) {
			// Resolve the buyer override against the seller choice authenticated by
			// the V2 identifier signature and persisted on this purchase. Payment and
			// purchase requests commonly live on different servers, so routing must
			// never depend on finding a local paired PaymentRequest.
			// This gates routing:
			//   L1        → never lock on L2 (leave for the L1 pass);
			//   L2        → REQUIRE an open head, else FAIL (never fall back to L1);
			//   conflict  → FAIL (buyer and seller forced different layers);
			//   null      → auto (try L2 if a head is available, else fall to L1).
			const effectiveForce = resolveEffectiveForceLayer(request.forceLayer, request.paymentForceLayer);
			if (effectiveForce === 'conflict') {
				await failForcedL2Request(request, 'forceLayer conflict: buyer and seller force different layers');
				continue;
			}
			if (effectiveForce === TransactionLayer.L1) {
				continue; // forced L1 → the L1 batch pass locks it
			}
			const forcedHydra = effectiveForce === TransactionLayer.L2;

			// `headAvailable` = a usable open head EXISTS for this buyer/seller pair,
			// independent of whether its wallet is still free THIS tick. It must be
			// probed for busy wallets too: otherwise, when more forced-Hydra purchases
			// than head-bearing wallets arrive in one tick, the later requests would
			// see no free wallet, conclude "no head" and be wrongly failed — when they
			// should just retry next tick once the wallet frees. Only a genuine
			// absence of any head fails a forced-Hydra request.
			let headAvailable = false;
			let headResolutionIndeterminate = false;
			let locked = false;
			for (const hotWallet of paymentContract.HotWallets) {
				if (!isHotWalletEligibleForL2Lock(request, hotWallet.id)) {
					continue;
				}
				let head;
				try {
					head = await resolveUsableHydraHeadForPurchase(hotWallet.id, request.sellerWalletId, paymentContract.network);
				} catch (error) {
					headResolutionIndeterminate = true;
					logger.warn('L2 lock: head resolution failed', { requestId: request.id, walletId: hotWallet.id, error });
					continue;
				}
				if (!head) {
					continue;
				}
				const provider = getHydraConnectionManager().getProvider(head.hydraHead.id);
				if (!provider) {
					// The persisted head exists, but this process temporarily has no live
					// provider. Treat that as indeterminate so a forced request retries
					// instead of being permanently failed during reconnect/startup.
					headResolutionIndeterminate = true;
					continue;
				}
				// A head exists for this pair — record it BEFORE the wallet-busy check so
				// a busy wallet never masquerades as "no head".
				headAvailable = true;
				if (usedWalletIds.has(hotWallet.id) || hotWallet.lockedAt != null || hotWallet.pendingTransactionId != null) {
					// Wallet already built a lock tx this tick; try another wallet, and if
					// none is free the request retries next tick (not failed).
					continue;
				}

				try {
					const outcome = await executeL2Lock(request, paymentContract, hotWallet, head.hydraHead.id);
					// Accepted, accepted-but-not-finalized, and ambiguous outcomes all
					// retain the durable pre-submit reservation. Treat the request as
					// handled so neither another wallet nor this tick's L1 pass can touch it.
					usedWalletIds.add(hotWallet.id);
					locked = true;
					if (outcome.status === 'ambiguous') {
						logger.warn('L2 funds-lock outcome ambiguous; reservation retained for Hydra reconciliation', {
							requestId: request.id,
							walletId: hotWallet.id,
							hydraHeadId: head.hydraHead.id,
							intendedTxHash: outcome.intendedTxHash,
							error: outcome.error instanceof Error ? outcome.error.message : outcome.error,
						});
					}
				} catch (error) {
					// executeL2Lock throws only before a reservation exists (build/sign or
					// atomic reservation failure). No body can have been submitted, so
					// another eligible wallet is safe.
					logger.warn('L2 funds-lock failed before submit reservation; trying another eligible wallet', {
						requestId: request.id,
						walletId: hotWallet.id,
						hydraHeadId: head.hydraHead.id,
						error: error instanceof Error ? error.message : error,
					});
					continue;
				}
				break; // request handled against its free head wallet
			}

			// Forced Hydra but NO usable open head exists for this buyer/seller pair at
			// all: fail loudly instead of silently falling back to L1. A head that
			// exists but whose wallet is merely busy this tick leaves `headAvailable`
			// true, so the request retries next tick rather than being failed.
			if (forcedHydra && !locked && !headAvailable && !headResolutionIndeterminate) {
				await failForcedL2Request(request, 'forceLayer=Hydra but no open head is available for this request');
			} else if (forcedHydra && !locked && headResolutionIndeterminate) {
				logger.info('L2 lock: Hydra availability is indeterminate; leaving forced request for retry', {
					requestId: request.id,
				});
			}
		}
	}
}

/**
 * Fail a purchase request that forced Hydra when no head is available (or whose
 * buyer/seller force conflicts). Parks it in WaitingForManualAction with an error
 * so it is NOT picked up by the L1 pass and surfaces to the operator — mirrors
 * the timeout-invalidation write in tx-sync.
 */
async function failForcedL2Request(request: L2PurchaseRequest, reason: string): Promise<void> {
	logger.warn('L2 lock: failing forced-Hydra request', { requestId: request.id, reason });
	try {
		await prisma.purchaseRequest.update({
			where: { id: request.id, nextActionId: request.nextActionId },
			data: {
				ActionHistory: { connect: { id: request.nextActionId } },
				NextAction: {
					create: {
						requestedAction: PurchasingAction.WaitingForManualAction,
						errorType: PurchaseErrorType.Unknown,
						errorNote: reason,
					},
				},
			},
		});
	} catch (error) {
		if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
			// The optimistic nextActionId guard raced. The other writer owns the
			// request now, so leave its state intact.
			logger.warn('L2 lock: failForcedL2Request update raced (guard miss); leaving to concurrent op', {
				requestId: request.id,
				nextActionId: request.nextActionId,
			});
			return;
		}
		throw error;
	}
}
