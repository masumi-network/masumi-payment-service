import { prisma } from '@/utils/db';
import { logInfo, logError } from '@/utils/logs';
import { fileURLToPath } from 'node:url';

export async function checkRegistryData() {
  try {
    const recentRegistrations = await prisma.registryRequest.count({
      where: {
        updatedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // Last 24 hours
      },
    });

    logInfo('=== Registry Diagnostic Report ===', {
      component: 'diagnostic',
      operation: 'registry_check',
    });
    logInfo(`Found ${recentRegistrations} registry requests in last 24 hours`, {
      component: 'diagnostic',
      operation: 'registry_check',
    });

    if (recentRegistrations > 0) {
      logInfo('\nRecent Registry Requests:', {
        component: 'diagnostic',
        operation: 'registry_check',
      });

      const stateCounts = await prisma.registryRequest.groupBy({
        by: ['state'],
        _count: true,
      });

      logInfo('State Distribution:', {
        component: 'diagnostic',
        operation: 'registry_check',
      });
      Object.entries(stateCounts).forEach(([state, count]) => {
        logInfo(`  ${state}: ${count._count}`, {
          component: 'diagnostic',
          operation: 'registry_check',
        });
      });
    } else {
      logInfo(
        'No recent registry requests found. Try creating a registration first.',
        { component: 'diagnostic', operation: 'registry_check' },
      );
    }

    logInfo('\n=== All Registry States ===', {
      component: 'diagnostic',
      operation: 'registry_check',
    });
    const allRegistrations = await prisma.registryRequest.groupBy({
      by: ['state'],
      _count: true,
    });

    return {
      recentCount: recentRegistrations,
      recent: recentRegistrations,
      allStates: Object.entries(allRegistrations).map(([state, count]) => ({
        state,
        count: count._count,
      })),
    };
  } catch (error) {
    logError(
      'Error in diagnostic',
      { component: 'diagnostic', operation: 'registry_check' },
      {},
      error instanceof Error ? error : new Error(String(error)),
    );
    return null;
  }
}

// Check if this file is being run directly (ES module equivalent of require.main === module)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void checkRegistryData().then(() => {
    process.exit(0);
  });
}
