import fs from 'node:fs';
import 'dotenv/config';
import {
	KoiosProvider,
	MeshWallet,
	resolvePlutusScriptAddress,
} from '@meshsdk/core';
import {
	deserializePlutusScript,
	normalizePlutusScript,
} from '@meshsdk/core-cst';
import { blake2b } from 'ethereum-cryptography/blake2b.js';

export const network = process.env.NETWORK ?? 'preprod';
export const networkId = network === 'mainnet' ? 1 : 0;
export const blockchainProvider = new KoiosProvider(network);

export const Action = {
	MintAction: 0,
	UpdateAction: 1,
	BurnAction: 2,
};

export function readText(path) {
	return fs.readFileSync(path, 'utf8').trim();
}

export function loadWallet() {
	const walletPath = process.env.WALLET_FILE ?? 'wallet.sk';
	if (!fs.existsSync(walletPath)) {
		throw new Error(`${walletPath} not found. Run pnpm run generate-wallet first.`);
	}
	return new MeshWallet({
		networkId,
		fetcher: blockchainProvider,
		submitter: blockchainProvider,
		key: {
			type: 'mnemonic',
			words: readText(walletPath).split(/\s+/),
		},
	});
}

export async function firstWalletAddress(wallet) {
	const unused = await wallet.getUnusedAddresses();
	if (unused.length > 0) {
		return unused[0];
	}
	const used = await wallet.getUsedAddresses();
	if (used.length > 0) {
		return used[0];
	}
	throw new Error('Wallet has no available address.');
}

export function loadRegistryScript() {
	const blueprint = JSON.parse(readText('./plutus.json'));
	const script = {
		code: normalizePlutusScript(blueprint.validators[0].compiledCode, 'DoubleCBOR'),
		version: 'V3',
	};
	return {
		policyId: deserializePlutusScript(script.code, script.version).hash().toString(),
		script,
		scriptAddress: resolvePlutusScriptAddress(script, networkId),
	};
}

export function assertHex(value, label) {
	if (!/^[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
		throw new Error(`${label} must be an even-length hex string.`);
	}
}

export function assertAssetName(assetName, label = 'ASSET_NAME') {
	assertHex(assetName, label);
	if (Buffer.from(assetName, 'hex').length !== 32) {
		throw new Error(`${label} must be exactly 32 bytes / 64 hex characters.`);
	}
}

export function parseAssetNames(value = process.env.ASSET_NAMES, expectedCount = 3) {
	if (!value) {
		throw new Error('Set ASSET_NAMES=<asset-name-hex-1>,<asset-name-hex-2>,<asset-name-hex-3>.');
	}
	const assetNames = value.split(/[,\s]+/).filter(Boolean);
	if (assetNames.length !== expectedCount) {
		throw new Error(`ASSET_NAMES must contain exactly ${expectedCount} asset names.`);
	}
	const normalizedAssetNames = assetNames.map((assetName) => assetName.toLowerCase());
	if (new Set(normalizedAssetNames).size !== normalizedAssetNames.length) {
		throw new Error('ASSET_NAMES must not contain duplicates.');
	}
	for (const [index, assetName] of assetNames.entries()) {
		assertAssetName(assetName, `ASSET_NAMES[${index}]`);
	}
	return normalizedAssetNames;
}

export function nextAssetName(assetName) {
	assertAssetName(assetName);
	const bytes = Buffer.from(assetName, 'hex');
	const version = bytes.readUIntBE(29, 3);
	if (version === 0xffffff) {
		throw new Error(`Asset ${assetName} is already at the maximum 3-byte version.`);
	}
	bytes.writeUIntBE(version + 1, 29, 3);
	return bytes.toString('hex');
}

export function assetNameFromUtxo(utxo, nonce = process.env.ASSET_NONCE ?? '10', nonceLabel = 'ASSET_NONCE') {
	assertHex(nonce, nonceLabel);
	if (Buffer.from(nonce, 'hex').length !== 1) {
		throw new Error(`${nonceLabel} must be exactly 1 byte / 2 hex characters.`);
	}
	if (Number.parseInt(nonce, 16) <= 0x0f) {
		throw new Error(`${nonceLabel} must be between 10 and ff to avoid CIP-67/CIP-68 label prefixes.`);
	}

	const outputRef = Buffer.from(
		`${utxo.input.txHash}${utxo.input.outputIndex.toString(16).padStart(8, '0')}`,
		'hex',
	);
	const prefix = blake2b(outputRef, 28);
	const assetName = Buffer.concat([
		Buffer.from(nonce, 'hex'),
		Buffer.from(prefix),
		Buffer.from('000000', 'hex'),
	]);
	return assetName.toString('hex');
}

export function findAssetUtxo(utxos, assetId) {
	const assetUtxo = utxos.find((utxo) =>
		utxo.output.amount.some((asset) => asset.unit === assetId && BigInt(asset.quantity) > 0n),
	);
	if (!assetUtxo) {
		throw new Error(`No UTxO found containing asset ${assetId}.`);
	}
	return assetUtxo;
}

function sleep(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export async function waitForKoiosAssetMetadata(assetIds) {
	const attempts = Number.parseInt(process.env.KOIOS_METADATA_ATTEMPTS ?? '30', 10);
	const delayMs = Number.parseInt(process.env.KOIOS_METADATA_DELAY_MS ?? '10000', 10);
	const metadataByAssetId = new Map();

	if (!Number.isInteger(attempts) || attempts < 1) {
		throw new Error('KOIOS_METADATA_ATTEMPTS must be a positive integer.');
	}
	if (!Number.isInteger(delayMs) || delayMs < 0) {
		throw new Error('KOIOS_METADATA_DELAY_MS must be a non-negative integer.');
	}

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		for (const assetId of assetIds) {
			if (metadataByAssetId.has(assetId)) {
				continue;
			}
			try {
				const metadata = await blockchainProvider.fetchAssetMetadata(assetId);
				if (metadata != null) {
					metadataByAssetId.set(assetId, metadata);
				}
			} catch (_error) {
				// Koios may not have indexed the submitted transaction yet.
			}
		}
		if (metadataByAssetId.size === assetIds.length) {
			return Object.fromEntries(metadataByAssetId);
		}
		if (attempt < attempts) {
			await sleep(delayMs);
		}
	}

	const missingAssetIds = assetIds.filter((assetId) => !metadataByAssetId.has(assetId));
	throw new Error(`Koios did not return metadata for: ${missingAssetIds.join(', ')}`);
}

export async function waitForKoiosCip25Metadata(txHash, policyId, assetNames) {
	const attempts = Number.parseInt(process.env.KOIOS_METADATA_ATTEMPTS ?? '30', 10);
	const delayMs = Number.parseInt(process.env.KOIOS_METADATA_DELAY_MS ?? '10000', 10);

	if (!Number.isInteger(attempts) || attempts < 1) {
		throw new Error('KOIOS_METADATA_ATTEMPTS must be a positive integer.');
	}
	if (!Number.isInteger(delayMs) || delayMs < 0) {
		throw new Error('KOIOS_METADATA_DELAY_MS must be a non-negative integer.');
	}

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			const { data, status } = await blockchainProvider._axiosInstance.post('tx_metadata', {
				_tx_hashes: [txHash],
			});
			const txMetadata = data.find((entry) => entry.tx_hash === txHash)?.metadata;
			const cip25Metadata = txMetadata?.['721'] ?? txMetadata?.[721];
			const policyMetadata = cip25Metadata?.[policyId];

			if (status === 200 && policyMetadata) {
				const missingAssetNames = assetNames.filter((assetName) => policyMetadata[assetName] == null);
				if (missingAssetNames.length === 0) {
					return cip25Metadata;
				}
			}
		} catch (_error) {
			// Koios may not have indexed the submitted transaction metadata yet.
		}
		if (attempt < attempts) {
			await sleep(delayMs);
		}
	}

	throw new Error(`Koios did not return CIP-25 metadata for: ${assetNames.join(', ')}`);
}

export function differentUtxos(left, right) {
	return (
		left.input.txHash !== right.input.txHash ||
		left.input.outputIndex !== right.input.outputIndex
	);
}

export function cardanoscanTransactionUrl(txHash) {
	const subdomain = network === 'preprod' ? 'preprod.' : '';
	return `https://${subdomain}cardanoscan.io/transaction/${txHash}`;
}
