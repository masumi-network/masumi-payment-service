// OpenAPI docs for the running release against the newest published one.
import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';
import { releaseStatusOutput } from '@/routes/api/release-status';

const RELEASE_EXAMPLE = {
	version: '0.29.0-5-gabc1234',
	commit: 'abc1234',
	tag: '0.29.0',
	commitsAhead: 5,
	dirty: false,
	updateAvailable: true,
};

export function registerReleaseStatusPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	registry.registerPath({
		method: 'get',
		path: '/release-status',
		summary: 'Compare the running release with the newest published one.',
		description:
			'Reports the release this service and each Hydra Host were built from, and the newest release published on GitHub. The GitHub check runs at most once every six hours. A failed check reports `latest` as null with the reason in `checkError`; it never reports a build as up to date. Hosts are listed only for an admin key, as of their last Check.',
		tags: ['health'],
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: successResponse('Release status', releaseStatusOutput, {
				latest: {
					version: '0.30.0',
					url: 'https://github.com/masumi-network/masumi-payment-service/releases/tag/0.30.0',
					publishedAt: '2026-10-15T12:00:00Z',
				},
				checkedAt: '2026-10-17T10:00:00.000Z',
				checkError: null,
				service: RELEASE_EXAMPLE,
				hosts: [{ id: 'cuid_v2_auto_generated', name: 'hydra1', network: 'Mainnet', release: RELEASE_EXAMPLE }],
			}),
			401: { description: 'Unauthorized' },
		},
	});
}
