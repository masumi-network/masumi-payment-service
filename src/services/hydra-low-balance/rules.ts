import { HydraLowBalanceRule, LowBalanceStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { MIN_CARVE_LOVELACE } from '@/services/hydra-topup/pre-split';

export type SerializedHydraLowBalanceRule = {
	id: string;
	createdAt: string;
	updatedAt: string;
	hydraLocalParticipantId: string;
	assetUnit: string;
	thresholdAmount: string;
	enabled: boolean;
	topupEnabled: boolean;
	topupAmount: string | null;
	status: LowBalanceStatus;
	lastKnownAmount: string | null;
	lastCheckedAt: string | null;
	lastAlertedAt: string | null;
};

export function serializeHydraLowBalanceRule(rule: HydraLowBalanceRule): SerializedHydraLowBalanceRule {
	return {
		id: rule.id,
		createdAt: rule.createdAt.toISOString(),
		updatedAt: rule.updatedAt.toISOString(),
		hydraLocalParticipantId: rule.hydraLocalParticipantId,
		assetUnit: rule.assetUnit,
		thresholdAmount: rule.thresholdAmount.toString(),
		enabled: rule.enabled,
		topupEnabled: rule.topupEnabled,
		topupAmount: rule.topupAmount?.toString() ?? null,
		status: rule.status,
		lastKnownAmount: rule.lastKnownAmount?.toString() ?? null,
		lastCheckedAt: rule.lastCheckedAt?.toISOString() ?? null,
		lastAlertedAt: rule.lastAlertedAt?.toISOString() ?? null,
	};
}

/** 'lovelace', or a native-asset unit (policyId + assetName hex, 56–120 hex). */
function normalizeAssetUnit(assetUnit: string): string {
	const trimmed = assetUnit.trim();
	if (trimmed.toLowerCase() === 'lovelace') return 'lovelace';
	if (!/^[0-9a-fA-F]{56,120}$/.test(trimmed)) {
		throw createHttpError(400, 'assetUnit must be "lovelace" or a policyId+assetName hex string');
	}
	return trimmed.toLowerCase();
}

/**
 * Refused here rather than discovered every cycle.
 *
 * An automatic top-up carves its amount into an L1 UTxO of its own, and the
 * ledger refuses an output below the minimum its size costs. A lovelace rule
 * set under that floor cannot ever succeed: it fails after claiming the wallet,
 * writes a failed top-up and a head error, and does it again on the next cycle.
 * The operator setting the rule is the one who can fix it, and this is the only
 * moment they are here to be told.
 */
function assertTopupConfig(params: { assetUnit: string; topupEnabled: boolean; topupAmount: bigint | null }): void {
	if (!params.topupEnabled) return;
	if (params.topupAmount == null || params.topupAmount <= 0n) {
		throw createHttpError(400, 'topupAmount must be a positive amount when topupEnabled is set');
	}
	if (params.assetUnit === 'lovelace' && params.topupAmount < MIN_CARVE_LOVELACE) {
		throw createHttpError(
			400,
			`topupAmount must be at least ${MIN_CARVE_LOVELACE} lovelace: a smaller top-up cannot be carved into its own UTxO`,
		);
	}
}

async function assertParticipantExists(hydraLocalParticipantId: string): Promise<void> {
	const participant = await prisma.hydraLocalParticipant.findUnique({
		where: { id: hydraLocalParticipantId },
		select: { id: true },
	});
	if (!participant) throw createHttpError(404, 'Hydra local participant not found');
}

export async function listHydraLowBalanceRules(
	hydraLocalParticipantId?: string,
): Promise<SerializedHydraLowBalanceRule[]> {
	const rules = await prisma.hydraLowBalanceRule.findMany({
		where: hydraLocalParticipantId ? { hydraLocalParticipantId } : {},
		orderBy: { createdAt: 'desc' },
	});
	return rules.map(serializeHydraLowBalanceRule);
}

export async function upsertHydraLowBalanceRule(params: {
	hydraLocalParticipantId: string;
	assetUnit: string;
	thresholdAmount: bigint;
	enabled?: boolean;
	topupEnabled?: boolean;
	topupAmount?: bigint | null;
}): Promise<SerializedHydraLowBalanceRule> {
	const assetUnit = normalizeAssetUnit(params.assetUnit);
	if (params.thresholdAmount <= 0n) throw createHttpError(400, 'thresholdAmount must be a positive amount');
	const topupEnabled = params.topupEnabled ?? false;
	const topupAmount = params.topupAmount ?? null;
	assertTopupConfig({ assetUnit, topupEnabled, topupAmount });
	await assertParticipantExists(params.hydraLocalParticipantId);

	// Re-arm the state machine on every (re)configuration so the next crossing of
	// the new threshold produces a fresh alert.
	const rule = await prisma.hydraLowBalanceRule.upsert({
		where: {
			hydraLocalParticipantId_assetUnit: {
				hydraLocalParticipantId: params.hydraLocalParticipantId,
				assetUnit,
			},
		},
		create: {
			hydraLocalParticipantId: params.hydraLocalParticipantId,
			assetUnit,
			thresholdAmount: params.thresholdAmount,
			enabled: params.enabled ?? true,
			topupEnabled,
			topupAmount,
			status: LowBalanceStatus.Unknown,
		},
		update: {
			thresholdAmount: params.thresholdAmount,
			enabled: params.enabled ?? true,
			topupEnabled,
			topupAmount,
			status: LowBalanceStatus.Unknown,
			lastAlertedAt: null,
		},
	});
	return serializeHydraLowBalanceRule(rule);
}

export async function deleteHydraLowBalanceRule(id: string): Promise<void> {
	try {
		await prisma.hydraLowBalanceRule.delete({ where: { id } });
	} catch {
		throw createHttpError(404, 'Hydra low-balance rule not found');
	}
}
