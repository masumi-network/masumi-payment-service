// Shared helpers for the smart-wallet-in-Hydra preprod proof (MAS-622).
// Mesh SDK pinning: lives in the V2 package, so it resolves the V2 mesh line.
import { config as loadEnv } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlockfrostProvider, MeshWallet, pubKeyAddress, serializeAddressObj, type UTxO } from '@meshsdk/core';
import { blake2b, HexBlob } from '@meshsdk/core-cst';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '../../../..');
loadEnv({ path: path.join(REPO, '.env'), quiet: true });

export const NETWORK = 'preprod' as const;
export const NETWORK_ID = 0;
export const ADA = 1_000_000n;
export const STATE_DIR = path.join(HERE, '.state');
export const PREPROD_DIR = path.join(REPO, 'hydra-l2-flow', 'preprod');
export const NODE_API = process.env.SW_HYDRA_NODE ?? 'http://127.0.0.1:4001';

const key = process.env.BLOCKFROST_API_KEY_PREPROD?.trim();
if (!key) throw new Error('BLOCKFROST_API_KEY_PREPROD is not set in the repo .env');
export const blockfrostKey: string = key;
export const provider = new BlockfrostProvider(blockfrostKey);

export function log(step: string, message: string): void {
	console.log(`[${new Date().toISOString().slice(11, 19)}] [${step}] ${message}`);
}

// ---------------------------------------------------------------- state

export function readState<T>(name: string): T | null {
	const file = path.join(STATE_DIR, `${name}.json`);
	return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf-8')) as T) : null;
}

export function writeState(name: string, value: unknown): void {
	fs.mkdirSync(STATE_DIR, { recursive: true });
	fs.writeFileSync(path.join(STATE_DIR, `${name}.json`), JSON.stringify(value, null, 2));
}

/** Append one evidence line: what ran, the tx hash, and what the chain or head said. */
export function evidence(entry: Record<string, string | number | boolean | null>): void {
	fs.mkdirSync(STATE_DIR, { recursive: true });
	fs.appendFileSync(
		path.join(STATE_DIR, 'evidence.ndjson'),
		`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
	);
}

// ---------------------------------------------------------------- keys

export const ROLES = ['owner', 'agent', 'quorum1', 'quorum2', 'quorum3'] as const;
export type Role = (typeof ROLES)[number];

/** Test-only mnemonics, generated once and kept in the git-ignored state dir. */
export function loadMnemonics(): Record<Role, string[]> {
	const existing = readState<Record<Role, string[]>>('keys');
	if (existing) return existing;
	const created = Object.fromEntries(ROLES.map((role) => [role, MeshWallet.brew() as string[]])) as Record<
		Role,
		string[]
	>;
	writeState('keys', created);
	return created;
}

export async function loadWallets(): Promise<Record<Role, MeshWallet>> {
	const mnemonics = loadMnemonics();
	const entries = await Promise.all(
		ROLES.map(async (role) => {
			const wallet = new MeshWallet({
				networkId: NETWORK_ID,
				fetcher: provider,
				submitter: provider,
				key: { type: 'mnemonic', words: mnemonics[role] },
			});
			await wallet.init();
			return [role, wallet] as const;
		}),
	);
	return Object.fromEntries(entries) as Record<Role, MeshWallet>;
}

/** Enterprise address of a cardano-cli verification key file (the Hydra nodes' fuel keys). */
export function addressFromVkFile(file: string): string {
	const { cborHex } = JSON.parse(fs.readFileSync(file, 'utf-8')) as { cborHex: string };
	const keyHash = blake2b.hash(HexBlob(cborHex.slice(4)), 28);
	return serializeAddressObj(pubKeyAddress(keyHash), NETWORK_ID);
}

export const partyFuel = {
	purchasing: addressFromVkFile(path.join(PREPROD_DIR, 'purchasing-cardano.vk')),
	selling: addressFromVkFile(path.join(PREPROD_DIR, 'selling-cardano.vk')),
};

// ---------------------------------------------------------------- chain

export function lovelaceOf(utxos: UTxO[]): bigint {
	return utxos.reduce(
		(sum, utxo) => sum + BigInt(utxo.output.amount.find((asset) => asset.unit === 'lovelace')?.quantity ?? '0'),
		0n,
	);
}

export function ada(lovelace: bigint): string {
	return `${(Number(lovelace) / 1e6).toFixed(6)} ADA`;
}

// ---------------------------------------------------------------- head

type HydraValue = Record<string, number | Record<string, number>>;
export type HydraUTxO = {
	address: string;
	value: HydraValue;
	inlineDatumRaw?: string | null;
	inlineDatum?: unknown;
	datumhash?: string | null;
};

export function toHydraUtxo(utxo: UTxO): HydraUTxO {
	const value: HydraValue = {};
	for (const asset of utxo.output.amount) {
		if (asset.unit === 'lovelace' || asset.unit === '') {
			value.lovelace = Number(asset.quantity);
			continue;
		}
		const policy = asset.unit.slice(0, 56);
		const names = (value[policy] as Record<string, number> | undefined) ?? {};
		names[asset.unit.slice(56)] = Number(asset.quantity);
		value[policy] = names;
	}
	return {
		address: utxo.output.address,
		value,
		datumhash: null,
		inlineDatum: null,
		inlineDatumRaw: utxo.output.plutusData ?? null,
	};
}

export function fromHydraUtxo(ref: string, utxo: HydraUTxO): UTxO {
	const [txHash, index] = ref.split('#');
	const amount = Object.entries(utxo.value).flatMap(([policy, entry]) =>
		typeof entry === 'number'
			? [{ unit: 'lovelace', quantity: String(entry) }]
			: Object.entries(entry).map(([name, quantity]) => ({ unit: `${policy}${name}`, quantity: String(quantity) })),
	);
	return {
		input: { txHash, outputIndex: Number(index) },
		output: { address: utxo.address, amount, plutusData: utxo.inlineDatumRaw ?? undefined },
	};
}

export async function headGet<T>(route: string): Promise<T> {
	const response = await fetch(`${NODE_API}${route}`);
	if (!response.ok) throw new Error(`GET ${route} ${response.status}: ${await response.text()}`);
	return (await response.json()) as T;
}

export async function headPost<T>(route: string, body: unknown): Promise<T> {
	const response = await fetch(`${NODE_API}${route}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`POST ${route} ${response.status}: ${text}`);
	return (text ? JSON.parse(text) : null) as T;
}

export async function snapshotUtxos(): Promise<UTxO[]> {
	const snapshot = await headGet<Record<string, HydraUTxO>>('/snapshot/utxo');
	return Object.entries(snapshot).map(([ref, utxo]) => fromHydraUtxo(ref, utxo));
}

export async function waitFor<T>(label: string, probe: () => Promise<T | null>, timeoutMs = 25 * 60_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = await probe();
		if (found != null) return found;
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
	throw new Error(`timed out waiting for ${label}`);
}

export function holds(utxo: UTxO, unit: string): boolean {
	return utxo.output.amount.some((asset) => asset.unit === unit && asset.quantity === '1');
}

export async function l1TipSlot(): Promise<number> {
	const response = await fetch('https://cardano-preprod.blockfrost.io/api/v0/blocks/latest', {
		headers: { project_id: blockfrostKey },
	});
	const block = (await response.json()) as { slot: number };
	return block.slot;
}

const POLL_MS = 10_000;

/** Wait until Blockfrost knows the tx. Returns once it is in a block. */
export async function waitForL1Tx(txHash: string, timeoutMs = 10 * 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const response = await fetch(`https://cardano-preprod.blockfrost.io/api/v0/txs/${txHash}`, {
			headers: { project_id: blockfrostKey },
		});
		if (response.ok) return;
		if (response.status !== 404) throw new Error(`Blockfrost tx lookup ${response.status}: ${await response.text()}`);
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
	throw new Error(`tx ${txHash} not on chain after ${timeoutMs / 1000}s`);
}
