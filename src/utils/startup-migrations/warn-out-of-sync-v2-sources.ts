import { PaymentSourceType } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { classifyV2SourceSync, defaultV2ContractParams } from '@/utils/v2-contract-sync';

/**
 * Read-only startup check (NOT a migration): flag active Web3CardanoV2 payment
 * sources that are on an OUTDATED on-chain contract version (registry policyId
 * mismatch — see `classifyV2SourceSync`). Their agents are invisible to the
 * current registry policy and their baked-in payment address is stale.
 *
 * This only warns; it never mutates. Stale-DEFAULT sources are repointed by the
 * migration `20260704120000_repoint_retired_default_v2_sources`; genuinely-CUSTOM
 * sources (admins != defaults) are left for this warning + the frontend badge and
 * must be repointed manually via `scripts/replace-v2-payment-source.ts` (see
 * `docs/migrations/v2-contract-cip30-upgrade.md`) — their correct new address
 * derives from their own admin wallets, and locked funds at the old address need
 * the old validator to spend.
 */
export async function warnOutOfSyncV2PaymentSources(): Promise<void> {
	const sources = await prisma.paymentSource.findMany({
		where: { deletedAt: null, paymentSourceType: PaymentSourceType.Web3CardanoV2 },
		select: { id: true, network: true, policyId: true, smartContractAddress: true },
	});

	const outdated: typeof sources = [];
	for (const source of sources) {
		const status = classifyV2SourceSync(source);
		if (status === 'outdated_contract') {
			outdated.push(source);
			const expected = defaultV2ContractParams(source.network);
			logger.warn(
				'V2 payment source is on an OUTDATED contract version (registry policyId mismatch). Agents under it are ' +
					'invisible to the current registry policy and its baked-in payment address is stale. Re-seed or run ' +
					'scripts/replace-v2-payment-source.ts (see docs/migrations/v2-contract-cip30-upgrade.md).',
				{
					paymentSourceId: source.id,
					network: source.network,
					policyId: source.policyId,
					expectedPolicyId: expected?.policyId,
					smartContractAddress: source.smartContractAddress,
					expectedSmartContractAddress: expected?.smartContractAddress,
				},
			);
		}
	}

	if (outdated.length > 0) {
		logger.warn(
			`${outdated.length} of ${sources.length} active V2 payment source(s) are on an outdated contract version.`,
		);
	}
}
