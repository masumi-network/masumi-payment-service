import 'dotenv/config';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Transaction } from '@meshsdk/core';
import { prisma } from '@masumi/payment-core/db';
import { HotWalletType, Network, PaymentSourceType } from '@/generated/prisma/client';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';

const CREDENTIALS_DIR = join(process.cwd(), 'hydra-l2-flow/preprod/credentials');
const MIN_BALANCE_LOVELACE = 30_000_000n;
const TOP_UP_LOVELACE = '100000000';

type BlockfrostAddressResponse = {
  amount?: Array<{ unit: string; quantity: string }>;
};

function readAddress(name: string): string {
  return readFileSync(join(CREDENTIALS_DIR, name), 'utf8').trim();
}

async function fetchLovelace(address: string, apiKey: string): Promise<bigint> {
  const response = await fetch(`https://cardano-preprod.blockfrost.io/api/v0/addresses/${address}`, {
    headers: { project_id: apiKey },
  });

  if (response.status === 404) {
    return 0n;
  }
  if (!response.ok) {
    throw new Error(`Blockfrost balance check failed for ${address}: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as BlockfrostAddressResponse;
  return BigInt(body.amount?.find((asset) => asset.unit === 'lovelace')?.quantity ?? '0');
}

async function main() {
  const paymentSource = await prisma.paymentSource.findFirstOrThrow({
    where: {
      network: Network.Preprod,
      paymentSourceType: PaymentSourceType.Web3CardanoV2,
      deletedAt: null,
    },
    include: {
      PaymentSourceConfig: true,
      HotWallets: {
        where: {
          type: HotWalletType.Purchasing,
          deletedAt: null,
        },
        include: { Secret: true },
      },
    },
  });

  const fundingWallet = paymentSource.HotWallets[0];
  if (!fundingWallet) {
    throw new Error('No active preprod V2 purchasing hot wallet found');
  }

  const rpcProviderApiKey = paymentSource.PaymentSourceConfig.rpcProviderApiKey;
  const { wallet } = await generateWalletExtended(Network.Preprod, rpcProviderApiKey, fundingWallet.Secret.encryptedMnemonic);

  for (const target of [
    { name: 'alice-node', address: readAddress('alice-node.addr') },
    { name: 'bob-node', address: readAddress('bob-node.addr') },
  ]) {
    const balance = await fetchLovelace(target.address, rpcProviderApiKey);
    console.log(`${target.name} balance: ${balance.toString()} lovelace`);

    if (balance >= MIN_BALANCE_LOVELACE) {
      console.log(`${target.name} already has enough fuel`);
      continue;
    }

    const tx = new Transaction({ initiator: wallet }).sendLovelace(target.address, TOP_UP_LOVELACE);
    const unsignedTx = await tx.build();
    const signedTx = await wallet.signTx(unsignedTx);
    const txHash = await wallet.submitTx(signedTx);
    console.log(`${target.name} top-up submitted: ${txHash}`);
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
