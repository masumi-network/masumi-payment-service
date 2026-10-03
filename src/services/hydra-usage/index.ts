/**
 * Whether this deployment uses Hydra at all.
 *
 * Hydra adds thirteen scheduled jobs, eleven of them on the ten-second Hydra
 * interval. On a service that has never connected a node they find nothing,
 * every ten seconds, forever — several times the scheduler pressure of the
 * whole rest of the product, for a feature that is not in use.
 *
 * Asked rather than configured: Hydra is adopted by connecting a Host and
 * redeeming an invite, both of which happen while the service is running, so a
 * boot-time flag would need a restart to take effect and an env switch would be
 * one more thing to set before the feature works at all.
 *
 * Sticky once true. A head or a Host is not un-created in the normal course of
 * things, and the jobs are what settle a head that is being retired — going
 * quiet again the moment the last row disappears would stop the work that
 * finishes it.
 */

import { prisma } from '@masumi/payment-core/db';

/** Long enough that the check is noise next to the jobs, short enough that connecting a node takes effect while the operator is still looking at it. */
const USAGE_CACHE_MS = 30_000;

let cachedAt = 0;
let cachedInUse = false;

export function resetHydraUsageCache(): void {
	cachedAt = 0;
	cachedInUse = false;
}

export async function isHydraInUse(): Promise<boolean> {
	if (cachedInUse) return true;
	if (cachedAt !== 0 && Date.now() - cachedAt < USAGE_CACHE_MS) return false;

	// A Host with no heads still needs the invite and node-funding jobs: that is
	// exactly the state a service is in between connecting a node and opening
	// its first head.
	const [host, head] = await Promise.all([
		prisma.hydraHost.findFirst({ select: { id: true } }),
		prisma.hydraHead.findFirst({ select: { id: true } }),
	]);

	cachedAt = Date.now();
	cachedInUse = host !== null || head !== null;
	return cachedInUse;
}
