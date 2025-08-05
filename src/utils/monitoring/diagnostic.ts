import { prisma } from '@/utils/db';

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

    console.log('=== Registry Diagnostic Report ===');
    console.log(
      `Found ${recentRegistrations.length} registry requests in last 24 hours`,
    );

    if (recentRegistrations.length > 0) {
      console.log('\nRecent Registry Requests:');
      recentRegistrations.forEach((reg, index) => {
        console.log(`${index + 1}. ID: ${reg.id}`);
        console.log(`   State: ${reg.state}`);
        console.log(`   Updated: ${reg.updatedAt.toISOString()}`);
        console.log(`   Network: ${reg.PaymentSource?.network || 'unknown'}`);
        console.log('');
      });

      const stateCounts = recentRegistrations.reduce(
        (acc, reg) => {
          acc[reg.state] = (acc[reg.state] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );

      console.log('State Distribution:');
      Object.entries(stateCounts).forEach(([state, count]) => {
        console.log(`  ${state}: ${count}`);
      });
    } else {
      console.log(
        'No recent registry requests found. Try creating a registration first.',
      );
    }

    console.log('\n=== All Registry States ===');
    const allRegistrations = await prisma.registryRequest.findMany({
      select: { state: true },
      distinct: ['state'],
    });

    console.log('States found in database:');
    allRegistrations.forEach((reg) => {
      console.log(`  - ${reg.state}`);
    });

    return {
      recentCount: recentRegistrations.length,
      recent: recentRegistrations,
      allStates: allRegistrations.map((r) => r.state),
    };
  } catch (error) {
    console.error('Error in diagnostic:', error);
    return null;
  }
}

if (require.main === module) {
  void checkRegistryData().then(() => {
    process.exit(0);
  });
}
