import cbor from 'cbor';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
	applyParamsToScript,
	deserializeDatum,
	KoiosProvider,
	MeshWallet,
	mOutputReference,
	mPubKeyAddress,
	resolvePaymentKeyHash,
	resolvePlutusScriptAddress,
	resolveStakeKeyHash,
	serializeData,
	SLOT_CONFIG_NETWORK,
	unixTimeToEnclosingSlot,
} from '@meshsdk/core';
import { blake2b } from 'ethereum-cryptography/blake2b.js';

export const network = process.env.NETWORK ?? 'preprod';
export const networkId = network === 'mainnet' ? 1 : 0;
export const cooldownPeriod = Number(process.env.COOLDOWN_PERIOD_MS ?? 1000 * 60 * 15);
export const blockchainProvider = new KoiosProvider(network);

export const State = {
	FundsLocked: 0,
	ResultSubmitted: 1,
	RefundRequested: 2,
	Disputed: 3,
	WithdrawAuthorized: 4,
	RefundAuthorized: 5,
};

export const Action = {
	Withdraw: 0,
	SetRefundRequested: 1,
	AuthorizeWithdrawal: 2,
	WithdrawRefund: 3,
	WithdrawDisputed: 4,
	SubmitResult: 5,
	AuthorizeRefund: 6,
};

export function readText(path) {
	return fs.readFileSync(path, 'utf8').trim();
}

export function readAddress(walletIndex) {
	const path = `wallet_${walletIndex}.addr`;
	if (fs.existsSync(path)) {
		return readText(path);
	}
	throw new Error(`${path} not found. Run pnpm run generate-wallet first.`);
}

export async function readAddressOrWallet(walletIndex, wallet) {
	const path = `wallet_${walletIndex}.addr`;
	if (fs.existsSync(path)) {
		return readText(path);
	}
	return firstWalletAddress(wallet);
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
	throw new Error('Wallet has no available address');
}

export function loadWallet(walletIndex) {
	const path = `wallet_${walletIndex}.sk`;
	if (!fs.existsSync(path)) {
		throw new Error(`${path} not found. Run pnpm run generate-wallet first.`);
	}
	return new MeshWallet({
		networkId,
		fetcher: blockchainProvider,
		submitter: blockchainProvider,
		key: {
			type: 'mnemonic',
			words: readText(path).split(/\s+/),
		},
	});
}

export function loadPaymentScript() {
	const blueprint = JSON.parse(readText('./plutus.json'));
	const adminAddresses = [3, 4, 5].map((walletIndex) => readAddress(walletIndex));
	const requiredAdmins = Number(process.env.REQUIRED_ADMINS ?? 2);
	const script = {
		code: applyParamsToScript(blueprint.validators[0].compiledCode, [
			requiredAdmins,
			adminAddresses.map((address) => resolvePaymentKeyHash(address)),
			cooldownPeriod,
		]),
		version: 'V3',
	};
	return {
		adminAddresses,
		requiredAdmins,
		script,
		scriptAddress: resolvePlutusScriptAddress(script, networkId),
	};
}

export async function fetchContractUtxo(provider, scriptAddress) {
	const txHash = process.env.TX_HASH ?? process.argv[2];
	if (!txHash) {
		throw new Error('Set TX_HASH=<contract-utxo-tx-hash> or pass it as the first argument.');
	}
	const outputIndex =
		process.env.OUTPUT_INDEX == null ? null : Number(process.env.OUTPUT_INDEX);
	const utxos = await provider.fetchAddressUTxOs(scriptAddress);
	const utxo = utxos.find((candidate) => {
		if (candidate.input.txHash !== txHash) {
			return false;
		}
		return outputIndex == null || candidate.input.outputIndex === outputIndex;
	});
	if (!utxo) {
		throw new Error(`Contract UTxO ${txHash}${outputIndex == null ? '' : `#${outputIndex}`} not found`);
	}
	if (!utxo.output.plutusData) {
		throw new Error('Contract UTxO does not have an inline datum');
	}
	return utxo;
}

export function addressData(address) {
	return mPubKeyAddress(resolvePaymentKeyHash(address), resolveStakeKeyHash(address));
}

export function none() {
	return { alternative: 1, fields: [] };
}

export function some(value) {
	return { alternative: 0, fields: [value] };
}

export function stateData(state) {
	return { alternative: state, fields: [] };
}

export function actionData(action, fields = []) {
	return {
		data: {
			alternative: action,
			fields,
		},
	};
}

export function outputReferenceData(utxo) {
	return mOutputReference(utxo.input.txHash, utxo.input.outputIndex);
}

export function taggedRecipient(address, utxo) {
	return {
		address,
		datum: {
			value: outputReferenceData(utxo),
			inline: true,
		},
	};
}

export function validitySlots() {
	const slotConfig = SLOT_CONFIG_NETWORK[network] ?? SLOT_CONFIG_NETWORK.preprod;
	const invalidBeforeMs = Number(process.env.INVALID_BEFORE_MS ?? Date.now());
	const invalidAfterMs = Number(process.env.INVALID_AFTER_MS ?? Date.now() + 150000);
	const invalidBefore = unixTimeToEnclosingSlot(invalidBeforeMs, slotConfig) - 1;
	const invalidAfter = unixTimeToEnclosingSlot(invalidAfterMs, slotConfig) + 1;
	return { invalidBefore, invalidAfter };
}

export function applyValidity(tx) {
	const { invalidBefore, invalidAfter } = validitySlots();
	tx.txBuilder.invalidBefore(invalidBefore);
	tx.txBuilder.invalidHereafter(invalidAfter);
	tx.setNetwork(network);
	return tx;
}

export function nextCooldownTime() {
	return BigInt(Date.now()) + BigInt(cooldownPeriod) + BigInt(1000 * 60 * 10);
}

export function hexFromEnv(name, byteLength) {
	const value = process.env[name];
	if (value != null) {
		assertHex(value, name);
		return value;
	}
	return randomBytes(byteLength).toString('hex');
}

export function optionalHexFromEnv(name) {
	const value = process.env[name] ?? '';
	if (value.length > 0) {
		assertHex(value, name);
	}
	return value;
}

export function assertHex(value, label) {
	if (!/^[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
		throw new Error(`${label} must be an even-length hex string`);
	}
}

export function createInitialDatum({ buyerAddress, sellerAddress }) {
	const now = Date.now();
	const buyerReturnAddress = process.env.BUYER_RETURN_ADDRESS;
	const sellerReturnAddress = process.env.SELLER_RETURN_ADDRESS;
	return {
		value: {
			alternative: 0,
			fields: [
				addressData(buyerAddress),
				buyerReturnAddress ? some(addressData(buyerReturnAddress)) : none(),
				addressData(sellerAddress),
				sellerReturnAddress ? some(addressData(sellerReturnAddress)) : none(),
				hexFromEnv('REFERENCE_KEY', 32),
				hexFromEnv('REFERENCE_SIGNATURE', 64),
				hexFromEnv('SELLER_NONCE', 32),
				hexFromEnv('BUYER_NONCE', 32),
				hexFromEnv('AGENT_IDENTIFIER', 32),
				BigInt(process.env.COLLATERAL_RETURN_LOVELACE ?? 0),
				optionalHexFromEnv('INPUT_HASH'),
				optionalHexFromEnv('RESULT_HASH'),
				BigInt(process.env.PAY_BY_TIME ?? now + 1000 * 60 * 5),
				BigInt(process.env.SUBMIT_RESULT_TIME ?? now + 1000 * 60 * 15),
				BigInt(process.env.UNLOCK_TIME ?? now + 1000 * 60 * 30),
				BigInt(process.env.EXTERNAL_DISPUTE_UNLOCK_TIME ?? now + 1000 * 60 * 60),
				0n,
				0n,
				stateData(State.FundsLocked),
			],
		},
		inline: true,
	};
}

export function readDatumFields(utxo) {
	const datum = deserializeDatum(utxo.output.plutusData);
	const meshDatum = fromDeserializerData(datum);
	if (meshDatum.alternative !== 0 || meshDatum.fields.length !== 19) {
		throw new Error(`Expected V2 payment datum with 19 fields, got ${meshDatum.fields.length}`);
	}
	return meshDatum.fields;
}

export function datumFromFields(fields) {
	return {
		value: {
			alternative: 0,
			fields,
		},
		inline: true,
	};
}

export function cloneDatumFields(fields) {
	return fields.map((field) => cloneData(field));
}

export function isEmptyByteString(value) {
	return typeof value === 'string' && value.length === 0;
}

export function stateAlternative(value) {
	if (value?.alternative == null) {
		throw new Error('Invalid state datum');
	}
	return Number(value.alternative);
}

export function fromDeserializerData(value) {
	if (Array.isArray(value)) {
		return value.map((item) => fromDeserializerData(item));
	}
	if (value != null && typeof value === 'object') {
		if ('constructor' in value && 'fields' in value) {
			return {
				alternative: Number(value.constructor),
				fields: value.fields.map((field) => fromDeserializerData(field)),
			};
		}
		if ('bytes' in value) {
			return value.bytes;
		}
		if ('int' in value) {
			return BigInt(value.int);
		}
		if ('list' in value) {
			return value.list.map((item) => fromDeserializerData(item));
		}
		if ('map' in value) {
			return new Map(
				value.map.map((entry) => [
					fromDeserializerData(entry.k),
					fromDeserializerData(entry.v),
				]),
			);
		}
	}
	throw new Error(`Unsupported datum value: ${JSON.stringify(value)}`);
}

export function cloneData(value) {
	if (Array.isArray(value)) {
		return value.map((item) => cloneData(item));
	}
	if (value instanceof Map) {
		return new Map([...value.entries()].map(([key, item]) => [cloneData(key), cloneData(item)]));
	}
	if (value != null && typeof value === 'object') {
		return {
			alternative: value.alternative,
			fields: value.fields.map((field) => cloneData(field)),
		};
	}
	return value;
}

export function lovelaceAsset(quantity) {
	return [{ unit: 'lovelace', quantity: BigInt(quantity).toString() }];
}

export function hasAssets(assets) {
	return assets.some((asset) => BigInt(asset.quantity) > 0n);
}

export function assetsMinusLovelace(assets, lovelace) {
	return subtractAssets(assets, lovelaceAsset(lovelace));
}

export function subtractAssets(assets, subtract) {
	const quantities = new Map();
	for (const asset of assets) {
		const unit = normalizeAssetUnit(asset.unit);
		quantities.set(unit, (quantities.get(unit) ?? 0n) + BigInt(asset.quantity));
	}
	for (const asset of subtract) {
		const unit = normalizeAssetUnit(asset.unit);
		quantities.set(unit, (quantities.get(unit) ?? 0n) - BigInt(asset.quantity));
	}
	return [...quantities.entries()]
		.filter(([, quantity]) => quantity > 0n)
		.map(([unit, quantity]) => ({ unit, quantity: quantity.toString() }));
}

export function assetsToAssetValueData(assets) {
	const policies = new Map();
	for (const asset of assets) {
		const { policyId, assetName } = splitAssetUnit(asset.unit);
		const assetsByName = policies.get(policyId) ?? new Map();
		assetsByName.set(assetName, (assetsByName.get(assetName) ?? 0n) + BigInt(asset.quantity));
		policies.set(policyId, assetsByName);
	}
	return new Map(
		[...policies.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([policyId, assetsByName]) => [
				policyId,
				new Map(
					[...assetsByName.entries()]
						.filter(([, quantity]) => quantity !== 0n)
						.sort(([a], [b]) => a.localeCompare(b)),
				),
			]),
	);
}

export function normalizeAssetUnit(unit) {
	return unit === '' ? 'lovelace' : unit;
}

export function splitAssetUnit(unit) {
	const normalized = normalizeAssetUnit(unit);
	if (normalized === 'lovelace') {
		return { policyId: '', assetName: '' };
	}
	return {
		policyId: normalized.slice(0, 56),
		assetName: normalized.slice(56),
	};
}

export function blake2b224(hex) {
	return Buffer.from(blake2b(Buffer.from(hex, 'hex'), 28)).toString('hex');
}

export function disputeIntentHash(utxo, buyerValueData, sellerValueData) {
	const withdrawalData = {
		alternative: 0,
		fields: [outputReferenceData(utxo), buyerValueData, sellerValueData],
	};
	return blake2b224(serializeData(withdrawalData));
}

export async function adminSignatureData(wallet, intentHash) {
	const signed = await wallet.signData(intentHash);
	const coseSign1 = cbor.decode(Buffer.from(signed.signature, 'hex'));
	const protectedHeaders = Buffer.from(coseSign1[0]).toString('hex');
	const signature = Buffer.from(coseSign1[3]).toString('hex');
	return {
		alternative: 0,
		fields: [coseKeyPublicKey(signed.key), protectedHeaders, signature],
	};
}

export function coseKeyPublicKey(coseKeyHex) {
	const coseKey = cbor.decode(Buffer.from(coseKeyHex, 'hex'));
	for (const [key, value] of coseKey.entries()) {
		if (Number(key) === -2) {
			return Buffer.from(value).toString('hex');
		}
	}
	throw new Error('COSE key does not contain a public key');
}
