/**
 * The running release of this service and of each Hydra Host, against the
 * newest published release.
 */

import type { Network } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { getLatestRelease, type LatestRelease } from './latest-release';
import { describeRelease, isUpdateAvailable, readServiceRelease, type DescribedRelease } from './release-info';

export type ReleaseWithUpdate = DescribedRelease & {
	/** Null when it cannot be told: no latest release known, or no release tag on the build. */
	updateAvailable: boolean | null;
};

export type ReleaseStatus = {
	latest: LatestRelease | null;
	checkedAt: string | null;
	checkError: string | null;
	service: ReleaseWithUpdate;
	hosts: Array<{ id: string; name: string; network: Network; release: ReleaseWithUpdate }>;
};

function withUpdate(release: DescribedRelease, latest: LatestRelease | null): ReleaseWithUpdate {
	return { ...release, updateAvailable: isUpdateAvailable(release, latest?.version ?? null) };
}

/** `hostNetworks` empty means the caller may not see Hosts. */
export async function getReleaseStatus(hostNetworks: Network[]): Promise<ReleaseStatus> {
	const check = await getLatestRelease();
	const hosts =
		hostNetworks.length === 0
			? []
			: await prisma.hydraHost.findMany({
					where: { network: { in: hostNetworks } },
					select: { id: true, name: true, network: true, releaseVersion: true, releaseCommit: true },
					orderBy: [{ network: 'asc' }, { name: 'asc' }],
				});
	return {
		latest: check.latest,
		checkedAt: check.checkedAt,
		checkError: check.error,
		service: withUpdate(describeRelease(readServiceRelease()), check.latest),
		hosts: hosts.map((host) => ({
			id: host.id,
			name: host.name,
			network: host.network,
			release: withUpdate(describeRelease({ version: host.releaseVersion, commit: host.releaseCommit }), check.latest),
		})),
	};
}
