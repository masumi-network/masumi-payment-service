import { z } from '@masumi/payment-core/zod';
import { Network } from '@/generated/prisma/client';

/**
 * Stable identifiers for every readiness check. The admin UI keys its setup
 * steps off these, so they are part of the API contract: rename one and the
 * wizard silently stops finding the check. Add new ids at the end.
 */
export const RAIL_READINESS_CHECK_IDS = [
	// Cardano (V2)
	'cardano.payment_source',
	'cardano.contract_current',
	'cardano.rpc_provider',
	'cardano.admin_signatures',
	'cardano.selling_wallet',
	'cardano.purchasing_wallet',
	'cardano.payments_enabled',
	// x402 (EVM)
	'x402.enabled_chain',
	'x402.rpc_url',
	'x402.facilitator',
	'x402.selling_wallet',
	'x402.purchasing_wallet',
] as const;

export const RAIL_IDS = ['CardanoV2', 'X402'] as const;

const railReadinessCheckSchema = z.object({
	id: z.enum(RAIL_READINESS_CHECK_IDS).describe('Stable check identifier. The admin UI maps setup steps onto these'),
	label: z.string().describe('Short human-readable name for the check'),
	isComplete: z.boolean().describe('Whether the backend considers this check satisfied'),
	detail: z
		.string()
		.nullable()
		.describe('Why the check is incomplete, or extra context when it passes. Null when there is nothing to add'),
});

const cardanoPurchaseSourceReadinessSchema = z.object({
	policyId: z.string().nullable().describe('Registry policy id this configured V2 source can purchase from'),
	smartContractAddress: z.string().describe('V2 escrow contract address this configured source can purchase through'),
	isPurchaseReady: z.boolean().describe('Whether this exact policy and contract source can execute outbound purchases'),
	Checks: z
		.array(railReadinessCheckSchema)
		.describe('Buyer-direction checks for this source; selling-wallet readiness is intentionally excluded'),
});

const railReadinessSchema = z.object({
	rail: z.enum(RAIL_IDS).describe('Which payment rail this readiness block describes'),
	isReady: z
		.boolean()
		.describe(
			'Whether the rail can actually take payments right now. True only when every blocking check is complete — optional checks (e.g. outbound spending) do not affect it',
		),
	Checks: z.array(railReadinessCheckSchema).describe('Individual checks, in setup order'),
	PurchaseSources: z
		.array(cardanoPurchaseSourceReadinessSchema)
		.optional()
		.describe(
			'Per-source outbound purchase readiness for CardanoV2. Policy ids and contract addresses are public on-chain identifiers; secrets are never returned',
		),
});

export const railReadinessSchemaInput = z.object({
	network: z
		.nativeEnum(Network)
		.describe('Cardano environment to report on. x402 chains are grouped in by their testnet flag'),
});

export const railReadinessSchemaOutput = z
	.object({
		network: z.nativeEnum(Network).describe('The environment these results describe'),
		Rails: z.array(railReadinessSchema).describe('Readiness per payment rail'),
	})
	.openapi('RailReadiness');
