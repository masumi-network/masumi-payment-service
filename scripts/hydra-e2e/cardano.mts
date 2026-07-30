/**
 * Cardano helpers shared by the balance report and the head-init phase.
 *
 * A hydra-node's Cardano key is a plain ed25519 key in a text envelope, not a
 * BIP32 wallet, so its address is the enterprise address of that key's hash —
 * the same derivation `cardano-cli address build` performs.
 */

import fs from 'node:fs';

export type Envelope = { type: string; description?: string; cborHex: string };

export const BLOCKFROST_BASE = 'https://cardano-preprod.blockfrost.io/api/v0';

export function readEnvelope(file: string): Envelope {
	return JSON.parse(fs.readFileSync(file, 'utf8')) as Envelope;
}

/**
 * Strip the CBOR byte-string prefix from an envelope's `cborHex`.
 *
 * Envelopes wrap the raw 32 bytes in a CBOR byte string, so the payload starts
 * with `5820`. Hashing the wrapped value would yield a plausible-looking
 * address for an account that does not exist.
 */
export function rawKeyHex(cborHex: string): string {
	const bytes = Buffer.from(cborHex, 'hex');
	if (bytes.length === 34 && bytes[0] === 0x58 && bytes[1] === 0x20) {
		return bytes.subarray(2).toString('hex');
	}
	return bytes.toString('hex');
}

/**
 * libsodium's wrappers need an explicit await before any hash call. The
 * payment service gets that for free from Mesh's own initialisation; a
 * standalone script does not.
 */
async function sodiumReady(): Promise<void> {
	const sodium = (await import('libsodium-wrappers-sumo')).default;
	await sodium.ready;
}

export async function addressFromEnvelope(envelope: Envelope): Promise<string> {
	await sodiumReady();
	const cst = await import('@meshsdk/core-cst');
	const raw = Buffer.from(rawKeyHex(envelope.cborHex), 'hex');

	const publicKey = envelope.type.includes('Signing')
		? cst.Ed25519PrivateKey.fromNormalBytes(new Uint8Array(raw)).toPublic()
		: cst.Ed25519PublicKey.fromBytes(new Uint8Array(raw));

	const keyHash = cst.Hash28ByteBase16(publicKey.hash().hex());
	return cst.buildEnterpriseAddress(cst.NetworkId.Testnet, keyHash).toAddress().toBech32();
}

export type AddressBalance = { lovelace: bigint; utxos: number; pureAdaUtxos: number };

/**
 * `pureAdaUtxos` is reported separately on purpose: the preprod faucet hands
 * out ADA bundled with tUSDM, and hydra-node's Init transaction only selects
 * pure-ADA inputs. A funded-looking address whose every UTxO carries a token
 * fails Init in a way that looks like a protocol bug.
 */
export async function balanceOf(address: string, projectId: string): Promise<AddressBalance> {
	const response = await fetch(`${BLOCKFROST_BASE}/addresses/${address}/utxos`, {
		headers: { project_id: projectId },
	});
	if (response.status === 404) {
		return { lovelace: 0n, utxos: 0, pureAdaUtxos: 0 };
	}
	if (!response.ok) {
		throw new Error(`blockfrost returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
	}
	const utxos = (await response.json()) as Array<{ amount: Array<{ unit: string; quantity: string }> }>;
	let lovelace = 0n;
	let pureAdaUtxos = 0;
	for (const utxo of utxos) {
		lovelace += BigInt(utxo.amount.find((entry) => entry.unit === 'lovelace')?.quantity ?? '0');
		if (utxo.amount.length === 1) {
			pureAdaUtxos += 1;
		}
	}
	return { lovelace, utxos: utxos.length, pureAdaUtxos };
}

export function ada(lovelace: bigint): string {
	return `${(Number(lovelace) / 1_000_000).toFixed(6)} tADA`;
}
