import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function seedWalletMonitoring() {
  console.log('🌱 Seeding wallet monitoring configurations...');

  try {
    // Get all active payment sources without monitoring config
    const paymentSources = await prisma.paymentSource.findMany({
      where: {
        deletedAt: null,
        WalletMonitorConfig: null,
      },
      include: {
        HotWallets: {
          where: { deletedAt: null },
        },
      },
    });

    if (paymentSources.length === 0) {
      console.log('✅ All payment sources already have monitoring config');
      return;
    }

    console.log(`📊 Found ${paymentSources.length} payment source(s) to seed`);

    let created = 0;
    let skipped = 0;

    for (const source of paymentSources) {
      // Skip if no hot wallets (nothing to monitor)
      if (source.HotWallets.length === 0) {
        console.log(
          `  ⊘ Skipped ${source.id} (${source.network}) - no hot wallets`,
        );
        skipped++;
        continue;
      }

      try {
        // Create config with thresholds in one transaction
        await prisma.$transaction(async (tx) => {
          const config = await tx.walletMonitorConfig.create({
            data: {
              paymentSourceId: source.id,
              enabled: false, // SAFE: disabled by default
              checkIntervalSeconds: 3600, // 1 hour
            },
          });

          // Create wallet thresholds
          await tx.walletThreshold.createMany({
            data: source.HotWallets.map((wallet) => ({
              hotWalletId: wallet.id,
              walletMonitorConfigId: config.id,
              enabled: true,
              adaThresholdLovelace: 10000000n, // 10 ADA default
            })),
          });
        });

        console.log(
          `  ✓ Created config for ${source.id} (${source.network}) with ${source.HotWallets.length} wallet(s)`,
        );
        created++;
      } catch (error) {
        console.error(
          `  ✗ Failed to create config for ${source.id}:`,
          error instanceof Error ? error.message : String(error),
        );
        // Continue with other payment sources
      }
    }

    console.log('\n✅ Seed complete!');
    console.log(`   Created: ${created}, Skipped: ${skipped}`);
    console.log(`   All configs are DISABLED by default (enable via SQL)`);
  } catch (error) {
    console.error('❌ Seed failed:', error);
    throw error;
  }
}

seedWalletMonitoring()
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
