import { readAuthenticatedEndpointFactory, type AuthContext } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { Network } from '@/generated/prisma/client';
import { getReleaseStatus } from '@/services/release/release-status';

export const describedReleaseSchema = z
	.object({
		version: z.string().nullable().describe('`git describe` form, e.g. 0.29.0-5-gabc1234, or a bare tag'),
		commit: z.string().nullable(),
		tag: z.string().nullable().describe('Release tag the build starts from'),
		commitsAhead: z.number().int().nullable().describe('Commits on top of the tag; 0 for the tag itself'),
		dirty: z.boolean(),
	})
	.openapi('DescribedRelease');

const releaseWithUpdateSchema = describedReleaseSchema
	.extend({
		updateAvailable: z
			.boolean()
			.nullable()
			.describe('Null when it cannot be told: no latest release known, or a build without a release tag'),
	})
	.openapi('ReleaseWithUpdate');

export const releaseStatusInput = z.object({});

export const releaseStatusOutput = z.object({
	latest: z
		.object({ version: z.string(), url: z.string(), publishedAt: z.string().nullable() })
		.nullable()
		.describe('Newest published release, including pre-releases. Null when not checked yet.'),
	checkedAt: z.string().nullable().describe('When GitHub last answered'),
	checkError: z.string().nullable().describe('Why the last check failed, when it did'),
	service: releaseWithUpdateSchema,
	hosts: z
		.array(
			z.object({ id: z.string(), name: z.string(), network: z.nativeEnum(Network), release: releaseWithUpdateSchema }),
		)
		.describe('Hydra Hosts, as of their last probe. Empty for a key without admin access.'),
});

export const releaseStatusGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: releaseStatusInput,
	output: releaseStatusOutput,
	handler: async ({ ctx }: { ctx: AuthContext }) => getReleaseStatus(ctx.canAdmin ? ctx.networkLimit : []),
});
