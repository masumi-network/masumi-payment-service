import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Network, HotWalletType } from '@prisma/client';



// Create a PrismaClient instance with the pg adapter (required for Prisma v7)
function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL!;
  const pool = new Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

/**
 * Get the active smart contract address for a given network
 */
export async function getActiveSmartContractAddress(
  network: Network,
): Promise<string> {
  const prisma = createPrismaClient();

  try {
    const paymentSource = await prisma.paymentSource.findFirst({
      where: {
        network: network,
        deletedAt: null,
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        smartContractAddress: true,
        id: true,
      },
    });

    if (!paymentSource) {
      throw new Error(
        `No active PaymentSource found for network ${network}. Please run database seeding first.`,
      );
    }

    return paymentSource.smartContractAddress;
  } catch (error) {
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Get an active wallet VKey for testing by wallet type and network
 */
export async function getActiveWalletVKey(
  network: Network,
  walletType: HotWalletType = HotWalletType.Selling,
): Promise<string> {
  const prisma = createPrismaClient();

  try {
    const hotWallet = await prisma.hotWallet.findFirst({
      where: {
        type: walletType,
        deletedAt: null,
        PaymentSource: {
          network: network,
          deletedAt: null,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        walletVkey: true,
        walletAddress: true,
        type: true,
      },
    });

    if (!hotWallet) {
      throw new Error(
        `No active ${walletType} wallet found for network ${network}. Please run database seeding first.`,
      );
    }

    console.log(
      `✅ Found active ${walletType} wallet for ${network}: ${hotWallet.walletVkey}`,
    );

    return hotWallet.walletVkey;
  } catch (error) {
    console.error('❌ Error querying active wallet VKey:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Get test wallet configuration dynamically from database
 */
export async function getTestWalletFromDatabase(
  network: Network,
  role: 'seller' | 'buyer',
): Promise<{
  name: string;
  vkey: string;
  description: string;
}> {
  const walletType =
    role === 'seller' ? HotWalletType.Selling : HotWalletType.Purchasing;

  try {
    const vkey = await getActiveWalletVKey(network, walletType);

    return {
      name: `Dynamic ${role} wallet (${network})`,
      vkey: vkey,
      description: `Dynamically retrieved ${role} wallet for ${network} e2e tests`,
    };
  } catch (error) {
    throw new Error(`Failed to get ${role} wallet for ${network}: ${error}`);
  }
}

export default {
  getActiveSmartContractAddress,
  getActiveWalletVKey,
  getTestWalletFromDatabase,
};
