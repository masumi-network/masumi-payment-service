import 'dotenv/config';

import { MeshTxBuilder } from '@meshsdk/core';
import { prisma } from '@masumi/payment-core/db';
import { HotWalletType, HydraHeadStatus, Network } from '@/generated/prisma/client';
import { HydraNode } from '@/lib/hydra/hydra/node';
import { HydraProvider } from '@/lib/hydra/hydra/provider';
import { decrypt } from '@/utils/security/encryption';
import { generateOfflineWallet } from '@/utils/generator/wallet-generator';

const DEFAULT_AMOUNT = '5000000';
const amount = process.argv[2] ?? DEFAULT_AMOUNT;

function lovelaceOf(amounts: Array<{ unit: string; quantity: string }>): bigint {
  return BigInt(amounts.find((asset) => asset.unit === 'lovelace')?.quantity ?? '0');
}

function shortTx(txHash: string, outputIndex: number): string {
  return `${txHash.slice(0, 12)}...#${outputIndex}`;
}

async function main() {
  const head = await prisma.hydraHead.findFirstOrThrow({
    where: {
      status: HydraHeadStatus.Open,
      isEnabled: true,
      HydraRelation: { network: Network.Preprod },
    },
    include: {
      HydraRelation: true,
      LocalParticipant: {
        include: {
          Wallet: {
            include: {
              Secret: true,
            },
          },
        },
      },
      RemoteParticipants: {
        include: {
          Wallet: true,
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });

  const localWallet = head.LocalParticipant?.Wallet;
  const remoteWallet = head.RemoteParticipants[0]?.Wallet;

  if (!localWallet) {
    throw new Error(`Hydra head ${head.id} has no local participant wallet`);
  }
  if (localWallet.type !== HotWalletType.Purchasing) {
    throw new Error(`Expected the local wallet to be Purchasing, got ${localWallet.type}`);
  }
  if (!remoteWallet) {
    throw new Error(`Hydra head ${head.id} has no remote seller wallet`);
  }

  const node = new HydraNode({ httpUrl: head.LocalParticipant.nodeHttpUrl, wsUrl: head.LocalParticipant.nodeUrl });
  node.connect();
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const provider = new HydraProvider({ node });
  const wallet = generateOfflineWallet(Network.Preprod, decrypt(localWallet.Secret.encryptedMnemonic).split(' '));

  const before = await node.snapshotUTxO();
  const source = before
    .filter(
      (utxo) =>
        utxo.output.address === localWallet.walletAddress &&
        !utxo.output.plutusData &&
        lovelaceOf(utxo.output.amount) > BigInt(amount),
    )
    .sort((a, b) => Number(lovelaceOf(b.output.amount) - lovelaceOf(a.output.amount)))[0];

  if (!source) {
    throw new Error(`No spendable in-head UTxO at purchasing wallet ${localWallet.walletAddress}`);
  }

  console.log(
    JSON.stringify(
      {
        headId: head.id,
        headIdentifier: head.headIdentifier,
        from: localWallet.walletAddress,
        to: remoteWallet.walletAddress,
        source: shortTx(source.input.txHash, source.input.outputIndex),
        sourceLovelace: lovelaceOf(source.output.amount).toString(),
        amount,
      },
      null,
      2,
    ),
  );

  const tx = new MeshTxBuilder({ fetcher: provider, submitter: provider, isHydra: true });
  await tx
    .txIn(source.input.txHash, source.input.outputIndex, source.output.amount, source.output.address)
    .txOut(remoteWallet.walletAddress, [{ unit: 'lovelace', quantity: amount }])
    .setFee('0')
    .changeAddress(localWallet.walletAddress)
    .complete();

  const signedTx = await wallet.signTx(tx.txHex);
  const txHash = await provider.submitTx(signedTx);

  const confirmed = await Promise.race([
    node.awaitTx(txHash, 500).then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15000)),
  ]);

  const after = await node.snapshotUTxO();
  const sellerUtxos = after.filter((utxo) => utxo.output.address === remoteWallet.walletAddress);
  const buyerUtxos = after.filter((utxo) => utxo.output.address === localWallet.walletAddress);

  console.log(
    JSON.stringify(
      {
        txHash,
        confirmed,
        sellerUtxos: sellerUtxos.map((utxo) => ({
          ref: shortTx(utxo.input.txHash, utxo.input.outputIndex),
          lovelace: lovelaceOf(utxo.output.amount).toString(),
        })),
        buyerUtxos: buyerUtxos.map((utxo) => ({
          ref: shortTx(utxo.input.txHash, utxo.input.outputIndex),
          lovelace: lovelaceOf(utxo.output.amount).toString(),
          assets: utxo.output.amount.filter((asset) => asset.unit !== 'lovelace'),
        })),
      },
      null,
      2,
    ),
  );

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
