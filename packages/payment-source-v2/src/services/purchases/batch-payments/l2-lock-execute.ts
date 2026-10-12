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
import { MeshTxBuilder, MeshWallet } from '@meshsdk/core';
import { logger } from '@masumi/payment-core/logger';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { asV2Provider } from '../../provider-cast';
import {
	inHeadChangeMinimum,
	createTrustedL2LockWindow,
	mapPaidFundsToAssets,
	resolveL2BuyerReturnAddress,
	selectInHeadFundingUtxos,
	type L2LockAttemptOutcome,
} from './l2-lock-helpers';
import { WALLET_SPLITTER_LOVELACE } from '../../../builders/batch-helpers';
import { convertNetwork, convertNetworkToId } from '@/utils/converter/network-convert';
import { decrypt } from '@/utils/security/encryption';
import { resolveHydraL2WindowOptions } from '@/utils/hydra/l2-slot-context';
import { planL2EscrowLock } from './l2-lock-output';
import {
	reserveAndSubmitL2Lock,
	type L2HotWallet,
	type L2PurchaseRequest,
	type PaymentSourceWithL2Relations,
} from './l2-lock-submit';

export type { L2PurchaseRequest } from './l2-lock-submit';

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
	const buyerReturnAddress = resolveL2BuyerReturnAddress(request.buyerReturnAddress, hotWallet.collectionAddress);

	const protocolParameters = await hydraProvider.fetchProtocolParameters();
	const { valuePlan, datum } = planL2EscrowLock({
		request,
		smartContractAddress: paymentContract.smartContractAddress,
		buyerAddress,
		buyerReturnAddress,
		coinsPerUtxoSize: protocolParameters.coinsPerUtxoSize,
	});

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
		// Serialize the actual policy IDs, asset names and quantities in change.
		(changeAssets) => inHeadChangeMinimum(buyerAddress, changeAssets, protocolParameters.coinsPerUtxoSize),
	);

	// isHydra zeroes the fee params; setFee('0') keeps the in-head value conserved
	// exactly. A non-zero fee skims value from the head on every op (fees are not
	// redistributed in-head), accumulating into the head's headAdaOverhead until
	// Close fails the strict-equality check (H65, ChangedHeadAdaOverhead).
	const txBuilder = new MeshTxBuilder({ fetcher: hydraV2Provider, isHydra: true });
	txBuilder.protocolParams(protocolParameters);
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
	return await reserveAndSubmitL2Lock({
		request,
		hotWallet,
		hydraHeadId,
		hydraProvider,
		signedTx,
		buyerReturnAddress,
		collateralReturnLovelace: valuePlan.collateralReturnLovelace,
		guardedWallet: false,
		buildTimings: { fetchUtxosMs, buildMs, signMs },
	});
}
