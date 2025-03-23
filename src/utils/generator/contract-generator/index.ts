import { Data, PlutusScript } from '@meshsdk/core';
import {
  deserializePlutusScript,
  resolvePlutusScriptAddress,
  resolveStakeKeyHash,
} from '@meshsdk/core-cst';
import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import paymentPlutus from '@smart-contracts/payment/plutus.json';
import registryPlutus from '@smart-contracts/registry/plutus.json';
import { Network, PaymentSource } from '@prisma/client';
import { applyParamsToScript } from '@meshsdk/core';
import { convertNetworkToId } from '../../converter/network-convert';

export async function getPaymentScriptFromPaymentSourceV1(
  paymentSourceSupported: PaymentSource & {
    AdminWallets: { walletAddress: string; order: number }[];
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
  const smartContractAddress = resolvePlutusScriptAddress(script, networkId);
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

  const policyId = deserializePlutusScript(
    script.code,
    script.version as 'V1' | 'V2' | 'V3',
  )
    .hash()
    .toString();

  const networkId = convertNetworkToId(network);

  const smartContractAddress = resolvePlutusScriptAddress(script, networkId);
  return { script, policyId, smartContractAddress };
}

export enum SmartContractState {
  FundsLocked = 0,
  ResultSubmitted = 1,
  RefundRequested = 2,
  Disputed = 3,
}

export function getSmartContractStateDatum(state: SmartContractState) {
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

export function getDatum({
  buyerVerificationKeyHash,
  sellerVerificationKeyHash,
  blockchainIdentifier,
  inputHash,
  resultHash,
  resultTime,
  unlockTime,
  externalDisputeUnlockTime,
  newCooldownTimeSeller,
  newCooldownTimeBuyer,
  state,
}: {
  buyerVerificationKeyHash: string;
  sellerVerificationKeyHash: string;
  blockchainIdentifier: string;
  inputHash: string;
  resultHash: string;
  resultTime: number;
  unlockTime: number;
  externalDisputeUnlockTime: number;
  newCooldownTimeSeller: number;
  newCooldownTimeBuyer: number;
  state: SmartContractState;
}) {
  return {
    value: {
      alternative: 0,
      fields: [
        buyerVerificationKeyHash,
        sellerVerificationKeyHash,
        blockchainIdentifier, //already is in base64
        //encode as base64
        Buffer.from(inputHash, 'utf-8').toString('base64'),
        Buffer.from(resultHash, 'utf-8').toString('base64'),
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
