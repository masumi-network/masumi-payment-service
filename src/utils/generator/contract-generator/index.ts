import { Data, mPubKeyAddress, PlutusScript } from '@meshsdk/core';
import {
  deserializePlutusScript,
  resolvePlutusScriptAddress,
  resolveStakeKeyHash,
} from '@meshsdk/core-cst';
import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import paymentPlutus from '@smart-contracts/payment/plutus.json';
import registryPlutus from '@smart-contracts/registry/plutus.json';
import { Network, OnChainState, PaymentSource } from '@prisma/client';
import { applyParamsToScript } from '@meshsdk/core';
import { convertNetworkToId } from '@/utils/converter/network-convert';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { validateHexString } from '@/utils/validator/hex';

export async function getPaymentScriptFromPaymentSourceV1(
  paymentSourceSupported: PaymentSource & {
    AdminWallets: Array<{ walletAddress: string; order: number }>;
    FeeReceiverNetworkWallet: { walletAddress: string; order: number };
  },
) {
  const adminWallets = paymentSourceSupported.AdminWallets;
  if (adminWallets.length != 3) throw new Error('Invalid admin wallets');

  const sortedAdminWallets = adminWallets.sort((a, b) => a.order - b.order);
  const admin1 = sortedAdminWallets[0];
  const admin2 = sortedAdminWallets[1];
  const admin3 = sortedAdminWallets[2];
  const feeWallet = paymentSourceSupported.FeeReceiverNetworkWallet;
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

export async function getRegistryScriptFromNetworkHandlerV1(
  paymentSource: PaymentSource,
) {
  return await getRegistryScriptV1(
    paymentSource.smartContractAddress,
    paymentSource.network,
  );
}

export async function getPaymentScriptV1(
  adminWalletAddress1: string,
  adminWalletAddress2: string,
  adminWalletAddress3: string,
  feeWalletAddress: string,
  feePermille: number,
  cooldownPeriod: number,
  network: Network,
) {
  if (feePermille < 0 || feePermille > 1000)
    throw new Error('Fee permille must be between 0 and 1000');

  const script: PlutusScript = {
    code: applyParamsToScript(paymentPlutus.validators[0].compiledCode, [
      2,
      [
        resolvePaymentKeyHash(adminWalletAddress1),
        resolvePaymentKeyHash(adminWalletAddress2),
        resolvePaymentKeyHash(adminWalletAddress3),
      ],
      //yes I love meshJs
      {
        alternative: 0,
        fields: [
          {
            alternative: 0,
            fields: [resolvePaymentKeyHash(feeWalletAddress) as string],
          },
          {
            alternative: 0,
            fields: [
              {
                alternative: 0,
                fields: [
                  {
                    alternative: 0,
                    fields: [resolveStakeKeyHash(feeWalletAddress) as string],
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
  const smartContractAddress: unknown = resolvePlutusScriptAddress(
    script,
    networkId,
  );
  if (typeof smartContractAddress !== 'string') {
    throw new TypeError(
      `Expected resolvePlutusScriptAddress to return a string, got: ${typeof smartContractAddress}`,
    );
  }
  return { script, smartContractAddress };
}

export async function getRegistryScriptV1(
  contractAddress: string,
  network: Network,
) {
  const script: PlutusScript = {
    code: applyParamsToScript(registryPlutus.validators[0].compiledCode, [
      contractAddress,
    ]),
    version: 'V3',
  };

  const plutusScriptRegistry = deserializePlutusScript(
    script.code,
    script.version,
  );

  const policyAny: unknown = plutusScriptRegistry.hash();
  if (
    typeof policyAny !== 'object' ||
    policyAny === null ||
    !('toString' in policyAny) ||
    typeof (policyAny as { toString: unknown }).toString !== 'function'
  ) {
    throw new TypeError(
      'Expected PlutusScript.hash() to return an object with toString()',
    );
  }
  const policyId = (policyAny as { toString: () => string }).toString();

  const networkId = convertNetworkToId(network);

  const smartContractAddress: unknown = resolvePlutusScriptAddress(
    script,
    networkId,
  );
  if (typeof smartContractAddress !== 'string') {
    throw new TypeError(
      `Expected resolvePlutusScriptAddress to return a string, got: ${typeof smartContractAddress}`,
    );
  }
  return { script, policyId, smartContractAddress };
}

export enum SmartContractState {
  FundsLocked = 0,
  ResultSubmitted = 1,
  RefundRequested = 2,
  Disputed = 3,
}

export function smartContractStateEqualsOnChainState(
  state: SmartContractState,
  onChainState: OnChainState | null,
) {
  if (onChainState == null) {
    return false;
  }
  switch (onChainState) {
    case OnChainState.FundsLocked:
      return state == SmartContractState.FundsLocked;
    case OnChainState.ResultSubmitted:
      return state == SmartContractState.ResultSubmitted;
    case OnChainState.RefundRequested:
      return state == SmartContractState.RefundRequested;
    case OnChainState.Disputed:
      return state == SmartContractState.Disputed;
    default:
      return false;
  }
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

export function getDatum({
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
  const buyerPubKeyAddress = mPubKeyAddress(
    resolvePaymentKeyHash(buyerAddress) as string,
    resolveStakeKeyHash(buyerAddress) as string,
  );
  const sellerPubKeyAddress = mPubKeyAddress(
    resolvePaymentKeyHash(sellerAddress) as string,
    resolveStakeKeyHash(sellerAddress) as string,
  );
  //verify that reference_key, reference_signature, seller_nonce, buyer_nonce, input_hash and result hash are valid hex strings
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
  if (inputHash != null && !validateHexString(inputHash)) {
    throw new Error('Input hash is not a valid hex string');
  }
  if (
    resultHash != null &&
    resultHash.length > 0 &&
    !validateHexString(resultHash)
  ) {
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
