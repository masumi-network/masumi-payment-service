import { config, requiredEnv } from './demo-config';
import { BlockFrostAPI, BlockfrostServerError } from '@blockfrost/blockfrost-js';
import { DEFAULTS } from '@masumi/payment-core/config';
import { BlockfrostProvider, MeshWallet, resolveTxHash, type UTxO } from '@meshsdk/core';
import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lovelaceFromUtxo } from '../../src/builders/batch-helpers';
import { getPaymentScriptV2 } from '../../src/contract-generator';
import { type CosignConfig } from './cosign-proposal-client';
import {
	fetchWalletUtxo,
	loadSmartWalletScript,
	type SmartWalletScript,
} from '../../src/smart-wallet/wallet-lifecycle';
import { startMockCosignServer } from './cosign-mock';

export const NETWORK = 'preprod' as const;
export const ADA = 1_000_000n;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(HERE, '.state');
export const STATE_FILE = path.join(STATE_DIR, 'demo-state.json');
export const EVENTS_FILE = path.join(STATE_DIR, 'events.ndjson');
export const DECISIONS_FILE = path.join(STATE_DIR, 'cosign-decisions.ndjson');
export const EVIDENCE_DIR = path.join(HERE, 'evidence');
const CONFIRM_TIMEOUT_MS = 15 * 60_000;
const POLL_MS = 10_000;
export const MOCK_MAX_VALIDITY_SLOTS = 900;
export const RESERVATION_TTL_SECONDS = 120;

export const blockfrostKey = requiredEnv('BLOCKFROST_API_KEY_PREPROD');

// ---------------------------------------------------------------- state

export type SyntheticPurchase = {
	blockchainIdentifier: string;
	inputHash: string;
	payByTime: string;
	resultTime: string;
	unlockTime: string;
	externalDisputeUnlockTime: string;
};

export type WalletRecord = {
	address: string;
	policyId: string;
	tokenName: string;
	seed: { txHash: string; outputIndex: number };
	mintTxHash: string;
	periodLimitLovelace?: string;
	status: 'submitted' | 'live' | 'retired';
	sweepTxHash?: string;
};

export type RunKind = 'deny' | 'allow-batched' | 'allow-single';

export type ChainTx = { feeLovelace: string; sizeBytes: number; blockTime: number; validContract: boolean };

export type RunRecord = {
	kind: RunKind;
	purchaseIndexes: number[];
	lockLovelace: string;
	paymentValueLovelace: string;
	txHash: string;
	unsignedBytes: number;
	walletInput: string;
	frozenAt: string;
	decision: 'approved' | 'denied';
	denialCode?: string;
	deniedLocks?: number[];
	timings: {
		buildMs: number;
		cosignRoundTripMs: number;
		freezeToDecisionMs: number;
		mergeAndSignMs?: number;
		freezeToSubmitMs?: number;
	};
	submitted: boolean;
	chain?: ChainTx;
};

export type DemoState = {
	version: 1;
	createdAt: string;
	ownerMnemonic?: string;
	agentMnemonic?: string;
	sellerMnemonic: string;
	memberMnemonics: string[];
	mockApiKey: string;
	quorumVkhs: string[];
	threshold: number;
	purchases: SyntheticPurchase[];
	wallet: WalletRecord | null;
	runs: RunRecord[];
};

export function loadState(): DemoState {
	if (!fs.existsSync(STATE_FILE)) {
		throw new Error(`No demo state at ${STATE_FILE}. Run the init command first.`);
	}
	return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as DemoState;
}

export function saveState(state: DemoState): void {
	fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
	const temp = `${STATE_FILE}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temp, STATE_FILE);
}

export function event(kind: string, details: Record<string, string | number | boolean | null>): void {
	fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
	fs.appendFileSync(EVENTS_FILE, `${JSON.stringify({ at: new Date().toISOString(), kind, ...details })}\n`, {
		mode: 0o600,
	});
}

export function log(message: string): void {
	console.log(`[smart-wallet-demo] ${new Date().toISOString().slice(11, 19)} ${message}`);
}

// ---------------------------------------------------------------- chain context

export const provider = new BlockfrostProvider(blockfrostKey);
export const blockfrost = new BlockFrostAPI({ projectId: blockfrostKey, network: NETWORK });
export const hex = (bytes: number) => randomBytes(bytes).toString('hex');
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const ada = (lovelace: bigint | string) => `${(Number(BigInt(lovelace)) / 1e6).toFixed(6)} tADA`;

export function brewMnemonic(): string {
	const words = MeshWallet.brew(false);
	if (!Array.isArray(words)) throw new Error('MeshWallet.brew did not return mnemonic words');
	return words.join(' ');
}

export function wallet(mnemonic: string): MeshWallet {
	return new MeshWallet({
		networkId: 0,
		fetcher: provider,
		submitter: provider,
		key: { type: 'mnemonic', words: mnemonic.split(' ') },
	});
}

export async function firstAddress(meshWallet: MeshWallet): Promise<string> {
	const [address] = await meshWallet.getUnusedAddresses();
	if (!address) throw new Error('wallet has no address');
	return address;
}

export function ownerMnemonic(state: DemoState): string {
	const mnemonic = process.env.SMART_WALLET_DEMO_OWNER_MNEMONIC?.trim() || state.ownerMnemonic;
	if (!mnemonic) throw new Error('No owner mnemonic in state or SMART_WALLET_DEMO_OWNER_MNEMONIC');
	return mnemonic;
}

export function agentMnemonic(state: DemoState): string {
	const mnemonic = process.env.SMART_WALLET_DEMO_AGENT_MNEMONIC?.trim() || state.agentMnemonic;
	if (!mnemonic) throw new Error('No agent mnemonic in state or SMART_WALLET_DEMO_AGENT_MNEMONIC');
	return mnemonic;
}

export async function escrowAddress(): Promise<string> {
	const { smartContractAddress } = await getPaymentScriptV2(
		[DEFAULTS.ADMIN_WALLET1_PREPROD, DEFAULTS.ADMIN_WALLET2_PREPROD, DEFAULTS.ADMIN_WALLET3_PREPROD],
		DEFAULTS.DEFAULT_ADMIN_SIGNATURES_V2,
		DEFAULTS.COOLDOWN_TIME_PREPROD,
		'Preprod',
	);
	if (smartContractAddress !== DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_V2_PREPROD) {
		throw new Error(
			`Derived V2 escrow address ${smartContractAddress} differs from the deployed default; refusing to lock`,
		);
	}
	return smartContractAddress;
}

export async function smartWallet(state: DemoState): Promise<SmartWalletScript> {
	return loadSmartWalletScript({
		ownerAddress: await firstAddress(wallet(ownerMnemonic(state))),
		quorumVkhs: state.quorumVkhs,
		threshold: state.threshold,
		network: NETWORK,
	});
}

function cosignConfig(state: DemoState, mockUrl: string | null): CosignConfig {
	if (config.cosignUrl == null) {
		if (mockUrl == null) throw new Error('mock co-signer is not running');
		return { url: mockUrl, apiKey: state.mockApiKey, timeoutMs: config.cosignTimeoutMs };
	}
	if (config.cosignApiKey == null) throw new Error('EXCHAIN_COSIGN_API_KEY is required with EXCHAIN_COSIGN_URL');
	if (config.cosignQuorumVkhs.join(',') !== state.quorumVkhs.join(',')) {
		throw new Error('EXCHAIN_COSIGN_QUORUM_VKHS differs from the quorum this wallet was minted with');
	}
	return {
		url: config.cosignUrl,
		apiKey: config.cosignApiKey,
		timeoutMs: config.cosignTimeoutMs,
		trustedPlaintextHosts: config.trustedPlaintextHosts,
	};
}

export async function withCosigner<T>(state: DemoState, work: (cosign: CosignConfig) => Promise<T>): Promise<T> {
	if (config.cosignUrl != null) return work(cosignConfig(state, null));
	if (state.memberMnemonics.length === 0) {
		throw new Error('this state was created for an external co-signer; set EXCHAIN_COSIGN_URL');
	}
	const mock = await startMockCosignServer({
		memberMnemonics: state.memberMnemonics,
		apiKey: state.mockApiKey,
		threshold: state.threshold,
		maxOutflowLovelace: config.mockCapLovelace,
		maxValiditySlots: MOCK_MAX_VALIDITY_SLOTS,
		resolveInputLovelace,
		decisionsFile: DECISIONS_FILE,
		port: 0,
	});
	try {
		return await work(cosignConfig(state, mock.url));
	} finally {
		await mock.close();
	}
}

export async function resolveInputLovelace(ref: { txHash: string; outputIndex: number }): Promise<bigint> {
	const utxos = await provider.fetchUTxOs(ref.txHash, ref.outputIndex);
	const utxo = utxos.find((candidate) => candidate.input.outputIndex === ref.outputIndex);
	if (utxo == null) throw new Error(`input ${ref.txHash}#${ref.outputIndex} not found`);
	return lovelaceFromUtxo(utxo);
}

async function lookupChainTx(txHash: string): Promise<ChainTx | null> {
	try {
		const tx = await blockfrost.txs(txHash);
		return { feeLovelace: tx.fees, sizeBytes: tx.size, blockTime: tx.block_time, validContract: tx.valid_contract };
	} catch (error) {
		if (error instanceof BlockfrostServerError && error.status_code === 404) return null;
		throw error;
	}
}

export async function waitForConfirmation(txHash: string, label: string): Promise<ChainTx> {
	const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const tx = await lookupChainTx(txHash);
		if (tx != null) return tx;
		log(`${label}: waiting for ${txHash.slice(0, 16)}… to confirm`);
		await sleep(POLL_MS);
	}
	throw new Error(`${label} ${txHash} did not confirm within ${CONFIRM_TIMEOUT_MS / 60_000} minutes`);
}

/**
 * Resolve every approved body whose outcome this state does not know, before
 * building anything new. A crash or an ambiguous submit must never lead to a
 * second lock of the same purchases. Every guarded body spends the current
 * wallet UTxO, so two bodies built on one wallet input can never both land.
 */
export async function reconcileApprovedRuns(state: DemoState): Promise<void> {
	const pending = state.runs.filter((run) => run.decision === 'approved' && run.chain == null);
	if (pending.length === 0) return;
	const script = await smartWallet(state);
	const current = await fetchWalletUtxo(provider, script, liveWallet(state).tokenName);
	const currentRef = `${current.input.txHash}#${current.input.outputIndex}`;
	for (const run of pending) {
		const landed =
			(await lookupChainTx(run.txHash)) ??
			(current.input.txHash === run.txHash ? await waitForConfirmation(run.txHash, `reconcile ${run.kind}`) : null);
		if (landed != null) {
			run.submitted = true;
			run.chain = landed;
			saveState(state);
			event('reconciled', { kind: run.kind, txHash: run.txHash });
			log(`${run.kind}: earlier body ${run.txHash.slice(0, 16)}… is on chain; recorded it`);
		} else if (currentRef === run.walletInput) {
			log(
				`${run.kind}: earlier body ${run.txHash.slice(0, 16)}… has not landed; a new body will compete for the same wallet input`,
			);
		}
	}
}

export async function waitForWalletAt(script: SmartWalletScript, tokenName: string, txHash: string): Promise<UTxO> {
	const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const utxo = await fetchWalletUtxo(provider, script, tokenName);
			if (utxo.input.txHash === txHash) return utxo;
		} catch (error) {
			log(`wallet lookup not ready: ${error instanceof Error ? error.message : String(error)}`);
		}
		await sleep(POLL_MS);
	}
	throw new Error(`wallet UTxO from ${txHash} did not appear within ${CONFIRM_TIMEOUT_MS / 60_000} minutes`);
}

export async function signAndSubmit(signer: MeshWallet, unsignedTx: string, expectedTxHash: string): Promise<void> {
	const signed = await signer.signTx(unsignedTx, true);
	if (resolveTxHash(signed) !== expectedTxHash) throw new Error('signing changed the transaction body');
	const submitted = await signer.submitTx(signed);
	if (submitted !== expectedTxHash) throw new Error(`node returned ${submitted}, expected ${expectedTxHash}`);
}

export function liveWallet(state: DemoState): WalletRecord {
	if (state.wallet?.status !== 'live') throw new Error('no live wallet; run the mint command first');
	return state.wallet;
}
