import { Pool } from 'pg';
import { Network, HotWalletType } from '@/generated/prisma/enums';

/**
 * Helper functions for querying PaymentSource data in E2E tests
 * 
 * Note: Uses raw pg queries instead of Prisma ORM because the Prisma-generated
 * client has ESM syntax that is incompatible with Jest's globalSetup execution
 * context (which runs in CommonJS mode). This is a Prisma v7 + Jest limitation.
 */

function createPool(): Pool {
  return new Pool({
    connectionString: process.env.DATABASE_URL!,
  });
}

/**
 * Get the active smart contract address for a given network
 */
export async function getActiveSmartContractAddress(
  network: Network,
): Promise<string> {
  const pool = createPool();

  try {
    const result = await pool.query(
      `SELECT "smartContractAddress", "id" 
       FROM "PaymentSource" 
       WHERE "network" = $1 AND "deletedAt" IS NULL 
       ORDER BY "createdAt" DESC 
       LIMIT 1`,
      [network],
    );

    if (result.rows.length === 0) {
      throw new Error(
        `No active PaymentSource found for network ${network}. Please run database seeding first.`,
      );
    }

    return result.rows[0].smartContractAddress;
  } finally {
    await pool.end();
  }
}

/**
 * Get an active wallet VKey for testing by wallet type and network
 */
export async function getActiveWalletVKey(
  network: Network,
  walletType: HotWalletType = HotWalletType.Selling,
): Promise<string> {
  const pool = createPool();

  try {
    const result = await pool.query(
      `SELECT hw."walletVkey", hw."walletAddress", hw."type"
       FROM "HotWallet" hw
       INNER JOIN "PaymentSource" ps ON hw."paymentSourceId" = ps."id"
       WHERE hw."type" = $1 
         AND hw."deletedAt" IS NULL 
         AND ps."network" = $2 
         AND ps."deletedAt" IS NULL
       ORDER BY hw."createdAt" DESC 
       LIMIT 1`,
      [walletType, network],
    );

    if (result.rows.length === 0) {
      throw new Error(
        `No active ${walletType} wallet found for network ${network}. Please run database seeding first.`,
      );
    }

    console.log(
      `✅ Found active ${walletType} wallet for ${network}: ${result.rows[0].walletVkey}`,
    );

    return result.rows[0].walletVkey;
  } catch (error) {
    console.error('❌ Error querying active wallet VKey:', error);
    throw error;
  } finally {
    await pool.end();
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
