import { prisma } from '@/utils/db';
import { logInfo, logError } from '@/utils/logs';

export async function checkRegistryData() {
  try {
    const recentRegistrations = await prisma.registryRequest.findMany({
      where: {
        updatedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // Last 24 hours
      },
      include: {
        PaymentSource: {
          select: { network: true, id: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    });

    logInfo('=== Registry Diagnostic Report ===', {
      component: 'diagnostic',
      operation: 'registry_check',
    });
    logInfo(
      `Found ${recentRegistrations.length} registry requests in last 24 hours`,
      { component: 'diagnostic', operation: 'registry_check' },
    );

    if (recentRegistrations.length > 0) {
      logInfo('\nRecent Registry Requests:', {
        component: 'diagnostic',
        operation: 'registry_check',
      });
      recentRegistrations.forEach((reg, index) => {
        logInfo(`${index + 1}. ID: ${reg.id}`, {
          component: 'diagnostic',
          operation: 'registry_check',
        });
        logInfo(`   State: ${reg.state}`, {
          component: 'diagnostic',
          operation: 'registry_check',
        });
        logInfo(`   Updated: ${reg.updatedAt.toISOString()}`, {
          component: 'diagnostic',
          operation: 'registry_check',
        });
        logInfo(`   Network: ${reg.PaymentSource?.network || 'unknown'}`, {
          component: 'diagnostic',
          operation: 'registry_check',
        });
        logInfo('', { component: 'diagnostic', operation: 'registry_check' });
      });

      const stateCounts = recentRegistrations.reduce(
        (acc, reg) => {
          acc[reg.state] = (acc[reg.state] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );

      logInfo('State Distribution:', {
        component: 'diagnostic',
        operation: 'registry_check',
      });
      Object.entries(stateCounts).forEach(([state, count]) => {
        logInfo(`  ${state}: ${count}`, {
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
    const allRegistrations = await prisma.registryRequest.findMany({
      select: { state: true },
      distinct: ['state'],
    });

    logInfo('States found in database:', {
      component: 'diagnostic',
      operation: 'registry_check',
    });
    allRegistrations.forEach((reg) => {
      logInfo(`  - ${reg.state}`, {
        component: 'diagnostic',
        operation: 'registry_check',
      });
    });

    return {
      recentCount: recentRegistrations.length,
      recent: recentRegistrations,
      allStates: allRegistrations.map((r) => r.state),
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

if (require.main === module) {
  void checkRegistryData().then(() => {
    process.exit(0);
  });
}
