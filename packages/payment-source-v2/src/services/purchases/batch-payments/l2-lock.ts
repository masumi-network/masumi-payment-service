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
 * `@meshsdk/core` → **beta.102**. The (root, beta.96) `HydraProvider` is bridged
 * into the 102 type surface via `asV2Provider` — same pattern as the
 * `submit-result` L2 reference. The lock wallet is constructed bound to the head
 * provider so coin-selection draws from the buyer's IN-HEAD UTxOs (committed via
 * the head `commit` lifecycle), not L1.
 *
 * Requires a funded open head. In-head acceptance was validated on a Hydra
 * devnet with committed funds (see docs/hydra-l2-devnet-findings.md).
 */
import { MeshWallet, Transaction } from '@meshsdk/core';
import {
	HotWalletType,
	PaymentSourceType,
	PurchasingAction,
	TransactionLayer,
	type Prisma,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { resolveUsableHydraHeadForPurchase } from '@/utils/hydra/resolve-hydra-head';
import { asV2Provider } from '../../provider-cast';
import { createDatumFromBlockchainIdentifierV2 } from '@masumi/payment-source-v2';
import { buildL2LockDatumParams, mapPaidFundsToAssets, resolveL2BuyerReturnAddress } from './l2-lock-helpers';
import { convertNetwork, convertNetworkToId } from '@/utils/converter/network-convert';
import { decrypt } from '@/utils/security/encryption';
import { connectPreviousAction, createNextPurchaseAction, createPendingTransaction } from '@/services/shared';

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

	// isHydra: true → head protocol params, no L1 fee/validity-window handling.
	// No invalidBefore/invalidHereafter on L2 (matches 6b58c22e): head txs are
	// not subject to L1 slot validity windows.
	const unsignedTx = new Transaction({
		initiator: wallet,
		fetcher: hydraV2Provider,
		isHydra: true,
	}).setMetadata(674, {
		msg: ['Masumi', 'PaymentBatched'],
	});

	unsignedTx.sendAssets(
		{ address: paymentContract.smartContractAddress, datum },
		mapPaidFundsToAssets(request.PaidFunds),
	);
	unsignedTx.setNetwork(convertNetwork(paymentContract.network));

	const completeTx = await unsignedTx.build();
	const signedTx = await wallet.signTx(completeTx);
	// Synchronous submit to the head (TxValid / TxInvalid). No reconciliation
	// window: a throw means the tx did not enter the head, so the request stays
	// FundsLockingRequested for the next tick.
	const txHash = await hydraProvider.submitTx(signedTx);

	await prisma.purchaseRequest.update({
		where: { id: request.id },
		data: {
			layer: TransactionLayer.L2,
			...connectPreviousAction(request.nextActionId),
			...createNextPurchaseAction(PurchasingAction.FundsLockingInitiated),
			collateralReturnLovelace: 0n,
			SmartContractWallet: { connect: { id: hotWallet.id } },
			buyerReturnAddress,
			...createPendingTransaction(hotWallet.id, txHash, {
				layer: TransactionLayer.L2,
				hydraHeadId,
			}),
		},
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
