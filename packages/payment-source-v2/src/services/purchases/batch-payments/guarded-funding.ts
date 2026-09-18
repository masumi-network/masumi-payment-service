// Funds-lock from a guarded smart wallet: build the AgentSpend body, freeze it,
// have the Exchain quorum co-sign it, merge the witnesses. The caller signs with
// the agent key afterwards and never rebuilds after that signature.
import { randomUUID } from 'node:crypto';
import type { GuardedWallet } from '@/generated/prisma/client';
import { deserializeAddress, type Asset, type BlockfrostProvider, type Data, type UTxO } from '@meshsdk/core';
import { blake2b, HexBlob } from '@meshsdk/core-cst';
import { CONSTANTS } from '@masumi/payment-core/config';
import { logger } from '@masumi/payment-core/logger';
import { WALLET_SPLITTER_LOVELACE } from '../../../builders/batch-helpers';
import {
	mergeCosignWitnesses,
	requestCosign,
	type CosignConfig,
	type CosignDecision,
	type CosignDeny,
	type CosignIntent,
} from '../../../smart-wallet/cosign-client';
import {
	buildGuardedLockTx,
	GuardedTxTooLargeError,
	type GuardedLockBuild,
} from '../../../smart-wallet/guarded-lock-builder';
import { deriveSmartWalletScript, fetchWalletUtxo, readWalletDatum } from '../../../smart-wallet/wallet-lifecycle';

const COSIGN_TOKEN_REF_PATTERN = /^EXCHAIN_COSIGN_API_KEY[A-Z0-9_]*$/;
export const DEFAULT_COSIGN_TOKEN_REF = 'EXCHAIN_COSIGN_API_KEY';

export type GuardedPurchase = {
	id: string;
	blockchainIdentifier: string;
	agentIdentifier: string | null;
	sellerVkey: string;
	amount: Asset[];
	datum: Data;
};

export type CosignDenied = {
	code: string;
	reasonEnglish: string | null;
	retryAfterSec: number | null;
	retryAt: number | null;
	decisionId: string;
};

/** A denial or outage of the whole batch. Nothing was signed and nothing left the host. */
export class CosignBatchError extends Error {
	constructor(
		message: string,
		/** Members a first answer already denied by name; they keep their own verdict. */
		readonly denied: Map<string, CosignDenied> = new Map(),
	) {
		super(message);
		this.name = 'CosignBatchError';
	}
}

/** The node token is read from the environment at call time and never persisted or logged. */
export function cosignConfigFor(guarded: Pick<GuardedWallet, 'cosignBaseUrl' | 'cosignTokenRef'>): CosignConfig {
	if (!COSIGN_TOKEN_REF_PATTERN.test(guarded.cosignTokenRef)) {
		throw new Error('cosignTokenRef must name an EXCHAIN_COSIGN_API_KEY* environment variable');
	}
	const apiKey = process.env[guarded.cosignTokenRef]?.trim();
	if (!apiKey) {
		throw new Error(`${guarded.cosignTokenRef} is not set; the guarded wallet cannot reach its co-signer`);
	}
	const timeoutMs = Number(process.env.EXCHAIN_COSIGN_TIMEOUT_MS);
	return {
		url: guarded.cosignBaseUrl,
		apiKey,
		timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
		trustedPlaintextHosts: (process.env.EXCHAIN_COSIGN_TRUSTED_PLAINTEXT_HOSTS ?? '').split(','),
	};
}

export function guardedWalletScript(
	guarded: Pick<GuardedWallet, 'walletAddress' | 'scriptHash' | 'ownerKeyHash' | 'quorumKeyHashes' | 'quorumThreshold'>,
	network: 'preprod' | 'mainnet',
) {
	const script = deriveSmartWalletScript({
		owner: guarded.ownerKeyHash,
		stakeKeyHash: deserializeAddress(guarded.walletAddress).stakeCredentialHash || null,
		quorumVkhs: guarded.quorumKeyHashes,
		threshold: guarded.quorumThreshold,
		network,
	});
	if (script.address !== guarded.walletAddress || script.policyId !== guarded.scriptHash) {
		throw new Error('the guarded wallet facts do not derive its address and script hash');
	}
	return script;
}

export async function fetchGuardedWalletUtxo(
	provider: Pick<BlockfrostProvider, 'fetchAddressUTxOs'>,
	guarded: Pick<GuardedWallet, 'walletAddress' | 'stateToken'>,
): Promise<UTxO> {
	const [policyId, tokenName] = guarded.stateToken.split('.');
	return fetchWalletUtxo(provider, { address: guarded.walletAddress, policyId }, tokenName);
}

function intentFor(purchase: GuardedPurchase, outputIndex: number): CosignIntent {
	const governed = purchase.amount.find((asset) => asset.unit !== 'lovelace') ??
		purchase.amount.find((asset) => asset.unit === 'lovelace') ?? { unit: 'lovelace', quantity: '0' };
	return {
		purchaseId: purchase.id,
		outputIndex,
		counterparty: `sellerVkeyHash:${purchase.sellerVkey}`,
		amount: governed.quantity,
		asset: governed.unit === 'lovelace' ? 'lovelace' : `${governed.unit.slice(0, 56)}.${governed.unit.slice(56)}`,
		jobHash: `blake2b_256:${blake2b.hash(HexBlob(Buffer.from(purchase.blockchainIdentifier, 'utf8').toString('hex')), 32)}`,
		agentIdentifier: purchase.agentIdentifier ?? purchase.blockchainIdentifier,
	};
}

async function cosignWithRetry(
	request: () => Promise<CosignDecision>,
): Promise<Exclude<CosignDecision, { httpStatus: 503 }>> {
	const retry = CONSTANTS.RETRY_CONFIG;
	let delayMs: number = retry.INITIAL_DELAY_MS;
	for (let attempt = 1; ; attempt++) {
		const decision = await request();
		if (decision.httpStatus !== 503) return decision;
		if (attempt >= retry.MAX_RETRIES) {
			throw new CosignBatchError(
				`co-sign quorum unavailable (HTTP 503) after ${attempt} attempts: ${decision.unavailable.reachable} of ${decision.unavailable.threshold} members reachable`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		delayMs = Math.min(delayMs * retry.BACKOFF_MULTIPLIER, retry.MAX_DELAY_MS);
	}
}

function deniedMembers(deny: CosignDeny, nowMs: number): Map<string, CosignDenied> {
	return new Map(
		deny.members
			.filter((member) => member.verdict === 'denied')
			.map((member) => [
				member.purchaseId,
				{
					code: member.denied ?? deny.denied,
					reasonEnglish: member.reasonEnglish ?? null,
					retryAfterSec: member.retryAfterSec ?? null,
					retryAt: member.retryAfterSec == null ? null : nowMs + member.retryAfterSec * 1000,
					decisionId: deny.decisionId,
				},
			]),
	);
}

export type GuardedBatchResult = {
	/** The frozen body with the quorum witnesses merged; only the agent signature is missing. Null when every member was denied. */
	cosignedTx: string | null;
	invalidAfter: number;
	keptIds: string[];
	denied: Map<string, CosignDenied>;
};

export async function buildAndCosignGuardedBatch(params: {
	provider: BlockfrostProvider;
	rpcApiKey: string;
	network: 'preprod' | 'mainnet';
	guarded: GuardedWallet;
	agentAddress: string;
	agentUtxos: UTxO[];
	escrowAddress: string;
	purchases: GuardedPurchase[];
	constrainAfterMs: bigint;
}): Promise<GuardedBatchResult> {
	const { guarded } = params;
	const config = cosignConfigFor(guarded);
	const script = guardedWalletScript(guarded, params.network);
	const quorumVkhs = [...new Set(guarded.quorumKeyHashes)];
	const walletUtxo = await fetchGuardedWalletUtxo(params.provider, guarded);
	const walletDatum = readWalletDatum(walletUtxo);
	// The agent's change must carry lovelace only, or the verifier sees value it cannot attribute.
	const agentUtxos = params.agentUtxos.filter((utxo) => utxo.output.amount.every((asset) => asset.unit === 'lovelace'));
	const batchId = randomUUID();
	const denied = new Map<string, CosignDenied>();

	let purchases = params.purchases;
	let invalidAfter = 0;
	for (;;) {
		let built: GuardedLockBuild;
		try {
			built = await buildGuardedLockTx({
				provider: params.provider,
				rpcApiKey: params.rpcApiKey,
				network: params.network,
				wallet: { scriptCode: script.scriptCode, address: script.address },
				walletUtxo,
				walletDatum,
				agentAddress: params.agentAddress,
				agentUtxos,
				cosignerVkhs: quorumVkhs,
				locks: purchases.map((purchase) => ({
					address: params.escrowAddress,
					amount: purchase.amount,
					datum: purchase.datum,
				})),
				agentSplitterLovelace: WALLET_SPLITTER_LOVELACE,
				constrainAfterMs: params.constrainAfterMs,
			});
		} catch (error) {
			if (error instanceof GuardedTxTooLargeError && purchases.length > 1) {
				purchases = purchases.slice(0, -1);
				continue;
			}
			throw error;
		}

		invalidAfter = built.validity.invalidAfter;
		let decision: Awaited<ReturnType<typeof cosignWithRetry>>;
		try {
			decision = await cosignWithRetry(() =>
				requestCosign(config, built.unsignedTx, {
					batchId,
					walletUtxoRef: `${walletUtxo.input.txHash}#${walletUtxo.input.outputIndex}`,
					intents: purchases.map((purchase, index) => intentFor(purchase, index + 1)),
					context: { nodeId: guarded.nodeId, orgId: guarded.orgId, submittedAt: new Date().toISOString() },
				}),
			);
			if (decision.httpStatus === 200) {
				return {
					cosignedTx: mergeCosignWitnesses(
						built.unsignedTx,
						{ txHash: built.txHash, quorumVkhs: guarded.quorumKeyHashes, threshold: guarded.quorumThreshold },
						decision.allow.witnessSetHex,
					),
					invalidAfter,
					keptIds: purchases.map((purchase) => purchase.id),
					denied,
				};
			}
		} catch (error) {
			if (!(error instanceof CosignBatchError)) {
				logger.error('co-sign answer rejected; the batch is aborted and nothing is signed', {
					batchId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			throw error;
		}

		const { deny } = decision;
		if (deny.denied !== 'member_denied') {
			(deny.alarm ? logger.error : logger.warn)('co-sign denied the whole batch', {
				decisionId: deny.decisionId,
				code: deny.denied,
				alarm: deny.alarm,
				batchId,
			});
			throw new CosignBatchError(`co-sign denied the batch: ${deny.denied} (decision ${deny.decisionId})`, denied);
		}
		const keep = new Set(deny.rebuild?.keep ?? []);
		const kept = purchases.filter((purchase) => keep.has(purchase.id));
		if (denied.size > 0 || kept.length === purchases.length || kept.length !== keep.size) {
			throw new CosignBatchError(
				`co-sign denied the rebuilt batch: member_denied (decision ${deny.decisionId})`,
				denied,
			);
		}
		for (const [purchaseId, verdict] of deniedMembers(deny, Date.now())) denied.set(purchaseId, verdict);
		if (kept.length === 0) {
			return { cosignedTx: null, invalidAfter, keptIds: [], denied };
		}
		purchases = kept;
	}
}
