import { PrismaClient, Network, HotWalletType } from '@prisma/client';

/**
 * Helper functions for querying PaymentSource data in E2E tests
 */

/**
 * Get the active smart contract address for a given network
 */
export async function getActiveSmartContractAddress(
  network: Network,
): Promise<string> {
  const prisma = new PrismaClient();

  try {
    const activePaymentSource = await prisma.paymentSource.findFirst({
      where: {
        network: network,
        deletedAt: null, // Not deleted
      },
      select: {
        smartContractAddress: true,
        id: true,
      },
      orderBy: {
        createdAt: 'desc', // Get the most recent one
      },
    });

    if (!activePaymentSource) {
      throw new Error(
        `No active PaymentSource found for network ${network}. Please run database seeding first.`,
      );
    }

    console.log(
      `✅ Found active PaymentSource for ${network}: ${activePaymentSource.smartContractAddress}`,
    );

    return activePaymentSource.smartContractAddress;
  } catch (error) {
    console.error('❌ Error querying active smart contract address:', error);
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
  const prisma = new PrismaClient();

  try {
    const wallet = await prisma.hotWallet.findFirst({
      where: {
        type: walletType,
        deletedAt: null,
        PaymentSource: {
          network: network,
          deletedAt: null,
        },
      },
      select: {
        walletVkey: true,
        walletAddress: true,
        type: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (!wallet) {
      throw new Error(
        `No active ${walletType} wallet found for network ${network}. Please run database seeding first.`,
      );
    }

    console.log(
      `✅ Found active ${walletType} wallet for ${network}: ${wallet.walletVkey}`,
    );

    return wallet.walletVkey;
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
