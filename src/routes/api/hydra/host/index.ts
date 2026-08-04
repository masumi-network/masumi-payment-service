/**
 * Hydra Host registry endpoints.
 *
 * Admin-only, like the rest of the Hydra surface. Tokens are write-only: they
 * go in encrypted and are never returned, because a Host token is the only
 * thing in front of a node API that has no authentication of its own.
 */

import { adminAuthenticatedEndpointFactory, type AuthContext } from '@masumi/payment-core/auth';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth-middleware';
import { z } from '@masumi/payment-core/zod';
import { HydraHostStatus, Network } from '@/generated/prisma/client';
import {
	deleteHydraHost,
	listHydraHosts,
	readHydraHostNetwork,
	refreshHydraHostCapabilities,
	registerHydraHost,
	updateHydraHost,
} from '@/services/hydra-host/registry';

export const hydraHostSchema = z
	.object({
		id: z.string(),
		createdAt: z.string(),
		updatedAt: z.string(),
		name: z.string(),
		network: z.nativeEnum(Network),
		baseUrl: z.string(),
		publicPeerHost: z.string(),
		/** Presence only — the token itself is never returned. */
		hasAdminToken: z.boolean(),
		hydraVersion: z.string().nullable(),
		scriptCatalogueHash: z.string().nullable(),
		ledgerParamsHash: z.string().nullable(),
		status: z.nativeEnum(HydraHostStatus),
		lastHealthAt: z.string().nullable(),
		lastHealthError: z.string().nullable(),
		participantCount: z.number(),
	})
	.openapi('HydraHost');

const tokenSchema = z
	.string()
	.min(32)
	.max(512)
	.describe('Opaque bearer token issued by the Hydra Host. Stored encrypted and never returned.');

export const listHydraHostsSchemaInput = z.object({
	network: z.nativeEnum(Network).optional().describe('Restrict to one network'),
});

export const listHydraHostsSchemaOutput = z.object({ hosts: z.array(hydraHostSchema) });

export const listHydraHostsGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: listHydraHostsSchemaInput,
	output: listHydraHostsSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof listHydraHostsSchemaInput>; ctx: AuthContext }) => {
		// An api key scoped to one network must not see hosts on another.
		const allowed = input.network ? ctx.networkLimit.filter((network) => network === input.network) : ctx.networkLimit;
		return { hosts: await listHydraHosts(allowed) };
	},
});

export const registerHydraHostSchemaInput = z.object({
	name: z.string().min(1).max(120).describe('Operator-facing label'),
	network: z.nativeEnum(Network),
	baseUrl: z
		.string()
		.max(250)
		.describe('Control-plane URL, e.g. https://hydra1.example.com. TLS terminates in front of the Host.'),
	publicPeerHost: z
		.string()
		.min(1)
		.max(250)
		.optional()
		.describe(
			'Hostname the counterparty dials for this head\u2019s peer port. Defaults to the host in baseUrl, which is right unless peers reach the Host by a different name than this service does.',
		),
	userToken: tokenSchema
		.optional()
		.describe(
			'Runtime token for proxied node API access. Optional: the admin token also satisfies runtime calls, so supply this only to keep a lower-privilege token for day-to-day use.',
		),
	adminToken: tokenSchema.describe(
		'Provision, escrow-ack, reconfigure, delete. Required: without it no head can be opened here.',
	),
});

export const registerHydraHostPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: registerHydraHostSchemaInput,
	output: hydraHostSchema,
	handler: async ({ input, ctx }: { input: z.infer<typeof registerHydraHostSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);
		return registerHydraHost(input);
	},
});

export const updateHydraHostSchemaInput = z.object({
	id: z.string(),
	name: z.string().min(1).max(120).optional(),
	status: z
		.nativeEnum(HydraHostStatus)
		.optional()
		.describe('Draining keeps serving existing heads (they cannot be moved) but takes no new placements'),
	userToken: tokenSchema.optional(),
	adminToken: tokenSchema.nullable().optional().describe('Null clears the admin token, disabling provisioning'),
});

export const updateHydraHostPatch = adminAuthenticatedEndpointFactory.build({
	method: 'patch',
	input: updateHydraHostSchemaInput,
	output: hydraHostSchema,
	handler: async ({ input, ctx }: { input: z.infer<typeof updateHydraHostSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, await readHydraHostNetwork(input.id));
		return updateHydraHost(input.id, input);
	},
});

export const deleteHydraHostSchemaInput = z.object({ id: z.string() });
export const deleteHydraHostSchemaOutput = z.object({ id: z.string() });

export const deleteHydraHostDelete = adminAuthenticatedEndpointFactory.build({
	method: 'delete',
	input: deleteHydraHostSchemaInput,
	output: deleteHydraHostSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof deleteHydraHostSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, await readHydraHostNetwork(input.id));
		await deleteHydraHost(input.id);
		return { id: input.id };
	},
});

export const checkHydraHostSchemaInput = z.object({ id: z.string() });

/**
 * Probe the Host and record what it reports. A failed probe marks the Host
 * `Unreachable` — which stops new placements — but never disturbs the heads
 * already on it, because a head cannot be moved.
 */
export const checkHydraHostPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: checkHydraHostSchemaInput,
	output: hydraHostSchema,
	handler: async ({ input, ctx }: { input: z.infer<typeof checkHydraHostSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, await readHydraHostNetwork(input.id));
		return refreshHydraHostCapabilities(input.id);
	},
});
