/**
 * A funds-lock paid from a guarded smart wallet that sits inside a Hydra head.
 *
 * The in-head twin of `executeGuardedBatch`: the wallet UTxO comes from the head
 * snapshot, the quorum co-signs the frozen body, and the reserve and submit
 * steps are the ones every L2 lock uses. Without the quorum's witnesses the head
 * refuses the spend, so there is never an unguarded fallback.
 *
 * Mesh pinning (ADR-0005): V2 package. The root HydraProvider is bridged through
 * `asV2Provider` only where mesh types require it.
 */
import { randomUUID } from 'node:crypto';
import { MeshWallet, resolveTxHash, type UTxO } from '@meshsdk/core';
import { GuardedHydraTransferDirection } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { fetchPendingCommitRefs } from '@/lib/hydra/hydra/pending-commit';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { convertNetwork, convertNetworkToId } from '@/utils/converter/network-convert';
import { decrypt } from '@/utils/security/encryption';
import { resolveHydraL2WindowOptions } from '@/utils/hydra/l2-slot-context';
import { CosignTransportError, mergeCosignWitnesses, requestCosign } from '../../../smart-wallet/cosign-client';
import { buildGuardedL2LockTx } from '../../../smart-wallet/guarded-l2-lock-builder';
import { cosignerKeyHashes } from '../../../smart-wallet/wallet';
import { toHydraSnapshotProof } from '../../../smart-wallet/hydra-snapshot/build-proof';
import type { HydraSnapshotProof } from '../../../smart-wallet/hydra-snapshot/snapshot-proof';
import { loadSmartWalletScript, readWalletDatum } from '../../../smart-wallet/wallet-lifecycle';
import { pickBatchCollateral } from '../../../builders/batch-helpers';
import { cosignConfigOrNull } from './cosign-config';
import { hasOpenGuardedMove } from './guarded-open-move';
import { classifyCosignResult, type CosignOutcome } from './cosign-disposition';
import { cosignIntentFor, guardedLockValue, recordCosignDispositionsFor } from './guarded-cosign-purchase';
import { createTrustedL2LockWindow, resolveL2BuyerReturnAddress, type L2LockAttemptOutcome } from './l2-lock-helpers';
import { planL2EscrowLock } from './l2-lock-output';
import {
	reserveAndSubmitL2Lock,
	type L2HotWallet,
	type L2PurchaseRequest,
	type PaymentSourceWithL2Relations,
} from './l2-lock-submit';

export type GuardedWalletInHead = { walletUtxo: UTxO; snapshot: UTxO[] };

/**
 * The guarded wallet's UTxO in this head's snapshot, found by its state token.
 * Null when the head does not hold it, or while the owner is moving it out: a
 * lock would spend the UTxO the owner's withdraw is signed against.
 */
export async function locateGuardedWalletForLock(
	guarded: { id: string; policyId: string; stateTokenName: string },
	hydraHeadId: string,
): Promise<GuardedWalletInHead | 'moving' | null> {
	const node = getHydraConnectionManager().getNode(hydraHeadId);
	if (node == null) return null;
	const unit = `${guarded.policyId}${guarded.stateTokenName}`;
	const snapshot = await node.snapshotUTxO();
	const held = snapshot.filter((utxo) =>
		utxo.output.amount.some((asset) => asset.unit === unit && BigInt(asset.quantity) === 1n),
	);
	if (held.length !== 1) return null;
	// A withdraw spends this UTxO; a lock now would race it. The wallet is still here, just not usable.
	const heldWalletUtxoRef = `${held[0].input.txHash}#${held[0].input.outputIndex}`;
	// Approved but not finalized: the ledger cannot spend it yet. A read failure throws (indeterminate).
	const pending = await fetchPendingCommitRefs(node);
	if (pending.includes(heldWalletUtxoRef.toLowerCase())) return 'moving';
	if (await hasOpenGuardedMove({ id: guarded.id, heldWalletUtxoRef }, GuardedHydraTransferDirection.Withdraw)) {
		return 'moving';
	}
	// Collateral is picked from this snapshot too, so no pending UTxO may stay in it.
	const usable = snapshot.filter(
		(utxo) => !pending.includes(`${utxo.input.txHash}#${utxo.input.outputIndex}`.toLowerCase()),
	);
	return { walletUtxo: held[0], snapshot: usable };
}

/**
 * The latest confirmed snapshot, with every party's signature, as proof for the
 * co-signer that `walletUtxoRef` exists in this head with exactly this output.
 * Throws when the node cannot give one that holds the wallet, so no co-sign is
 * asked for on a proof that would fail.
 */
export async function signedSnapshotHoldingWallet(
	hydraHeadId: string,
	headIdentifier: string,
	walletUtxoRef: string,
): Promise<HydraSnapshotProof> {
	const node = getHydraConnectionManager().getNode(hydraHeadId);
	if (node == null) throw new Error(`No live connection to head ${hydraHeadId}`);
	// Throws when the snapshot does not hold the wallet UTxO.
	const proof = toHydraSnapshotProof(await node.get('/snapshot'), walletUtxoRef);
	if (proof.headId !== headIdentifier.toLowerCase()) throw new Error('The node returned a snapshot of another head');
	return proof;
}

/** The co-signer refused or deferred; the purchase got its disposition and nothing was submitted. */
export type GuardedL2LockOutcome = L2LockAttemptOutcome | { status: 'cosign-refused' };

/**
 * Lock one purchase from the guarded wallet in `hydraHeadId`. Throws only before
 * a reservation exists, so the caller may try elsewhere.
 */
export async function executeGuardedL2Lock(params: {
	request: L2PurchaseRequest;
	paymentContract: PaymentSourceWithL2Relations;
	hotWallet: L2HotWallet;
	hydraHeadId: string;
	walletUtxo: UTxO;
	snapshot: UTxO[];
}): Promise<GuardedL2LockOutcome> {
	const { request, paymentContract, hotWallet, hydraHeadId, walletUtxo, snapshot } = params;
	const guarded = hotWallet.GuardedWallet;
	if (guarded == null) throw new Error('executeGuardedL2Lock called for a plain wallet');
	if (request.payByTime == null) throw new Error('Pay by time is null, this is deprecated');
	const cosignConfig = cosignConfigOrNull();
	if (cosignConfig == null) throw new Error('Exchain co-signing is not configured on this node');

	const network = convertNetwork(paymentContract.network);
	const script = loadSmartWalletScript({
		ownerAddress: guarded.ownerAddress,
		quorumVkhs: guarded.quorumVkhs,
		threshold: guarded.threshold,
		network,
	});
	if (script.address !== guarded.scriptAddress || script.policyId !== guarded.policyId) {
		throw new Error('The guarded wallet script no longer matches its attach record; detach and attach it again');
	}
	const head = await prisma.hydraHead.findUnique({ where: { id: hydraHeadId }, select: { headIdentifier: true } });
	if (head?.headIdentifier == null) throw new Error(`head ${hydraHeadId} has no observed head identifier`);
	const hydraProvider = getHydraConnectionManager().getProvider(hydraHeadId);
	if (hydraProvider == null) throw new Error(`No active HydraProvider for head ${hydraHeadId}`);

	const window = createTrustedL2LockWindow({
		network,
		payByTime: request.payByTime,
		headClock: hydraProvider.getHeadClock(),
		windowOptions: resolveHydraL2WindowOptions(hydraProvider),
	});
	const agent = new MeshWallet({
		networkId: convertNetworkToId(paymentContract.network),
		key: { type: 'mnemonic', words: decrypt(hotWallet.Secret.encryptedMnemonic).split(' ') },
	});
	await agent.init();
	const agentAddress = hotWallet.walletAddress;
	const collateral = pickBatchCollateral(
		snapshot.filter((utxo) => utxo.output.address === agentAddress),
		[walletUtxo.input],
	);
	if (collateral == null) {
		throw new Error('the agent holds no plain in-head UTxO of at least 5 ADA to lend as collateral');
	}

	// The one-asset rule of a guarded wallet, checked before anything is built.
	guardedLockValue(request, guarded.governedAsset);
	const protocolParameters = await hydraProvider.fetchProtocolParameters();
	const buyerReturnAddress = resolveL2BuyerReturnAddress(request.buyerReturnAddress, hotWallet.collectionAddress);
	const { valuePlan, datum } = planL2EscrowLock({
		request,
		smartContractAddress: paymentContract.smartContractAddress,
		buyerAddress: agentAddress,
		buyerReturnAddress,
		coinsPerUtxoSize: protocolParameters.coinsPerUtxoSize,
	});
	// The planned output: the price plus the min-UTxO lovelace the escrow needs.
	const lockValue = guardedLockValue({ id: request.id, PaidFunds: valuePlan.outputFunds }, guarded.governedAsset);
	const cosignerVkhs = cosignerKeyHashes(guarded, script.owner);

	const tBuild = Date.now();
	const built = await buildGuardedL2LockTx({
		network,
		wallet: { scriptCode: script.scriptCode, address: script.address },
		walletUtxo,
		walletDatum: readWalletDatum(walletUtxo),
		agentAddress,
		collateral,
		cosignerVkhs,
		locks: [
			{
				address: paymentContract.smartContractAddress,
				amount: lockValue.amount,
				datum: datum.value,
			},
		],
		window,
		protocolParameters,
		headCostModels: await hydraProvider.fetchRawCostModels(),
	});
	const buildMs = Date.now() - tBuild;

	const walletUtxoRef = `${walletUtxo.input.txHash}#${walletUtxo.input.outputIndex}`;
	const hydraSnapshot = await signedSnapshotHoldingWallet(hydraHeadId, head.headIdentifier, walletUtxoRef);

	const tCosign = Date.now();
	let outcome: CosignOutcome;
	try {
		outcome = await requestCosign(cosignConfig, {
			unsignedTx: built.unsignedTx,
			batchId: randomUUID(),
			walletUtxoRef,
			intents: [cosignIntentFor(request, built.lockOutputIndexes[0], guarded.governedAsset, lockValue.governedAmount)],
			context: {
				nodeId: cosignConfig.nodeId,
				orgId: cosignConfig.orgId,
				submittedAt: new Date().toISOString(),
				walletAddress: script.address,
				hydraHeadId: head.headIdentifier,
				hydraSnapshot,
			},
		});
	} catch (error) {
		if (!(error instanceof CosignTransportError)) throw error;
		outcome = { transportError: error.message };
	}
	const cosignMs = Date.now() - tCosign;

	// One purchase per body, so a partial approval has nothing left to rebuild with.
	const classification = classifyCosignResult(outcome, [request.id], false);
	if (classification.kind !== 'approved') {
		await recordCosignDispositionsFor([request], classification.refused);
		logger.info('guarded L2 lock not co-signed; purchase requeued or parked', { requestId: request.id, hydraHeadId });
		return { status: 'cosign-refused' };
	}
	if (!('httpStatus' in outcome) || outcome.httpStatus !== 200) {
		throw new Error('co-sign classified as approved without an approval');
	}

	const merged = mergeCosignWitnesses(
		built.unsignedTx,
		{ txHash: built.txHash, signerVkhs: cosignerVkhs },
		outcome.approved.witnessSetHex,
	);
	const signedTx = await agent.signTx(merged, true);
	if (resolveTxHash(signedTx) !== built.txHash) throw new Error('the agent signature changed the frozen body');

	// The owner may have prepared a withdraw of this UTxO while the quorum signed.
	if (
		await hasOpenGuardedMove(
			{ id: guarded.id, heldWalletUtxoRef: walletUtxoRef },
			GuardedHydraTransferDirection.Withdraw,
		)
	) {
		await recordCosignDispositionsFor(
			[request],
			new Map([[request.id, { kind: 'retry', note: 'A withdraw of the guarded wallet started; retrying' }]]),
		);
		return { status: 'cosign-refused' };
	}

	return await reserveAndSubmitL2Lock({
		request,
		hotWallet,
		hydraHeadId,
		hydraProvider,
		signedTx,
		buyerReturnAddress,
		collateralReturnLovelace: valuePlan.collateralReturnLovelace,
		guardedWallet: true,
		buildTimings: { buildMs, cosignMs },
	});
}
