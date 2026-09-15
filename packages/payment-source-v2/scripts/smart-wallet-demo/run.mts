/**
 * MAS-596 demo: one preprod guarded smart wallet locking escrow funds through
 * `POST /v1/cosign`, one deny and allows measured batched vs single-item.
 *
 * Run from the repository root, so the root tsconfig paths and `.env` apply:
 *
 *   pnpm exec tsx packages/payment-source-v2/scripts/smart-wallet-demo/run.mts <command>
 *
 *   init           create demo keys, synthetic purchases and state; print what to fund
 *   mint           mint the state token and fund the wallet from the owner key
 *   deny           build a lock above the co-sign policy cap; expect a 409; submit nothing
 *   allow-batched  lock the synthetic purchases in one guarded transaction
 *   allow-single   lock the same purchases one guarded transaction each
 *   report         read fees from chain; write evidence/<ISO>/result.json and SUMMARY.md
 *   mock           serve the mock co-signer and its decision page on SMART_WALLET_DEMO_MOCK_PORT
 *   sweep          owner sweeps the wallet and burns the state token
 *   all            mint (if needed), deny, allow-batched, allow-single, report
 *
 * With EXCHAIN_COSIGN_URL unset, every command talks to an in-process mock.
 * Preprod only. Synthetic locks stay in escrow; they are test tADA, not reclaimed here.
 */
import 'dotenv/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { BlockFrostAPI, BlockfrostServerError } from '@blockfrost/blockfrost-js';
import {
	BlockfrostProvider,
	MeshTxBuilder,
	MeshWallet,
	resolvePaymentKeyHash,
	resolveTxHash,
	SLOT_CONFIG_NETWORK,
	slotToBeginUnixTime,
	type UTxO,
} from '@meshsdk/core';
import { generateBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import { SmartContractState } from '@masumi/payment-core/smart-contract-state';
import { DEFAULTS } from '@masumi/payment-core/config';
import { calculateMinUtxo } from '@/utils/min-utxo';
import { lovelaceFromUtxo } from '../../src/builders/batch-helpers';
import { getPaymentScriptV2 } from '../../src/contract-generator';
import { createDatumFromBlockchainIdentifierV2 } from '../../src/datum-builder';
import {
	CosignTransportError,
	mergeCosignWitnesses,
	requestCosign,
	type CosignConfig,
	type CosignRequest,
} from '../../src/smart-wallet/cosign-client';
import {
	buildGuardedLockTx,
	GuardedTxTooLargeError,
	loadV2ProtocolParameters,
	type GuardedLockBuild,
} from '../../src/smart-wallet/guarded-lock-builder';
import {
	buildMintWalletTx,
	buildOwnerSweepTx,
	fetchWalletUtxo,
	loadSmartWalletScript,
	readWalletDatum,
	type SmartWalletScript,
} from '../../src/smart-wallet/wallet-lifecycle';
import { assetValueData } from '../../src/smart-wallet/wallet';
import { memberVkhOf, startMockCosignServer } from './cosign-mock';

const NETWORK = 'preprod' as const;
const ADA = 1_000_000n;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(HERE, '.state');
const STATE_FILE = path.join(STATE_DIR, 'demo-state.json');
const EVENTS_FILE = path.join(STATE_DIR, 'events.ndjson');
const DECISIONS_FILE = path.join(STATE_DIR, 'cosign-decisions.ndjson');
const EVIDENCE_DIR = path.join(HERE, 'evidence');
const CONFIRM_TIMEOUT_MS = 15 * 60_000;
const POLL_MS = 10_000;
const MOCK_MAX_VALIDITY_SLOTS = 900;
const RESERVATION_TTL_SECONDS = 120;
const COSIGN_TIMEOUT_MS = 10_000;

// Datum policy the owner sets at mint (MAS-596 P0 item 2: per wallet, operator-chosen).
const WALLET_LIMIT_LOVELACE = 200n * ADA;
const WALLET_PERIOD_MS = 24n * 60n * 60n * 1000n;
const WALLET_MIN_BALANCE_LOVELACE = 5n * ADA;
const AGENT_COLLATERAL_SPLIT_LOVELACE = 10n * ADA;

// ---------------------------------------------------------------- config

function intEnv(name: string, fallback: number, min: number, max: number): number {
	const raw = process.env[name]?.trim();
	const value = raw == null || raw === '' ? fallback : Number(raw);
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new Error(`${name} must be an integer between ${min} and ${max}`);
	}
	return value;
}

function lovelaceEnv(name: string, fallback: bigint): bigint {
	const raw = process.env[name]?.trim();
	if (raw == null || raw === '') return fallback;
	if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a lovelace integer`);
	return BigInt(raw);
}

function listEnv(name: string): string[] {
	return (process.env[name] ?? '')
		.split(',')
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean);
}

function requiredEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

const blockfrostKey = requiredEnv('BLOCKFROST_API_KEY_PREPROD');

const config = {
	purchases: intEnv('SMART_WALLET_DEMO_N', 10, 1, 10),
	threshold: intEnv('SMART_WALLET_DEMO_QUORUM_THRESHOLD', 2, 1, 16),
	mockPort: intEnv('SMART_WALLET_DEMO_MOCK_PORT', 4600, 1, 65_535),
	lockLovelace: lovelaceEnv('SMART_WALLET_DEMO_LOCK_LOVELACE', 6n * ADA),
	denyLockLovelace: lovelaceEnv('SMART_WALLET_DEMO_DENY_LOCK_LOVELACE', 8n * ADA),
	mockCapLovelace: lovelaceEnv('SMART_WALLET_DEMO_MOCK_CAP_LOVELACE', 70n * ADA),
	fundLovelace: lovelaceEnv('SMART_WALLET_DEMO_FUND_LOVELACE', 150n * ADA),
	cosignUrl: process.env.EXCHAIN_COSIGN_URL?.trim() || null,
	cosignApiKey: process.env.EXCHAIN_COSIGN_API_KEY?.trim() || null,
	cosignQuorumVkhs: listEnv('EXCHAIN_COSIGN_QUORUM_VKHS'),
	cosignTimeoutMs: intEnv('EXCHAIN_COSIGN_TIMEOUT_MS', COSIGN_TIMEOUT_MS, 100, 120_000),
	trustedPlaintextHosts: listEnv('EXCHAIN_COSIGN_TRUSTED_PLAINTEXT_HOSTS'),
};

// ---------------------------------------------------------------- state

type SyntheticPurchase = {
	blockchainIdentifier: string;
	inputHash: string;
	payByTime: string;
	resultTime: string;
	unlockTime: string;
	externalDisputeUnlockTime: string;
};

type WalletRecord = {
	address: string;
	policyId: string;
	tokenName: string;
	seed: { txHash: string; outputIndex: number };
	mintTxHash: string;
	status: 'submitted' | 'live' | 'retired';
	sweepTxHash?: string;
};

type RunKind = 'deny' | 'allow-batched' | 'allow-single';

type ChainTx = { feeLovelace: string; sizeBytes: number; blockTime: number; validContract: boolean };

type RunRecord = {
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

type DemoState = {
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

function loadState(): DemoState {
	if (!fs.existsSync(STATE_FILE)) {
		throw new Error(`No demo state at ${STATE_FILE}. Run the init command first.`);
	}
	return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as DemoState;
}

function saveState(state: DemoState): void {
	fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
	const temp = `${STATE_FILE}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temp, STATE_FILE);
}

function event(kind: string, details: Record<string, string | number | boolean | null>): void {
	fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
	fs.appendFileSync(EVENTS_FILE, `${JSON.stringify({ at: new Date().toISOString(), kind, ...details })}\n`, {
		mode: 0o600,
	});
}

function log(message: string): void {
	console.log(`[smart-wallet-demo] ${new Date().toISOString().slice(11, 19)} ${message}`);
}

// ---------------------------------------------------------------- chain context

const provider = new BlockfrostProvider(blockfrostKey);
const blockfrost = new BlockFrostAPI({ projectId: blockfrostKey, network: NETWORK });
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ada = (lovelace: bigint | string) => `${(Number(BigInt(lovelace)) / 1e6).toFixed(6)} tADA`;

function brewMnemonic(): string {
	const words = MeshWallet.brew(false);
	if (!Array.isArray(words)) throw new Error('MeshWallet.brew did not return mnemonic words');
	return words.join(' ');
}

function wallet(mnemonic: string): MeshWallet {
	return new MeshWallet({
		networkId: 0,
		fetcher: provider,
		submitter: provider,
		key: { type: 'mnemonic', words: mnemonic.split(' ') },
	});
}

async function firstAddress(meshWallet: MeshWallet): Promise<string> {
	const [address] = await meshWallet.getUnusedAddresses();
	if (!address) throw new Error('wallet has no address');
	return address;
}

function ownerMnemonic(state: DemoState): string {
	const mnemonic = process.env.SMART_WALLET_DEMO_OWNER_MNEMONIC?.trim() || state.ownerMnemonic;
	if (!mnemonic) throw new Error('No owner mnemonic in state or SMART_WALLET_DEMO_OWNER_MNEMONIC');
	return mnemonic;
}

function agentMnemonic(state: DemoState): string {
	const mnemonic = process.env.SMART_WALLET_DEMO_AGENT_MNEMONIC?.trim() || state.agentMnemonic;
	if (!mnemonic) throw new Error('No agent mnemonic in state or SMART_WALLET_DEMO_AGENT_MNEMONIC');
	return mnemonic;
}

async function escrowAddress(): Promise<string> {
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

async function smartWallet(state: DemoState): Promise<SmartWalletScript> {
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

async function withCosigner<T>(state: DemoState, work: (cosign: CosignConfig) => Promise<T>): Promise<T> {
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

async function resolveInputLovelace(ref: { txHash: string; outputIndex: number }): Promise<bigint> {
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

async function waitForConfirmation(txHash: string, label: string): Promise<ChainTx> {
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
async function reconcileApprovedRuns(state: DemoState): Promise<void> {
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

async function waitForWalletAt(script: SmartWalletScript, tokenName: string, txHash: string): Promise<UTxO> {
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

async function signAndSubmit(signer: MeshWallet, unsignedTx: string, expectedTxHash: string): Promise<void> {
	const signed = await signer.signTx(unsignedTx, true);
	if (resolveTxHash(signed) !== expectedTxHash) throw new Error('signing changed the transaction body');
	const submitted = await signer.submitTx(signed);
	if (submitted !== expectedTxHash) throw new Error(`node returned ${submitted}, expected ${expectedTxHash}`);
}

// ---------------------------------------------------------------- commands

async function init(): Promise<void> {
	if (fs.existsSync(STATE_FILE)) {
		log(`state exists at ${STATE_FILE}; showing it`);
		await printFunding(loadState());
		return;
	}
	const externalCosigner = config.cosignUrl != null;
	if (externalCosigner && config.cosignQuorumVkhs.length === 0) {
		throw new Error(
			'EXCHAIN_COSIGN_QUORUM_VKHS is required when EXCHAIN_COSIGN_URL is set; the quorum is fixed at mint',
		);
	}
	const memberMnemonics = externalCosigner ? [] : [0, 1, 2].map(() => brewMnemonic());
	const quorumVkhs = externalCosigner
		? config.cosignQuorumVkhs
		: await Promise.all(memberMnemonics.map((mnemonic) => memberVkhOf(mnemonic)));

	const sellerMnemonic = brewMnemonic();
	const seller = wallet(sellerMnemonic);
	const sellerAddress = await firstAddress(seller);
	const escrow = await escrowAddress();
	const now = BigInt(Date.now());
	const hour = 60n * 60n * 1000n;
	const purchases: SyntheticPurchase[] = [];
	// Built like POST /payment does, so datum sizes match real purchases.
	for (let i = 0; i < config.purchases; i++) {
		const agentIdentifier = hex(28) + hex(28);
		const sellerId = sha256(randomUUID()) + agentIdentifier;
		const signed = await seller.signData(sha256(randomUUID()), sellerAddress);
		purchases.push({
			blockchainIdentifier: generateBlockchainIdentifier(signed.key, signed.signature, sellerId, hex(13), escrow),
			inputHash: sha256(randomUUID()),
			payByTime: String(now + 2n * hour),
			resultTime: String(now + 6n * hour),
			unlockTime: String(now + 12n * hour),
			externalDisputeUnlockTime: String(now + 24n * hour),
		});
	}

	const state: DemoState = {
		version: 1,
		createdAt: new Date().toISOString(),
		ownerMnemonic: process.env.SMART_WALLET_DEMO_OWNER_MNEMONIC?.trim() ? undefined : brewMnemonic(),
		agentMnemonic: process.env.SMART_WALLET_DEMO_AGENT_MNEMONIC?.trim() ? undefined : brewMnemonic(),
		sellerMnemonic,
		memberMnemonics,
		mockApiKey: hex(32),
		quorumVkhs,
		threshold: config.threshold,
		purchases,
		wallet: null,
		runs: [],
	};
	saveState(state);
	event('init', { purchases: purchases.length, externalCosigner, threshold: config.threshold });
	await printFunding(state);
}

async function printFunding(state: DemoState): Promise<void> {
	const owner = await firstAddress(wallet(ownerMnemonic(state)));
	const agent = await firstAddress(wallet(agentMnemonic(state)));
	const script = await smartWallet(state);
	log(`owner  (cold key, mints and sweeps):   ${owner}`);
	log(`agent  (hot key, pays fees + collateral): ${agent}`);
	log(`wallet (script, derived from params):  ${script.address}`);
	log(`quorum: ${state.threshold} of ${state.quorumVkhs.length} — ${state.quorumVkhs.join(', ')}`);
	log(
		`fund the owner with at least ${ada(config.fundLovelace + 15n * ADA)} and the agent with at least ${ada(30n * ADA)}`,
	);
	log('preprod faucet: https://docs.cardano.org/cardano-testnets/tools/faucet');
}

async function ensureAgentCollateral(agent: MeshWallet): Promise<void> {
	const utxos = await agent.getUtxos();
	const total = utxos.reduce((sum, utxo) => sum + lovelaceFromUtxo(utxo), 0n);
	if (total < 15n * ADA) {
		throw new Error(`agent holds ${ada(total)}; fund it with at least 30 tADA first`);
	}
	// ADR 0007 readiness shape: a >= 5 ADA collateral candidate plus a separate fee input.
	if (utxos.length >= 2 && utxos.some((utxo) => lovelaceFromUtxo(utxo) >= 5n * ADA)) return;
	const agentAddress = await firstAddress(agent);
	const protocolParameters = await loadV2ProtocolParameters(provider, blockfrostKey);
	const txBuilder = new MeshTxBuilder({ fetcher: provider });
	txBuilder.protocolParams(protocolParameters);
	const unsignedTx = await txBuilder
		.txOut(agentAddress, [{ unit: 'lovelace', quantity: AGENT_COLLATERAL_SPLIT_LOVELACE.toString() }])
		.changeAddress(agentAddress)
		.selectUtxosFrom(utxos)
		.setNetwork(NETWORK)
		.complete();
	const txHash = resolveTxHash(unsignedTx);
	log(`agent has one UTxO; splitting out a collateral reserve (${txHash})`);
	await signAndSubmit(agent, unsignedTx, txHash);
	await waitForConfirmation(txHash, 'agent collateral split');
}

async function mint(): Promise<void> {
	const state = loadState();
	if (state.wallet?.status === 'live') {
		log(`wallet already live at ${state.wallet.address}`);
		return;
	}
	if (state.wallet?.status === 'submitted') {
		await confirmMint(state);
		return;
	}
	if (state.wallet?.status === 'retired') {
		throw new Error('this demo wallet was retired; delete the .state directory to start over');
	}
	const owner = wallet(ownerMnemonic(state));
	const agent = wallet(agentMnemonic(state));
	const ownerAddress = await firstAddress(owner);
	const ownerTotal = (await owner.getUtxos()).reduce((sum, utxo) => sum + lovelaceFromUtxo(utxo), 0n);
	if (ownerTotal < config.fundLovelace + 10n * ADA) {
		throw new Error(`owner holds ${ada(ownerTotal)}; fund it with at least ${ada(config.fundLovelace + 15n * ADA)}`);
	}
	await ensureAgentCollateral(agent);
	const ownerUtxos = await owner.getUtxos();
	const script = await smartWallet(state);
	const agentVkh = resolvePaymentKeyHash(await firstAddress(agent));
	const built = await buildMintWalletTx({
		provider,
		rpcApiKey: blockfrostKey,
		network: NETWORK,
		wallet: script,
		ownerAddress,
		ownerUtxos,
		fundLovelace: config.fundLovelace,
		datum: {
			agent: agentVkh,
			limit: assetValueData([{ unit: 'lovelace', quantity: WALLET_LIMIT_LOVELACE.toString() }]),
			periodLength: WALLET_PERIOD_MS,
			periodStart: BigInt(Date.now()),
			spentInPeriod: assetValueData([{ unit: 'lovelace', quantity: '0' }]),
			minBalanceLovelace: WALLET_MIN_BALANCE_LOVELACE,
		},
	});
	// Persist the seed BEFORE submitting: the token name is the wallet's identity.
	state.wallet = {
		address: script.address,
		policyId: script.policyId,
		tokenName: built.tokenName,
		seed: built.seed,
		mintTxHash: built.txHash,
		status: 'submitted',
	};
	saveState(state);
	try {
		await signAndSubmit(owner, built.unsignedTx, built.txHash);
	} catch (error) {
		state.wallet = null;
		saveState(state);
		throw error;
	}
	event('mint-submitted', { txHash: built.txHash, address: script.address });
	log(`mint submitted ${built.txHash}`);
	await confirmMint(state);
}

async function confirmMint(state: DemoState): Promise<void> {
	if (state.wallet == null) throw new Error('no minted wallet in state');
	const script = await smartWallet(state);
	await waitForConfirmation(state.wallet.mintTxHash, 'mint');
	const utxo = await waitForWalletAt(script, state.wallet.tokenName, state.wallet.mintTxHash);
	const datum = readWalletDatum(utxo);
	state.wallet.status = 'live';
	saveState(state);
	event('mint-confirmed', { txHash: state.wallet.mintTxHash });
	log(`wallet live at ${script.address} with ${ada(lovelaceFromUtxo(utxo))}; agent ${datum.agent}`);
}

function liveWallet(state: DemoState): WalletRecord {
	if (state.wallet?.status !== 'live') throw new Error('no live wallet; run the mint command first');
	return state.wallet;
}

async function guardedLock(
	state: DemoState,
	cosign: CosignConfig,
	kind: RunKind,
	purchaseIndexes: number[],
	lockLovelace: bigint,
): Promise<RunRecord> {
	const record = liveWallet(state);
	const script = await smartWallet(state);
	const agent = wallet(agentMnemonic(state));
	const agentAddress = await firstAddress(agent);
	const sellerAddress = await firstAddress(wallet(state.sellerMnemonic));
	const escrow = await escrowAddress();
	const protocolParameters = await provider.fetchProtocolParameters();
	const cosignerVkhs = state.quorumVkhs.slice(0, state.threshold);

	let indexes = purchaseIndexes;
	for (;;) {
		const walletUtxo = await fetchWalletUtxo(provider, script, record.tokenName);
		const walletDatum = readWalletDatum(walletUtxo);
		const agentUtxos = await agent.getUtxos();
		const locks = indexes.map((index) => {
			const purchase = state.purchases[index];
			const datum = createDatumFromBlockchainIdentifierV2({
				buyerAddress: agentAddress,
				buyerReturnAddress: agentAddress,
				sellerAddress,
				sellerReturnAddress: null,
				blockchainIdentifier: purchase.blockchainIdentifier,
				collateralReturnLovelace: 0n,
				inputHash: purchase.inputHash,
				resultHash: null,
				payByTime: BigInt(purchase.payByTime),
				resultTime: BigInt(purchase.resultTime),
				unlockTime: BigInt(purchase.unlockTime),
				externalDisputeUnlockTime: BigInt(purchase.externalDisputeUnlockTime),
				newCooldownTimeSeller: 0n,
				newCooldownTimeBuyer: 0n,
				state: SmartContractState.FundsLocked,
			});
			const { minUtxoLovelace } = calculateMinUtxo({
				datum: datum.value,
				nativeTokenCount: 0,
				coinsPerUtxoSize: protocolParameters.coinsPerUtxoSize,
				includeBuffers: true,
			});
			if (lockLovelace < minUtxoLovelace) {
				throw new Error(`lock of ${ada(lockLovelace)} is below the ${ada(minUtxoLovelace)} min-UTxO for this datum`);
			}
			return { address: escrow, amount: [{ unit: 'lovelace', quantity: lockLovelace.toString() }], datum: datum.value };
		});

		const tBuild0 = performance.now();
		let built: GuardedLockBuild;
		try {
			built = await buildGuardedLockTx({
				provider,
				rpcApiKey: blockfrostKey,
				network: NETWORK,
				wallet: { scriptCode: script.scriptCode, address: script.address },
				walletUtxo,
				walletDatum,
				agentAddress,
				agentUtxos,
				cosignerVkhs,
				locks,
			});
		} catch (error) {
			if (error instanceof GuardedTxTooLargeError && indexes.length > 1) {
				event('shrink', { kind, from: indexes.length, sizeBytes: error.sizeBytes });
				log(`${kind}: ${indexes.length} locks is ${error.sizeBytes} bytes; shrinking by one`);
				indexes = indexes.slice(0, -1);
				continue;
			}
			throw error;
		}
		const tFreeze = performance.now();
		const frozenAt = new Date().toISOString();
		event('frozen', { kind, txHash: built.txHash, locks: indexes.length, unsignedBytes: built.unsignedBytes });

		const request: CosignRequest = {
			version: 1,
			network: NETWORK,
			txCbor: built.unsignedTx,
			txHash: built.txHash,
			wallet: {
				address: script.address,
				stateTokenUnit: `${script.policyId}${record.tokenName}`,
				input: walletUtxo.input,
			},
			requiredSigners: cosignerVkhs,
			intent: {
				kind: 'escrow-lock',
				buyerAddress: agentAddress,
				// Must match the datum built above field for field; the co-signer decodes and compares.
				locks: indexes.map((index) => ({
					address: escrow,
					lovelace: lockLovelace.toString(),
					blockchainIdentifier: state.purchases[index].blockchainIdentifier,
					sellerAddress,
					buyerReturnAddress: agentAddress,
					sellerReturnAddress: null,
				})),
				outflowLovelace: built.outflowLovelace.toString(),
				changeAddress: agentAddress,
				validity: built.validity,
				requestedBy: 'masumi-payment-service/smart-wallet-demo',
			},
			reservationTtlSeconds: RESERVATION_TTL_SECONDS,
		};
		const tCosign0 = performance.now();
		const decision = await requestCosign(cosign, request);
		const tCosign1 = performance.now();
		const paymentValue = lockLovelace * BigInt(indexes.length);
		const run: RunRecord = {
			kind,
			purchaseIndexes: indexes,
			lockLovelace: lockLovelace.toString(),
			paymentValueLovelace: paymentValue.toString(),
			txHash: built.txHash,
			unsignedBytes: built.unsignedBytes,
			walletInput: `${walletUtxo.input.txHash}#${walletUtxo.input.outputIndex}`,
			frozenAt,
			decision: decision.httpStatus === 200 ? 'approved' : 'denied',
			timings: {
				buildMs: Math.round(tFreeze - tBuild0),
				cosignRoundTripMs: Math.round(tCosign1 - tCosign0),
				freezeToDecisionMs: Math.round(tCosign1 - tFreeze),
			},
			submitted: false,
		};

		if (decision.httpStatus === 409) {
			run.denialCode = decision.denied.code;
			run.deniedLocks = decision.denied.locks.filter((lock) => lock.verdict === 'denied').map((lock) => lock.index);
			state.runs.push(run);
			saveState(state);
			event('denied', { kind, txHash: built.txHash, code: decision.denied.code, message: decision.denied.message });
			log(
				`${kind}: co-signer DENIED ${built.txHash.slice(0, 16)}… — ${decision.denied.code}: ${decision.denied.message}`,
			);
			return run;
		}
		if (kind === 'deny') {
			state.runs.push(run);
			saveState(state);
			throw new Error('the deny scenario was APPROVED by the co-signer; nothing was submitted, check the policy cap');
		}

		const merged = mergeCosignWitnesses(
			built.unsignedTx,
			{ txHash: built.txHash, signerVkhs: cosignerVkhs },
			decision.approved.signatures,
		);
		const signed = await agent.signTx(merged, true);
		if (resolveTxHash(signed) !== built.txHash) throw new Error('agent signature changed the frozen body');
		const tSigned = performance.now();
		state.runs.push(run);
		saveState(state);
		const submitted = await agent.submitTx(signed);
		const tSubmit = performance.now();
		if (submitted !== built.txHash) throw new Error(`node returned ${submitted}, expected ${built.txHash}`);
		run.submitted = true;
		run.timings.mergeAndSignMs = Math.round(tSigned - tCosign1);
		run.timings.freezeToSubmitMs = Math.round(tSubmit - tFreeze);
		saveState(state);
		event('submitted', { kind, txHash: built.txHash, freezeToSubmitMs: run.timings.freezeToSubmitMs });
		log(
			`${kind}: submitted ${built.txHash} — ${indexes.length} lock(s), ${built.unsignedBytes} B unsigned, freeze→submit ${run.timings.freezeToSubmitMs} ms`,
		);

		run.chain = await waitForConfirmation(built.txHash, kind);
		saveState(state);
		await waitForWalletAt(script, record.tokenName, built.txHash);
		event('confirmed', {
			kind,
			txHash: built.txHash,
			feeLovelace: run.chain.feeLovelace,
			sizeBytes: run.chain.sizeBytes,
		});
		log(`${kind}: confirmed, fee ${ada(run.chain.feeLovelace)}, ${run.chain.sizeBytes} B`);
		return run;
	}
}

function allIndexes(state: DemoState): number[] {
	return state.purchases.map((_, index) => index);
}

async function deny(state: DemoState): Promise<void> {
	const total = config.denyLockLovelace * BigInt(state.purchases.length);
	if (config.cosignUrl == null && total <= config.mockCapLovelace) {
		throw new Error('deny total must exceed SMART_WALLET_DEMO_MOCK_CAP_LOVELACE, or the mock will approve it');
	}
	await withCosigner(state, async (cosign) => {
		const run = await guardedLock(state, cosign, 'deny', allIndexes(state), config.denyLockLovelace);
		if (run.decision !== 'denied') throw new Error('expected a denial');
	});
}

async function allowBatched(state: DemoState): Promise<void> {
	await reconcileApprovedRuns(state);
	if (state.runs.some((run) => run.kind === 'allow-batched' && run.submitted)) {
		log('allow-batched already submitted; skipping');
		return;
	}
	await withCosigner(state, async (cosign) => {
		const run = await guardedLock(state, cosign, 'allow-batched', allIndexes(state), config.lockLovelace);
		if (run.decision !== 'approved') throw new Error(`batched lock was denied: ${run.denialCode}`);
	});
}

async function allowSingle(state: DemoState): Promise<void> {
	await reconcileApprovedRuns(state);
	const batched = state.runs.find((run) => run.kind === 'allow-batched' && run.submitted);
	if (batched == null) throw new Error('run allow-batched first; single-item locks reuse exactly its purchases');
	const lockLovelace = BigInt(batched.lockLovelace);
	await withCosigner(state, async (cosign) => {
		for (const index of batched.purchaseIndexes) {
			if (state.runs.some((run) => run.kind === 'allow-single' && run.submitted && run.purchaseIndexes[0] === index)) {
				continue;
			}
			const run = await guardedLock(state, cosign, 'allow-single', [index], lockLovelace);
			if (run.decision !== 'approved') throw new Error(`single lock ${index} was denied: ${run.denialCode}`);
		}
	});
}

function stats(values: number[]): { n: number; min: number; median: number; max: number } | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return {
		n: sorted.length,
		min: sorted[0],
		median: sorted[Math.floor(sorted.length / 2)],
		max: sorted[sorted.length - 1],
	};
}

function ratio(numerator: bigint, denominator: bigint): string {
	return denominator === 0n ? 'n/a' : (Number(numerator) / Number(denominator)).toFixed(6);
}

type ChainDetail = {
	invalidHereafterMs: number | null;
	scriptFeeLovelace: bigint;
	unitMem: bigint;
	unitSteps: bigint;
};

/** On-chain facts the report needs beyond ChainTx: the script fee Blockfrost records per redeemer, and the validity end. */
async function chainDetail(txHash: string): Promise<ChainDetail> {
	const [tx, redeemers] = await Promise.all([blockfrost.txs(txHash), blockfrost.txsRedeemers(txHash)]);
	const slot = tx.invalid_hereafter == null ? null : Number(tx.invalid_hereafter);
	return {
		invalidHereafterMs: slot == null ? null : slotToBeginUnixTime(slot, SLOT_CONFIG_NETWORK[NETWORK]),
		scriptFeeLovelace: redeemers.reduce((sum, redeemer) => sum + BigInt(redeemer.fee), 0n),
		unitMem: redeemers.reduce((sum, redeemer) => sum + BigInt(redeemer.unit_mem), 0n),
		unitSteps: redeemers.reduce((sum, redeemer) => sum + BigInt(redeemer.unit_steps), 0n),
	};
}

async function report(state: DemoState): Promise<void> {
	if (state.wallet?.status === 'live') await reconcileApprovedRuns(state);
	const batched = state.runs.find((run) => run.kind === 'allow-batched' && run.submitted && run.chain);
	const singles = state.runs.filter((run) => run.kind === 'allow-single' && run.submitted && run.chain);
	const denials = state.runs.filter((run) => run.decision === 'denied');
	if (batched?.chain == null) throw new Error('no confirmed allow-batched run to report');
	const sameSet = batched.purchaseIndexes.every((index) => singles.some((run) => run.purchaseIndexes[0] === index));
	if (!sameSet || singles.length !== batched.purchaseIndexes.length) {
		throw new Error('allow-single has not locked every purchase of the batched run yet');
	}
	const allowRuns = [batched, ...singles];
	const chainOf = (run: RunRecord): ChainTx => {
		if (run.chain == null) throw new Error(`run ${run.txHash} has no chain record`);
		return run.chain;
	};
	const failed = allowRuns.filter((run) => !chainOf(run).validContract);
	if (failed.length > 0) {
		throw new Error(`phase-2 failure recorded for ${failed.map((run) => run.txHash).join(', ')}`);
	}
	const details = new Map<string, ChainDetail>();
	for (const run of allowRuns) details.set(run.txHash, await chainDetail(run.txHash));
	const detailOf = (run: RunRecord): ChainDetail => {
		const detail = details.get(run.txHash);
		if (detail == null) throw new Error(`missing chain detail for ${run.txHash}`);
		return detail;
	};

	const paymentValue = BigInt(batched.paymentValueLovelace);
	const lockCount = BigInt(batched.purchaseIndexes.length);
	const feeSide = (runs: RunRecord[]) => {
		const fee = runs.reduce((sum, run) => sum + BigInt(chainOf(run).feeLovelace), 0n);
		const scriptFee = runs.reduce((sum, run) => sum + detailOf(run).scriptFeeLovelace, 0n);
		return {
			txs: runs.length,
			locks: runs.reduce((sum, run) => sum + run.purchaseIndexes.length, 0),
			txHashes: runs.map((run) => run.txHash),
			paymentValueLovelace: paymentValue.toString(),
			feeLovelace: fee.toString(),
			scriptFeeLovelace: scriptFee.toString(),
			sizeFeeLovelace: (fee - scriptFee).toString(),
			feePerLockLovelace: (fee / lockCount).toString(),
			feeToPaymentValue: ratio(fee, paymentValue),
			scriptFeeToPaymentValue: ratio(scriptFee, paymentValue),
			sizeBytes: runs.map((run) => chainOf(run).sizeBytes),
			exUnits: runs.map((run) => ({
				mem: detailOf(run).unitMem.toString(),
				steps: detailOf(run).unitSteps.toString(),
			})),
		};
	};
	const batchedFees = feeSide([batched]);
	const singleFees = feeSide(singles);

	// Runs recovered by reconcile after a crash have no in-process timings; leave them out rather than count zero.
	const timing = (pick: (run: RunRecord) => number | undefined) =>
		stats(
			allowRuns.flatMap((run) => {
				const value = pick(run);
				return value == null || run.timings.freezeToSubmitMs == null ? [] : [value];
			}),
		);

	const blockMs = (run: RunRecord) => chainOf(run).blockTime * 1000;
	const windowStart = Math.min(...state.runs.map((run) => Date.parse(run.frozenAt)));
	const windowEnd = Math.max(...allowRuns.map(blockMs));
	const windowMinutes = (windowEnd - windowStart) / 60_000;
	const locksSubmitted = allowRuns.reduce((sum, run) => sum + run.purchaseIndexes.length, 0);
	const singleStart = Math.min(...singles.map((run) => Date.parse(run.frozenAt)));
	const singleEnd = Math.max(...singles.map(blockMs));
	const singleMinutes = (singleEnd - singleStart) / 60_000;
	const singleBlocks = singles.map(blockMs).sort((a, b) => a - b);
	const secondsBetweenSingleConfirmations = singleBlocks.slice(1).map((ms, index) => (ms - singleBlocks[index]) / 1000);
	const overallRate = +(locksSubmitted / windowMinutes).toFixed(3);
	const singleRate = +(singles.length / singleMinutes).toFixed(3);

	const result = {
		ticket: 'MAS-596',
		generatedAt: new Date().toISOString(),
		network: NETWORK,
		cosigner:
			config.cosignUrl == null
				? 'in-process mock (scripts/smart-wallet-demo/cosign-mock.ts)'
				: new URL(config.cosignUrl).origin,
		wallet: { ...state.wallet, quorum: `${state.threshold} of ${state.quorumVkhs.length}` },
		fees: {
			method:
				'Blockfrost after confirmation: txs(hash).fees for the fee, txs(hash)/redeemers fee for the script part; size fee = fee − script fee. Never the builder estimate.',
			batched: batchedFees,
			single: singleFees,
			singleOverBatched: ratio(BigInt(singleFees.feeLovelace), BigInt(batchedFees.feeLovelace)),
		},
		latency: {
			method:
				'performance.now(): freeze = second-pass complete() returned; submit = submitTx returned. freezeToValidityEnd uses the on-chain invalid_hereafter slot.',
			cosigner: 'Round trips are to the local mock, including its Blockfrost lookup of the wallet input.',
			freezeToSubmitMs: timing((run) => run.timings.freezeToSubmitMs),
			cosignRoundTripMs: timing((run) => run.timings.cosignRoundTripMs),
			mergeAndSignMs: timing((run) => run.timings.mergeAndSignMs),
			buildMs: timing((run) => run.timings.buildMs),
			freezeToValidityEndMs: stats(
				allowRuns.flatMap((run) => {
					const end = detailOf(run).invalidHereafterMs;
					return end == null ? [] : [end - Date.parse(run.frozenAt)];
				}),
			),
			denials: denials.map((run) => ({
				txHash: run.txHash,
				code: run.denialCode,
				deniedLocks: run.deniedLocks,
				freezeToDecisionMs: run.timings.freezeToDecisionMs,
			})),
		},
		volume: {
			note: 'Observed on one demo node over the real demo window. Not extrapolated to a sustained or network-wide rate.',
			window: {
				from: new Date(windowStart).toISOString(),
				to: new Date(windowEnd).toISOString(),
				minutes: +windowMinutes.toFixed(2),
			},
			locksSubmitted,
			txsSubmitted: allowRuns.length,
			txsDenied: denials.length,
			locksPerMinuteOverWindow: overallRate,
			batchedPhase: {
				locks: batched.purchaseIndexes.length,
				txs: 1,
				freezeToBlockSeconds: +((blockMs(batched) - Date.parse(batched.frozenAt)) / 1000).toFixed(1),
			},
			singleItemPhase: {
				locks: singles.length,
				txs: singles.length,
				minutes: +singleMinutes.toFixed(2),
				locksPerMinute: singleRate,
				secondsBetweenConfirmations: stats(secondsBetweenSingleConfirmations),
			},
			locksPerMinuteRange: [Math.min(overallRate, singleRate), Math.max(overallRate, singleRate)],
		},
		runs: state.runs,
	};

	const outDir = path.join(EVIDENCE_DIR, result.generatedAt.replace(/[:.]/g, '-'));
	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(path.join(outDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
	if (fs.existsSync(EVENTS_FILE)) fs.copyFileSync(EVENTS_FILE, path.join(outDir, 'events.ndjson'));
	if (fs.existsSync(DECISIONS_FILE)) fs.copyFileSync(DECISIONS_FILE, path.join(outDir, 'cosign-decisions.ndjson'));
	const f = result.fees;
	const l = result.latency;
	const v = result.volume;
	const statRow = (label: string, s: ReturnType<typeof stats>) =>
		`| ${label} | ${s?.n ?? 0} | ${s?.min ?? '-'} | ${s?.median ?? '-'} | ${s?.max ?? '-'} |`;
	fs.writeFileSync(
		path.join(outDir, 'SUMMARY.md'),
		[
			`# MAS-596 guarded smart-wallet demo — ${NETWORK} — ${result.generatedAt}`,
			'',
			'| Measure | Batched | Single-item |',
			'| --- | --- | --- |',
			`| Locks | ${f.batched.locks} in ${f.batched.txs} tx | ${f.single.locks} in ${f.single.txs} txs |`,
			`| Payment value | ${ada(f.batched.paymentValueLovelace)} | ${ada(f.single.paymentValueLovelace)} |`,
			`| Fee (on chain) | ${ada(f.batched.feeLovelace)} | ${ada(f.single.feeLovelace)} |`,
			`| of which script fee | ${ada(f.batched.scriptFeeLovelace)} | ${ada(f.single.scriptFeeLovelace)} |`,
			`| of which size fee | ${ada(f.batched.sizeFeeLovelace)} | ${ada(f.single.sizeFeeLovelace)} |`,
			`| Fee per lock | ${ada(f.batched.feePerLockLovelace)} | ${ada(f.single.feePerLockLovelace)} |`,
			`| Fee / payment value | ${f.batched.feeToPaymentValue} | ${f.single.feeToPaymentValue} |`,
			`| Script fee / payment value | ${f.batched.scriptFeeToPaymentValue} | ${f.single.scriptFeeToPaymentValue} |`,
			'',
			`Single-item fees are ${f.singleOverBatched}× the batched fee.`,
			'',
			'| Latency (ms) | n | min | median | max |',
			'| --- | --- | --- | --- | --- |',
			statRow('freeze → submit', l.freezeToSubmitMs),
			statRow('co-sign round trip', l.cosignRoundTripMs),
			statRow('merge + agent sign', l.mergeAndSignMs),
			statRow('build (to freeze)', l.buildMs),
			statRow('freeze → validity end', l.freezeToValidityEndMs),
			'',
			`Denials: ${l.denials.map((d) => `${d.code} (locks ${d.deniedLocks?.join(', ') || '-'}, freeze → decision ${d.freezeToDecisionMs} ms)`).join('; ') || 'none'}`,
			'',
			`Observed volume on one node: ${v.locksSubmitted} locks in ${v.txsSubmitted} txs, ${v.txsDenied} denied, over ${v.window.minutes} min. Single-item phase ${v.singleItemPhase.locksPerMinute} locks/min, whole window ${v.locksPerMinuteOverWindow} locks/min. Not extrapolated.`,
			'',
		].join('\n'),
	);
	log(`evidence written to ${outDir}`);
	log(
		`batched fee ${ada(f.batched.feeLovelace)} (${f.batched.feeToPaymentValue} of value) vs single ${ada(f.single.feeLovelace)} (${f.single.feeToPaymentValue})`,
	);
}

async function mock(state: DemoState): Promise<void> {
	if (state.memberMnemonics.length === 0)
		throw new Error('this state uses an external co-signer; there is no mock quorum');
	const server = await startMockCosignServer({
		memberMnemonics: state.memberMnemonics,
		apiKey: state.mockApiKey,
		threshold: state.threshold,
		maxOutflowLovelace: config.mockCapLovelace,
		maxValiditySlots: MOCK_MAX_VALIDITY_SLOTS,
		resolveInputLovelace,
		decisionsFile: DECISIONS_FILE,
		port: config.mockPort,
	});
	log(`mock co-signer on ${server.url} (POST /v1/cosign, decisions page at /). Ctrl+C to stop.`);
	await new Promise<void>((resolve) => process.once('SIGINT', resolve));
	await server.close();
}

async function sweep(state: DemoState): Promise<void> {
	const record = liveWallet(state);
	const owner = wallet(ownerMnemonic(state));
	const ownerAddress = await firstAddress(owner);
	const script = await smartWallet(state);
	const walletUtxo = await fetchWalletUtxo(provider, script, record.tokenName);
	const built = await buildOwnerSweepTx({
		provider,
		rpcApiKey: blockfrostKey,
		network: NETWORK,
		wallet: script,
		walletUtxo,
		tokenName: record.tokenName,
		ownerAddress,
		ownerUtxos: await owner.getUtxos(),
		payoutAddress: ownerAddress,
	});
	await signAndSubmit(owner, built.unsignedTx, built.txHash);
	record.sweepTxHash = built.txHash;
	saveState(state);
	await waitForConfirmation(built.txHash, 'sweep');
	record.status = 'retired';
	saveState(state);
	event('swept', { txHash: built.txHash });
	log(`wallet swept and state token burned in ${built.txHash}`);
}

const command = process.argv[2];
const commands: Record<string, () => Promise<void>> = {
	init,
	mint,
	deny: () => deny(loadState()),
	'allow-batched': () => allowBatched(loadState()),
	'allow-single': () => allowSingle(loadState()),
	report: () => report(loadState()),
	mock: () => mock(loadState()),
	sweep: () => sweep(loadState()),
	all: async () => {
		await mint();
		await deny(loadState());
		await allowBatched(loadState());
		await allowSingle(loadState());
		await report(loadState());
	},
};

const run = command == null ? undefined : commands[command];
if (run == null) {
	console.error(`usage: run.mts <${Object.keys(commands).join(' | ')}>`);
	process.exit(2);
}
run()
	.then(() => process.exit(0))
	.catch((error: unknown) => {
		if (error instanceof CosignTransportError) {
			console.error(
				`[smart-wallet-demo] co-sign transport failure (not a denial; nothing submitted): ${error.message}`,
			);
		} else {
			console.error('[smart-wallet-demo] FAILED', error instanceof Error ? error.message : error);
		}
		process.exit(1);
	});
