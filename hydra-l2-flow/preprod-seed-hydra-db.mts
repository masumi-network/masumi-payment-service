import 'dotenv/config';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@masumi/payment-core/db';
import { encrypt } from '@/utils/security/encryption';
import { HotWalletType, Network, PaymentSourceType, WalletType } from '@/generated/prisma/client';

const CREDENTIALS_DIR = join(process.cwd(), 'hydra-l2-flow/preprod/credentials');
const ALICE_WS_URL = 'ws://127.0.0.1:4101';
const ALICE_HTTP_URL = 'http://127.0.0.1:4101';
const BOB_WS_URL = 'ws://127.0.0.1:4102';
const BOB_HTTP_URL = 'http://127.0.0.1:4102';

type KeyEnvelope = {
  cborHex: string;
};

function readHydraCborHex(name: string): string {
  const envelope = JSON.parse(readFileSync(join(CREDENTIALS_DIR, name), 'utf8')) as KeyEnvelope;
  if (!envelope.cborHex) {
    throw new Error(`${name} does not contain cborHex`);
  }
  return envelope.cborHex;
}

async function main() {
  const paymentSource = await prisma.paymentSource.findFirstOrThrow({
    where: {
      network: Network.Preprod,
      paymentSourceType: PaymentSourceType.Web3CardanoV2,
      deletedAt: null,
    },
    include: {
      HotWallets: {
        where: {
          type: { in: [HotWalletType.Purchasing, HotWalletType.Selling] },
          deletedAt: null,
        },
      },
    },
  });

  const purchasingWallet = paymentSource.HotWallets.find((wallet) => wallet.type === HotWalletType.Purchasing);
  const sellingWallet = paymentSource.HotWallets.find((wallet) => wallet.type === HotWalletType.Selling);

  if (!purchasingWallet) {
    throw new Error('No active preprod V2 purchasing hot wallet found');
  }
  if (!sellingWallet) {
    throw new Error('No active preprod V2 selling hot wallet found');
  }

  const remoteWallet = await prisma.walletBase.upsert({
    where: {
      paymentSourceId_walletVkey_walletAddress_type: {
        paymentSourceId: paymentSource.id,
        walletVkey: sellingWallet.walletVkey,
        walletAddress: sellingWallet.walletAddress,
        type: WalletType.Seller,
      },
    },
    create: {
      paymentSourceId: paymentSource.id,
      walletVkey: sellingWallet.walletVkey,
      walletAddress: sellingWallet.walletAddress,
      type: WalletType.Seller,
      note: 'Hydra preprod demo remote seller wallet',
    },
    update: {
      note: 'Hydra preprod demo remote seller wallet',
    },
  });

  const hydraRelation = await prisma.hydraRelation.upsert({
    where: {
      network_localHotWalletId_remoteWalletId: {
        network: Network.Preprod,
        localHotWalletId: purchasingWallet.id,
        remoteWalletId: remoteWallet.id,
      },
    },
    create: {
      network: Network.Preprod,
      localHotWalletId: purchasingWallet.id,
      remoteWalletId: remoteWallet.id,
    },
    update: {},
  });

  const existingHead = await prisma.hydraHead.findFirst({
    where: {
      hydraRelationId: hydraRelation.id,
      status: { in: ['Idle', 'Connecting', 'Connected', 'Initializing', 'Open'] },
      isEnabled: true,
    },
    include: {
      LocalParticipant: true,
      RemoteParticipants: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  if (existingHead) {
    console.log(
      JSON.stringify(
        {
          reused: true,
          hydraRelationId: hydraRelation.id,
          hydraHeadId: existingHead.id,
          localParticipantId: existingHead.LocalParticipant?.id,
          remoteParticipantIds: existingHead.RemoteParticipants.map((participant) => participant.id),
        },
        null,
        2,
      ),
    );
    await prisma.$disconnect();
    process.exit(0);
    return;
  }

  const localParticipant = await prisma.hydraLocalParticipant.create({
    data: {
      Wallet: { connect: { id: purchasingWallet.id } },
      nodeUrl: ALICE_WS_URL,
      nodeHttpUrl: ALICE_HTTP_URL,
      HydraSecretKey: {
        create: { hydraSK: encrypt(readHydraCborHex('alice-hydra.sk')) },
      },
    },
  });

  const remoteParticipant = await prisma.hydraRemoteParticipant.create({
    data: {
      Wallet: { connect: { id: remoteWallet.id } },
      nodeUrl: BOB_WS_URL,
      nodeHttpUrl: BOB_HTTP_URL,
      HydraVerificationKey: {
        create: { hydraVK: readHydraCborHex('bob-hydra.vk') },
      },
    },
  });

  const head = await prisma.hydraHead.create({
    data: {
      HydraRelation: { connect: { id: hydraRelation.id } },
      contestationPeriod: 86_400n,
      LocalParticipant: { connect: { id: localParticipant.id } },
      RemoteParticipants: { connect: [{ id: remoteParticipant.id }] },
    },
  });

  console.log(
    JSON.stringify(
      {
        reused: false,
        paymentSourceId: paymentSource.id,
        localHotWalletId: purchasingWallet.id,
        remoteWalletId: remoteWallet.id,
        hydraRelationId: hydraRelation.id,
        localParticipantId: localParticipant.id,
        remoteParticipantId: remoteParticipant.id,
        hydraHeadId: head.id,
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
