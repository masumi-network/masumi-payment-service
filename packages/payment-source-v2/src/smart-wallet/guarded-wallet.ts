import { BlockfrostProvider, resolvePaymentKeyHash } from '@meshsdk/core';
import { z } from '@masumi/payment-core/zod';
import { assertSafeCosignUrl } from './cosign-client';
import { assetValueGet, lovelaceOf } from './wallet';
import { fetchWalletUtxo, loadSmartWalletScript, readWalletDatum } from './wallet-lifecycle';

/**
 * Guarded wallet helpers for the node's admin API. They live in the V2 package
 * so the script derivation and the chain read stay on the V2 mesh line.
 */

const REGISTER_TIMEOUT_MS = 10_000;
// The validator keys lovelace as the empty policy and the empty asset name.
const LOVELACE_POLICY = '';
const LOVELACE_NAME = '';

export type GuardedWalletParams = {
	ownerAddress: string;
	quorumVkhs: string[];
	threshold: number;
	stateTokenName: string;
	network: 'preprod' | 'mainnet';
};

export type GuardedWalletState = {
	scriptAddress: string;
	policyId: string;
	/** The datum's agent key hash: the hot wallet that may spend. */
	agentVkh: string;
	lovelace: bigint;
	periodLimitLovelace: bigint;
	spentInPeriodLovelace: bigint;
	periodStartMs: bigint;
	periodLengthMs: bigint;
	minBalanceLovelace: bigint;
};

/** Derive the wallet script and read its single state-token UTxO. Throws when it is not exactly one. */
export async function inspectGuardedWallet(
	params: GuardedWalletParams,
	rpcApiKey: string,
): Promise<GuardedWalletState> {
	const script = loadSmartWalletScript(params);
	const walletUtxo = await fetchWalletUtxo(new BlockfrostProvider(rpcApiKey), script, params.stateTokenName);
	const datum = readWalletDatum(walletUtxo);
	return {
		scriptAddress: script.address,
		policyId: script.policyId,
		agentVkh: datum.agent,
		lovelace: lovelaceOf(walletUtxo.output.amount),
		periodLimitLovelace: assetValueGet(datum.limit, LOVELACE_POLICY, LOVELACE_NAME) ?? 0n,
		spentInPeriodLovelace: assetValueGet(datum.spentInPeriod, LOVELACE_POLICY, LOVELACE_NAME) ?? 0n,
		periodStartMs: datum.periodStart,
		periodLengthMs: datum.periodLength,
		minBalanceLovelace: datum.minBalanceLovelace,
	};
}

/** The mandate Exchain enforces, in lovelace. It cannot change once registered. */
export type ExchainMandate = {
	perTxCap: string;
	daily: string;
	perSeller: string;
	perAgent: string;
	envelope: string;
	burstPerMinute: number;
};

export class ExchainRegistrationError extends Error {
	constructor(
		message: string,
		readonly status: number | null,
	) {
		super(message);
		this.name = 'ExchainRegistrationError';
	}
}

const registrationReply = z.object({ walletId: z.string().min(1), mandateEnglish: z.string().optional() });

/**
 * Register a guarded wallet and its mandate with Exchain (`POST /v1/wallets`).
 * A repeat of the same body returns the same wallet id; a different mandate is refused.
 */
export async function registerGuardedWalletWithExchain(params: {
	baseUrl: string;
	token: string;
	nodeId: string;
	orgId: string;
	wallet: GuardedWalletParams & { scriptAddress: string; policyId: string };
	agentVkhs: string[];
	escrowAddresses: string[];
	mandate: ExchainMandate;
	/** Whether Exchain checks each purchase's agent against the registry. */
	registryGate: boolean;
	trustedPlaintextHosts?: string[];
	timeoutMs?: number;
}): Promise<{ walletId: string; mandateEnglish: string | null; alreadyRegistered: boolean }> {
	const { wallet } = params;
	const body = {
		walletAddress: wallet.scriptAddress,
		stateToken: `${wallet.policyId}.${wallet.stateTokenName}`,
		ownerKeyHash: resolvePaymentKeyHash(wallet.ownerAddress),
		agentKeyHashes: params.agentVkhs,
		quorumKeyHashes: wallet.quorumVkhs,
		quorumThreshold: wallet.threshold,
		escrowAddresses: params.escrowAddresses,
		governedAsset: { id: 'lovelace', decimals: 6 },
		constitution: { params: params.mandate },
		network: wallet.network,
		orgId: params.orgId,
		nodeId: params.nodeId,
		registryGate: params.registryGate,
	};
	let response: Response;
	try {
		response = await fetch(`${assertSafeCosignUrl(params.baseUrl, params.trustedPlaintextHosts)}/v1/wallets`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${params.token}` },
			body: JSON.stringify(body),
			// Never replay the node token to wherever a redirect points.
			redirect: 'error',
			signal: AbortSignal.timeout(params.timeoutMs ?? REGISTER_TIMEOUT_MS),
		});
	} catch (error) {
		throw new ExchainRegistrationError(
			`could not reach Exchain: ${error instanceof Error ? error.message : String(error)}`,
			null,
		);
	}
	const text = await response.text();
	if (response.status !== 200 && response.status !== 201) {
		throw new ExchainRegistrationError(
			`Exchain refused the registration: HTTP ${response.status} ${text.slice(0, 300)}`,
			response.status,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = null;
	}
	const reply = registrationReply.safeParse(parsed);
	if (!reply.success) throw new ExchainRegistrationError('Exchain returned an unexpected registration reply', 502);
	return {
		walletId: reply.data.walletId,
		mandateEnglish: reply.data.mandateEnglish ?? null,
		// Exchain answers 200 to a repeat of an existing registration and 201 to a new one.
		alreadyRegistered: response.status === 200,
	};
}
