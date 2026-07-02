// Mesh SDK pinning: this file lives in the V1 package and MUST resolve to the
// V1 mesh line (`@meshsdk/core@1.9.0-beta.96` / `@meshsdk/core-cst@1.9.0-beta.90`).
// The derived `smartContractAddress` and any later script_data_hash depend on
// the exact serializer behavior of these versions — bumping them would change
// the on-chain V1 contract address and break compatibility with all existing
// V1 deployments and locked funds. See docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
import { mPubKeyAddress, type Data, type PlutusScript } from '@meshsdk/core';
import {
	applyParamsToScript,
	deserializePlutusScript,
	resolvePaymentKeyHash,
	resolvePlutusScriptAddress,
	resolveStakeKeyHash,
} from '@meshsdk/core-cst';
import {
	decodeBlockchainIdentifier,
	convertNetworkToId,
	SmartContractState,
	validateHexString,
} from '@masumi/payment-core';
import paymentPlutus from '../../../smart-contracts/payment/plutus.json';
import registryPlutus from '../../../smart-contracts/registry/plutus.json';
import type { Network, PaymentSource } from '@masumi/payment-core/db';

export async function getPaymentScriptFromPaymentSourceV1(
	paymentSourceSupported: PaymentSource & {
		AdminWallets: Array<{ walletAddress: string; order: number }>;
		FeeReceiverNetworkWallet: { walletAddress: string; order: number } | null;
	},
) {
	const adminWallets = paymentSourceSupported.AdminWallets;
	if (adminWallets.length != 3) throw new Error('Invalid admin wallets');

	const sortedAdminWallets = [...adminWallets].sort((a, b) => a.order - b.order);
	const admin1 = sortedAdminWallets[0];
	const admin2 = sortedAdminWallets[1];
	const admin3 = sortedAdminWallets[2];
	const feeWallet = paymentSourceSupported.FeeReceiverNetworkWallet;
	if (feeWallet == null) {
		throw new Error('V1 payment source requires a fee receiver wallet');
	}

	return await getPaymentScriptV1(
		admin1.walletAddress,
		admin2.walletAddress,
		admin3.walletAddress,
		feeWallet.walletAddress,
		paymentSourceSupported.feeRatePermille,
		paymentSourceSupported.cooldownTime,
		paymentSourceSupported.network,
	);
}

export async function getRegistryScriptFromNetworkHandlerV1(paymentSource: PaymentSource) {
	return await getRegistryScriptV1(paymentSource.smartContractAddress, paymentSource.network);
}

export function getPaymentScriptV1(
	adminWalletAddress1: string,
	adminWalletAddress2: string,
	adminWalletAddress3: string,
	feeWalletAddress: string,
	feePermille: number,
	cooldownPeriod: number,
	network: Network,
) {
	if (feePermille < 0 || feePermille > 1000) throw new Error('Fee permille must be between 0 and 1000');

	const script: PlutusScript = {
		code: applyParamsToScript(paymentPlutus.validators[0].compiledCode, [
			2,
			[
				resolvePaymentKeyHash(adminWalletAddress1),
				resolvePaymentKeyHash(adminWalletAddress2),
				resolvePaymentKeyHash(adminWalletAddress3),
			],
			{
				alternative: 0,
				fields: [
					{
						alternative: 0,
						fields: [resolvePaymentKeyHash(feeWalletAddress)],
					},
					{
						alternative: 0,
						fields: [
							{
								alternative: 0,
								fields: [
									{
										alternative: 0,
										fields: [resolveStakeKeyHash(feeWalletAddress)],
									},
								],
							},
						],
					},
				],
			},
			feePermille,
			cooldownPeriod,
		]),
		version: 'V3',
	};
	const networkId = convertNetworkToId(network);
	const smartContractAddress: unknown = resolvePlutusScriptAddress(script, networkId);
	if (typeof smartContractAddress !== 'string') {
		throw new TypeError(`Expected resolvePlutusScriptAddress to return a string, got: ${typeof smartContractAddress}`);
	}
	return Promise.resolve({ script, smartContractAddress });
}

export function getRegistryScriptV1(contractAddress: string, network: Network) {
	const script: PlutusScript = {
		code: applyParamsToScript(registryPlutus.validators[0].compiledCode, [contractAddress]),
		version: 'V3',
	};

	const plutusScriptRegistry = deserializePlutusScript(script.code, script.version);

	const policyAny: unknown = plutusScriptRegistry.hash();
	if (
		(typeof policyAny !== 'object' ||
			policyAny === null ||
			!('toString' in policyAny) ||
			typeof (policyAny as { toString: unknown }).toString !== 'function') &&
		typeof policyAny !== 'string'
	) {
		throw new TypeError('Expected PlutusScript.hash() to return an object with toString() got: ' + typeof policyAny);
	}
	const policyId = typeof policyAny === 'string' ? policyAny : (policyAny as { toString: () => string }).toString();

	const networkId = convertNetworkToId(network);

	const smartContractAddress: unknown = resolvePlutusScriptAddress(script, networkId);
	if (typeof smartContractAddress !== 'string') {
		throw new TypeError(`Expected resolvePlutusScriptAddress to return a string, got: ${typeof smartContractAddress}`);
	}
	return Promise.resolve({ script, policyId, smartContractAddress });
}

function getSmartContractStateDatum(state: SmartContractState) {
	switch (state) {
		case SmartContractState.FundsLocked:
			return {
				alternative: 0,
				fields: [],
			};
		case SmartContractState.ResultSubmitted:
			return {
				alternative: 1,
				fields: [],
			};
		case SmartContractState.RefundRequested:
			return {
				alternative: 2,
				fields: [],
			};
		case SmartContractState.Disputed:
			return {
				alternative: 3,
				fields: [],
			};
		case SmartContractState.WithdrawAuthorized:
		case SmartContractState.RefundAuthorized:
			// The deployed V1 on-chain `State` enum only has constructors 0-3
			// (vested_pay.ak). Encoding alternatives 4/5 would write a datum the
			// validator can never decode, permanently locking the UTxO's funds.
			// These states only exist in the V2 contract; reject them here.
			throw new Error(`Smart contract state ${state} is not valid for the V1 payment contract`);
		default:
			throw new Error('Unsupported V1 smart contract state');
	}
}

export function getDatumFromBlockchainIdentifier({
	buyerAddress,
	sellerAddress,
	blockchainIdentifier,
	collateralReturnLovelace,
	inputHash,
	resultHash,
	payByTime,
	resultTime,
	unlockTime,
	externalDisputeUnlockTime,
	newCooldownTimeSeller,
	newCooldownTimeBuyer,
	state,
}: {
	buyerAddress: string;
	sellerAddress: string;
	blockchainIdentifier: string;
	collateralReturnLovelace: bigint;
	inputHash: string | null;
	resultHash: string | null;
	payByTime: bigint;
	resultTime: bigint;
	unlockTime: bigint;
	externalDisputeUnlockTime: bigint;
	newCooldownTimeSeller: bigint;
	newCooldownTimeBuyer: bigint;
	state: SmartContractState;
}) {
	const decoded = decodeBlockchainIdentifier(blockchainIdentifier);
	if (decoded == null) {
		throw new Error('Invalid blockchain identifier');
	}

	return getDatum({
		buyerAddress,
		sellerAddress,
		referenceKey: decoded.key,
		referenceSignature: decoded.signature,
		sellerNonce: decoded.sellerId,
		buyerNonce: decoded.purchaserId,
		collateralReturnLovelace,
		inputHash: inputHash,
		resultHash: resultHash,
		payByTime,
		resultTime,
		unlockTime,
		externalDisputeUnlockTime,
		newCooldownTimeSeller,
		newCooldownTimeBuyer,
		state,
	});
}

function getDatum({
	buyerAddress,
	sellerAddress,
	referenceKey,
	referenceSignature,
	sellerNonce,
	buyerNonce,
	collateralReturnLovelace,
	inputHash,
	resultHash,
	payByTime,
	resultTime,
	unlockTime,
	externalDisputeUnlockTime,
	newCooldownTimeSeller,
	newCooldownTimeBuyer,
	state,
}: {
	buyerAddress: string;
	sellerAddress: string;
	referenceKey: string;
	referenceSignature: string;
	sellerNonce: string;
	buyerNonce: string;
	collateralReturnLovelace: bigint;
	inputHash: string | null;
	resultHash: string | null;
	payByTime: bigint;
	resultTime: bigint;
	unlockTime: bigint;
	externalDisputeUnlockTime: bigint;
	newCooldownTimeSeller: bigint;
	newCooldownTimeBuyer: bigint;
	state: SmartContractState;
}) {
	const buyerPubKeyAddress = mPubKeyAddress(resolvePaymentKeyHash(buyerAddress), resolveStakeKeyHash(buyerAddress));
	const sellerPubKeyAddress = mPubKeyAddress(resolvePaymentKeyHash(sellerAddress), resolveStakeKeyHash(sellerAddress));
	if (!validateHexString(referenceKey)) {
		throw new Error('Reference key is not a valid hex string');
	}
	if (!validateHexString(referenceSignature)) {
		throw new Error('Reference signature is not a valid hex string');
	}
	if (!validateHexString(sellerNonce)) {
		throw new Error('Seller nonce is not a valid hex string');
	}
	if (!validateHexString(buyerNonce)) {
		throw new Error('Buyer nonce is not a valid hex string');
	}
	// Treat empty-string `inputHash` as null for symmetry with the decoder at
	// src/utils/converter/string-datum-convert/index.ts, which normalises an
	// on-chain empty bytestring to null. Without this normalisation, a caller
	// (or a DB row) feeding `inputHash = ''` would fall through to
	// `validateHexString('')`, which returns false (the `+` quantifier requires
	// ≥1 hex char), and the builder would reject a legitimate "no input hash"
	// case with "Invalid hex".
	if (inputHash != null && inputHash !== '' && !validateHexString(inputHash)) {
		throw new Error('Input hash is not a valid hex string');
	}
	if (resultHash != null && resultHash.length > 0 && !validateHexString(resultHash)) {
		throw new Error('Result hash is not a valid hex string');
	}

	return {
		value: {
			alternative: 0,
			fields: [
				buyerPubKeyAddress,
				sellerPubKeyAddress,
				referenceKey,
				referenceSignature,
				sellerNonce,
				buyerNonce,
				collateralReturnLovelace,
				inputHash != null ? inputHash : '',
				resultHash != null ? resultHash : '',
				payByTime,
				resultTime,
				unlockTime,
				externalDisputeUnlockTime,
				newCooldownTimeSeller,
				newCooldownTimeBuyer,
				getSmartContractStateDatum(state),
			],
		} as Data,
		inline: true,
	};
}
