import { BlockfrostProvider, resolvePaymentKeyHash, type UTxO } from '@meshsdk/core';
import { z } from '@masumi/payment-core/zod';
import { assertSafeCosignUrl } from './cosign-client';
import { assetValueEntries, assetValueGet, lovelaceOf, type WalletDatum } from './wallet';
import { fetchWalletUtxo, loadSmartWalletScript, readWalletDatum, type SmartWalletScript } from './wallet-lifecycle';

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
	/** Every asset the wallet holds or limits, the state token excluded. `unit` is `lovelace` or `<policy><nameHex>`. */
	assets: GuardedWalletAsset[];
};

/** One asset of a guarded wallet. `limit` and `spentInPeriod` are null when the datum does not list it, so it is frozen. */
export type GuardedWalletAsset = {
	unit: string;
	quantity: bigint;
	limit: bigint | null;
	spentInPeriod: bigint | null;
};

/** Derive the wallet script and read its single state-token UTxO. Throws when it is not exactly one. */
export async function inspectGuardedWallet(
	params: GuardedWalletParams,
	rpcApiKey: string,
): Promise<GuardedWalletState> {
	const script = loadSmartWalletScript(params);
	const walletUtxo = await fetchWalletUtxo(new BlockfrostProvider(rpcApiKey), script, params.stateTokenName);
	return describeWalletUtxo(script, walletUtxo);
}

/** Read a wallet UTxO found anywhere (L1 or a head snapshot) into its guarded-wallet state. */
export function describeWalletUtxo(
	script: Pick<SmartWalletScript, 'address' | 'policyId'>,
	walletUtxo: UTxO,
): GuardedWalletState {
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
		assets: walletAssets(datum, walletUtxo, script.policyId),
	};
}

function walletAssets(datum: WalletDatum, walletUtxo: UTxO, stateTokenPolicyId: string): GuardedWalletAsset[] {
	const assets = new Map<string, GuardedWalletAsset>();
	const entry = (unit: string) => {
		const key = unit === '' ? 'lovelace' : unit;
		const existing = assets.get(key) ?? { unit: key, quantity: 0n, limit: null, spentInPeriod: null };
		assets.set(key, existing);
		return existing;
	};
	// Limits first, so the list keeps the datum's order and held-but-unlisted assets follow.
	for (const { policyId, assetName, quantity } of assetValueEntries(datum.limit)) {
		const asset = entry(`${policyId}${assetName}`);
		asset.limit = quantity;
		asset.spentInPeriod = assetValueGet(datum.spentInPeriod, policyId, assetName) ?? 0n;
	}
	for (const { unit, quantity } of walletUtxo.output.amount) {
		if (unit.startsWith(stateTokenPolicyId)) continue;
		entry(unit).quantity += BigInt(quantity);
	}
	return [...assets.values()];
}

/** The mandate Exchain enforces, in minor units of the governed asset. It cannot change once registered. */
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
	/** Exchain `AssetId` the mandate is counted in: `lovelace` or `<policy>.<nameHex>`. */
	governedAsset: string;
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
		// Exchain accepts only 6-decimal assets; ADA, USDM and USDCx all are.
		governedAsset: { id: params.governedAsset, decimals: 6 },
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
