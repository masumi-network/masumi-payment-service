// Mesh SDK pinning: this file lives in the V2 package and MUST resolve to the
// V2 mesh line (`@meshsdk/core@1.9.0-beta.102` / `@meshsdk/core-cst@1.9.0-beta.102`).
// The derived V2 `smartContractAddress` and later script_data_hash depend on
// the exact serializer behavior of these versions. V2 intentionally uses a
// newer mesh line than V1; do not unify with the V1 pin. See
// docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
import { mPubKeyAddress, type Data, type PlutusScript } from '@meshsdk/core';
import {
	AddressType,
	applyParamsToScript,
	deserializePlutusScript,
	deserializeAddress,
	normalizePlutusScript,
	resolvePaymentKeyHash,
	resolvePlutusScriptAddress,
	resolveStakeKeyHash,
} from '@meshsdk/core-cst';
import { convertNetworkToId, SmartContractState, validateHexString } from '@masumi/payment-core';
import paymentPlutusV2 from '../../../smart-contracts/payment-v2/plutus.json';
import registryPlutusV2 from '../../../smart-contracts/registry-v2/plutus.json';
import type { Network, PaymentSource } from '@masumi/payment-core/db';

export async function getPaymentScriptFromPaymentSourceV2(
	paymentSourceSupported: PaymentSource & {
		AdminWallets: Array<{ walletAddress: string; order: number }>;
	},
) {
	const requiredAdminSignatures = paymentSourceSupported.requiredAdminSignatures;
	if (requiredAdminSignatures == null) {
		throw new Error('V2 payment source requires requiredAdminSignatures');
	}

	// Admin wallet order is a script parameter — applyParamsToScript hashes it
	// positionally. Prisma `include: { AdminWallets: true }` has no implicit
	// ordering, so derive a stable order before deriving the script address.
	const sortedAdminWallets = [...paymentSourceSupported.AdminWallets].sort((a, b) => a.order - b.order);

	return await getPaymentScriptV2(
		sortedAdminWallets.map((wallet) => wallet.walletAddress),
		requiredAdminSignatures,
		paymentSourceSupported.cooldownTime,
		paymentSourceSupported.network,
	);
}

export async function getRegistryScriptFromNetworkHandlerV2(paymentSource: PaymentSource) {
	return await getRegistryScriptV2(paymentSource.network);
}

export function getPaymentScriptV2(
	adminWalletAddresses: string[],
	requiredAdminSignatures: number,
	cooldownPeriod: number,
	network: Network,
) {
	if (requiredAdminSignatures <= 0) {
		throw new Error('requiredAdminSignatures must be greater than 0');
	}
	if (requiredAdminSignatures > adminWalletAddresses.length) {
		throw new Error('requiredAdminSignatures cannot exceed the weighted admin wallet count');
	}

	const script: PlutusScript = {
		code: applyParamsToScript(paymentPlutusV2.validators[0].compiledCode, [
			requiredAdminSignatures,
			adminWalletAddresses.map((address) => resolvePaymentKeyHash(address)),
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

export function getRegistryScriptV2(network: Network) {
	// Aiken's plutus.json emits the validator as SingleCBOR-wrapped bytes, but
	// mesh-sdk's `MeshTxBuilder.mintingScript(...)` / ledger consumers expect
	// the script reference in DoubleCBOR form (CBOR-encoded ByteString
	// containing the SingleCBOR script). When V1 contracts go through
	// `applyParamsToScript(code, [...])` they pick up the second CBOR wrap as
	// a side effect of param application. The V2 registry validator takes
	// zero parameters and previously used `compiledCode` raw, leaving it as
	// SingleCBOR. The on-chain symptom: ogmios `EvaluateTx` returns
	// `EvaluationFailure: ScriptFailures: {}` (empty) because the script
	// cannot be parsed before any Plutus eval starts. The matching example
	// script `smart-contracts/registry-v2/mint-example.mjs` uses
	// `normalizePlutusScript(code, 'DoubleCBOR')` for the same reason.
	const script: PlutusScript = {
		code: normalizePlutusScript(registryPlutusV2.validators[0].compiledCode, 'DoubleCBOR'),
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

function getPubKeyBaseAddressDatum(address: string, fieldName: string) {
	const parsedAddress = deserializeAddress(address);
	if (parsedAddress.getType() !== AddressType.BasePaymentKeyStakeKey) {
		throw new Error(`${fieldName} must be a Cardano base address with payment and stake key credentials`);
	}

	return mPubKeyAddress(resolvePaymentKeyHash(address), resolveStakeKeyHash(address));
}

function getOptionalPubKeyAddressDatum(address: string | null | undefined, fieldName: string) {
	if (address == null || address === '') {
		return {
			alternative: 1,
			fields: [],
		};
	}

	return {
		alternative: 0,
		fields: [getPubKeyBaseAddressDatum(address, fieldName)],
	};
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
			return {
				alternative: 4,
				fields: [],
			};
		case SmartContractState.RefundAuthorized:
			return {
				alternative: 5,
				fields: [],
			};
		default:
			throw new Error('Unsupported V2 smart contract state');
	}
}

export function getDatumV2({
	buyerAddress,
	buyerReturnAddress,
	sellerAddress,
	sellerReturnAddress,
	referenceKey,
	referenceSignature,
	sellerNonce,
	buyerNonce,
	agentIdentifier,
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
	buyerReturnAddress?: string | null;
	sellerAddress: string;
	sellerReturnAddress?: string | null;
	referenceKey: string;
	referenceSignature: string;
	sellerNonce: string;
	buyerNonce: string;
	agentIdentifier?: string | null;
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
	if (agentIdentifier != null && agentIdentifier !== '' && !validateHexString(agentIdentifier)) {
		throw new Error('Agent identifier is not a valid hex string');
	}
	if (inputHash != null && !validateHexString(inputHash)) {
		throw new Error('Input hash is not a valid hex string');
	}
	if (resultHash != null && resultHash.length > 0 && !validateHexString(resultHash)) {
		throw new Error('Result hash is not a valid hex string');
	}

	return {
		value: {
			alternative: 0,
			fields: [
				getPubKeyBaseAddressDatum(buyerAddress, 'buyerAddress'),
				getOptionalPubKeyAddressDatum(buyerReturnAddress, 'buyerReturnAddress'),
				getPubKeyBaseAddressDatum(sellerAddress, 'sellerAddress'),
				getOptionalPubKeyAddressDatum(sellerReturnAddress, 'sellerReturnAddress'),
				referenceKey,
				referenceSignature,
				sellerNonce,
				buyerNonce,
				agentIdentifier ?? '',
				collateralReturnLovelace,
				inputHash ?? '',
				resultHash ?? '',
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
