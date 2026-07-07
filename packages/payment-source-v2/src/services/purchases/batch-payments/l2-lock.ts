/**
 * V2 Hydra L2 funds-lock (head entry).
 *
 * ISOLATED from the L1 batch path on purpose. The L1 `executeSpecificBatchPayment`
 * carries money-safety machinery that is L1-specific (placeholder Transaction
 * rows, `BatchPairingOutcome`, funding-reconciliation by `intendedTxHash`,
 * cost-model mutex). On L2 none of that applies:
 *   - the head is zero-fee and submit is SYNCHRONOUS (hydra-node returns
 *     TxValid / TxInvalid), so there is no ambiguous-submit window and no
 *     reconciliation worker is needed;
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
import { MeshTxBuilder, MeshWallet } from '@meshsdk/core';
import {
	HotWalletType,
	PaymentSourceType,
	PurchasingAction,
	TransactionLayer,
	TransactionStatus,
	type Prisma,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { resolveUsableHydraHeadForPurchase } from '@/utils/hydra/resolve-hydra-head';
import { asV2Provider } from '../../provider-cast';
import { createDatumFromBlockchainIdentifierV2 } from '@masumi/payment-source-v2';
import { buildL2LockDatumParams, mapPaidFundsToAssets, resolveL2BuyerReturnAddress } from './l2-lock-helpers';
import { WALLET_SPLITTER_LOVELACE } from '../../../builders/batch-helpers';
import { convertNetwork, convertNetworkToId } from '@/utils/converter/network-convert';
import { decrypt } from '@/utils/security/encryption';
import { connectPreviousAction, createNextPurchaseAction } from '@/services/shared';

type PaymentSourceWithL2Relations = Prisma.PaymentSourceGetPayload<{
	include: {
		PaymentSourceConfig: true;
		PurchaseRequests: {
			include: {
				PaidFunds: true;
				SellerWallet: true;
				NextAction: true;
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
): Promise<boolean> {
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

	// L2 lock datum: identical shape to the L1 lock (FundsLocked, no result).
	// collateralReturnLovelace is 0n — the head is zero-fee so there is no
	// min-UTxO overestimation to absorb (matches the original L2 design at
	// commit 6b58c22e). Per-head min-UTxO sizing is a future refinement.
	const datum = createDatumFromBlockchainIdentifierV2(
		buildL2LockDatumParams({
			request: {
				buyerReturnAddress: request.buyerReturnAddress,
				sellerReturnAddress: request.sellerReturnAddress,
				blockchainIdentifier: request.blockchainIdentifier,
				inputHash: request.inputHash,
				payByTime: request.payByTime,
				submitResultTime: request.submitResultTime,
				unlockTime: request.unlockTime,
				externalDisputeUnlockTime: request.externalDisputeUnlockTime,
			},
			buyerAddress,
			sellerAddress,
			buyerReturnAddress,
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
	const getLovelace = (u: { output: { amount: Array<{ unit: string; quantity: string }> } }): bigint =>
		BigInt(u.output.amount.find((a) => a.unit === 'lovelace' || a.unit === '')?.quantity ?? '0');

	const walletUtxos = await wallet.getUtxos();
	// Pure-ADA, non-script in-head UTxOs owned by the buyer fund the lock. Largest
	// first so the fewest inputs cover the target.
	const fundingUtxos = walletUtxos
		.filter((u) => !u.output.plutusData && u.output.amount.every((a) => a.unit === 'lovelace' || a.unit === ''))
		.sort((a, b) => Number(getLovelace(b) - getLovelace(a)));
	if (fundingUtxos.length === 0) {
		throw new Error('buyer wallet has no pure-ADA in-head UTxOs to fund the lock');
	}

	const lockLovelace = request.PaidFunds.reduce(
		(sum, f) => sum + (f.unit === '' || f.unit.toLowerCase() === 'lovelace' ? f.amount : 0n),
		0n,
	);
	// Cover: lock value + the splitter self-send + a min-UTxO change floor. With a
	// zero fee, change = selected − (lock + splitter).
	const MIN_CHANGE_LOVELACE = 1_000_000n;
	const targetLovelace = lockLovelace + WALLET_SPLITTER_LOVELACE + MIN_CHANGE_LOVELACE;
	const selected: typeof fundingUtxos = [];
	let selectedLovelace = 0n;
	for (const u of fundingUtxos) {
		selected.push(u);
		selectedLovelace += getLovelace(u);
		if (selectedLovelace >= targetLovelace) break;
	}
	if (selectedLovelace < targetLovelace) {
		throw new Error(
			`insufficient in-head ADA to lock: have ${selectedLovelace.toString()}, need ${targetLovelace.toString()}`,
		);
	}

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
	// input. No invalidBefore/invalidHereafter on L2 (matches 6b58c22e): head txs
	// are not subject to L1 slot validity windows.
	txBuilder
		.txOut(paymentContract.smartContractAddress, mapPaidFundsToAssets(request.PaidFunds))
		.txOutInlineDatumValue(datum.value)
		.txOut(buyerAddress, [{ unit: 'lovelace', quantity: WALLET_SPLITTER_LOVELACE.toString() }])
		.setFee('0')
		.changeAddress(buyerAddress)
		.setNetwork(convertNetwork(paymentContract.network))
		.metadataValue(674, { msg: ['Masumi', 'PaymentBatched'] });

	const tBuild = Date.now();
	await txBuilder.complete();
	const buildMs = Date.now() - tBuild;
	const completeTx = txBuilder.txHex;

	const tSign = Date.now();
	const signedTx = await wallet.signTx(completeTx);
	const signMs = Date.now() - tSign;

	// Synchronous submit to the head (TxValid / TxInvalid). No reconciliation
	// window: a throw means the tx did not enter the head, so the request stays
	// FundsLockingRequested for the next tick.
	const tSubmit = Date.now();
	const txHash = await hydraProvider.submitTx(signedTx);
	const submitMs = Date.now() - tSubmit;

	logger.info('L2 lock tx timing', {
		purchaseRequestId: request.id,
		hydraHeadId,
		buildMs,
		signMs,
		submitMs,
	});

	await prisma.$transaction(async (tx) => {
		const l2Transaction = await tx.transaction.create({
			data: {
				txHash,
				status: TransactionStatus.Pending,
				layer: TransactionLayer.L2,
				HydraHead: { connect: { id: hydraHeadId } },
				lastCheckedAt: new Date(),
				BlocksWallet: { connect: { id: hotWallet.id } },
			},
		});

		await tx.purchaseRequest.update({
			where: { id: request.id },
			data: {
				layer: TransactionLayer.L2,
				...connectPreviousAction(request.nextActionId),
				...createNextPurchaseAction(PurchasingAction.FundsLockingInitiated),
				collateralReturnLovelace: 0n,
				SmartContractWallet: { connect: { id: hotWallet.id } },
				buyerReturnAddress,
				CurrentTransaction: { connect: { id: l2Transaction.id } },
			},
		});

		const paymentRequest = await tx.paymentRequest.findUnique({
			where: { blockchainIdentifier: request.blockchainIdentifier },
			select: { id: true },
		});
		if (paymentRequest) {
			await tx.paymentRequest.update({
				where: { id: paymentRequest.id },
				data: {
					layer: TransactionLayer.L2,
					CurrentTransaction: { connect: { id: l2Transaction.id } },
				},
			});
		}
	});

	logger.info('L2 funds-lock submitted to head', {
		purchaseRequestId: request.id,
		walletId: hotWallet.id,
		hydraHeadId,
		txHash,
	});
	return true;
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
				},
			},
			HotWallets: {
				where: {
					type: HotWalletType.Purchasing,
					deletedAt: null,
					lockedAt: null,
					PendingTransaction: null,
				},
				include: {
					Secret: true,
				},
			},
		},
	});

	for (const paymentContract of paymentSources) {
		if (paymentContract.PurchaseRequests.length === 0 || paymentContract.HotWallets.length === 0) {
			continue;
		}
		// Track wallets used this tick so two requests don't target the same
		// wallet before its PendingTransaction lands (it is set post-submit).
		const usedWalletIds = new Set<string>();

		for (const request of paymentContract.PurchaseRequests) {
			for (const hotWallet of paymentContract.HotWallets) {
				if (usedWalletIds.has(hotWallet.id)) {
					continue;
				}
				let head;
				try {
					head = await resolveUsableHydraHeadForPurchase(hotWallet.id, request.sellerWalletId, paymentContract.network);
				} catch (error) {
					logger.warn('L2 lock: head resolution failed', { requestId: request.id, walletId: hotWallet.id, error });
					continue;
				}
				if (!head) {
					continue;
				}
				const provider = getHydraConnectionManager().getProvider(head.hydraHead.id);
				if (!provider) {
					continue;
				}

				try {
					await executeL2Lock(request, paymentContract, hotWallet, head.hydraHead.id);
					usedWalletIds.add(hotWallet.id);
				} catch (error) {
					// L2 submit is synchronous; a failure means no tx entered the head.
					// Leave the request FundsLockingRequested for the next tick (no
					// state regression, no double-lock risk).
					logger.warn('L2 funds-lock failed; leaving request for retry', {
						requestId: request.id,
						walletId: hotWallet.id,
						hydraHeadId: head.hydraHead.id,
						error: error instanceof Error ? error.message : error,
					});
				}
				break; // request handled (or attempted) against its head
			}
		}
	}
}
