import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import createHttpError from 'http-errors';
import { HydraErrorType, HydraHeadStatus } from '@/generated/prisma/client';
import {
	buildValidatedHydraCommit,
	HydraCommitFlowError,
	interpretCardanoTxSubmitResult,
	selectCommitUtxos,
	HydraTransactionType,
	type CommitUtxoFilter,
} from '@/lib/hydra';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import { convertNetwork } from '@/utils/converter/network-convert';
import { resolveHydraL2EvidenceSlotConfig } from '@/utils/hydra/l2-slot-context';
import {
	HydraTopupReservationConflictError,
	reconcilePendingHydraTopup,
	reserveAndSubmitHydraTopup,
} from '@/services/hydra-topup-reconciliation';
import { buildHydraCommitFlowDeps } from './commit-flow-deps';
import { recordHeadError, verifyPersistedHydraHeadOnChain } from './index';

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const topupInput = z.object({
	headId: z.string().describe('The Hydra head to top up'),
	assetFilter: z
		.enum(['all', 'ada-only'])
		.optional()
		.default('all')
		.describe('Which plain wallet UTxOs to commit: all, or ADA-only (ignored when assetUnit is set)'),
	assetUnit: z
		.string()
		.regex(/^[0-9a-fA-F]{56,120}$/)
		.optional()
		.describe('Commit only UTxOs containing this native-asset unit (policyId + assetName hex)'),
});

export const topupOutput = z.object({
	headId: z.string(),
	topupId: z.string(),
	depositTxHash: z.string(),
	confirmed: z.boolean().describe('Whether the deposit is already confirmed on L1 by the independent observer'),
	committedLovelace: z.string(),
	committedAssets: z.record(z.string(), z.string()).describe('Committed native-asset amounts keyed by unit'),
});

/**
 * Repeatable incremental-commit (top-up) of additional funds into an already-Open
 * head. Unlike the one-shot initial commit, this can run many times; each call is
 * its own L1 deposit tracked in HydraTopup with per-deposit reconciliation. Draft
 * building, key-scoped input safety, validation and partial signing are shared
 * with the initial commit via buildValidatedHydraCommit.
 */
export const topupHeadPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: topupInput,
	output: topupOutput,
	handler: async ({ input }) => {
		const head = await prisma.hydraHead.findUnique({
			where: { id: input.headId },
			include: { LocalParticipant: true },
		});

		if (!head) throw createHttpError(404, 'Hydra head not found');
		if (!head.isEnabled) throw createHttpError(409, 'Cannot top up a disabled Hydra head');
		// Top-ups are incremental commits, only meaningful once the head is Open.
		if (head.status !== HydraHeadStatus.Open) {
			throw createHttpError(409, `Cannot top up: head status is ${head.status}, expected Open`);
		}
		const localParticipant = head.LocalParticipant;
		if (!localParticipant) throw createHttpError(400, 'Head has no local participant');
		if (!localParticipant.hasCommitted) {
			throw createHttpError(409, 'Local participant must complete its initial commit before topping up');
		}
		if (!head.headIdentifier) {
			throw createHttpError(409, 'Cannot top up before the Hydra head identifier has been observed');
		}

		const cm = getHydraConnectionManager();
		const hydraHead = cm.getHead(head.id);
		if (!hydraHead) throw createHttpError(502, 'No active connection to Hydra head');

		try {
			let verifiedHead: Awaited<ReturnType<typeof verifyPersistedHydraHeadOnChain>>;
			try {
				verifiedHead = await verifyPersistedHydraHeadOnChain(head.id);
			} catch (verificationError) {
				if (createHttpError.isHttpError(verificationError)) throw verificationError;
				throw createHttpError(502, `Refusing to sign for an unverified Hydra head: ${errorMessage(verificationError)}`);
			}

			const hotWallet = await prisma.hotWallet.findUniqueOrThrow({
				where: { id: localParticipant.walletId },
				include: { Secret: true, PaymentSource: { include: { PaymentSourceConfig: true } } },
			});
			const rpcProviderApiKey = hotWallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
			if (!rpcProviderApiKey) {
				throw createHttpError(500, 'Payment source has no RPC provider configured for the L1 top-up');
			}

			// A prior top-up may still be awaiting L1 confirmation. Reconcile it first;
			// only one Pending deposit per participant is permitted (partial unique
			// index), so refuse a new deposit while an earlier one could still land.
			const pending = await prisma.hydraTopup.findFirst({
				where: { hydraLocalParticipantId: localParticipant.id, status: 'Pending' },
				orderBy: { createdAt: 'desc' },
			});
			if (pending) {
				const reconciliation = await reconcilePendingHydraTopup({
					id: pending.id,
					status: pending.status,
					depositTxHash: pending.depositTxHash,
					invalidHereafterSlot: pending.invalidHereafterSlot,
					network: hotWallet.PaymentSource.network,
					rpcProviderApiKey,
				});
				if (reconciliation === 'pending') {
					throw createHttpError(409, 'A prior Hydra top-up remains pending independent L1 confirmation');
				}
				if (reconciliation === 'transient-error') {
					throw createHttpError(503, 'Could not reconcile the prior Hydra top-up against L1; retry shortly');
				}
			}

			const slotConfig = resolveHydraL2EvidenceSlotConfig(convertNetwork(hotWallet.PaymentSource.network));
			if (!slotConfig) throw createHttpError(500, 'Hydra L1 slot configuration is incomplete or invalid');

			const { wallet, utxos, vKey, blockchainProvider } = await generateWalletExtended(
				hotWallet.PaymentSource.network,
				rpcProviderApiKey,
				hotWallet.Secret.encryptedMnemonic,
			);
			if (utxos.length === 0)
				throw createHttpError(400, 'Local participant wallet has no L1 UTxOs available to top up');

			const filter: CommitUtxoFilter = input.assetUnit ? { unit: input.assetUnit } : input.assetFilter;
			const { commitUtxos } = selectCommitUtxos(utxos, filter);
			if (commitUtxos.length === 0) {
				throw createHttpError(400, 'No plain wallet UTxOs match the requested top-up asset filter');
			}

			let validatedDraft: Awaited<ReturnType<typeof buildValidatedHydraCommit>>;
			try {
				validatedDraft = await buildValidatedHydraCommit({
					commitUtxos,
					walletUtxos: utxos,
					walletPaymentKeyHash: vKey,
					expectedHeadId: verifiedHead.headIdentifier,
					slotConfig,
					deps: buildHydraCommitFlowDeps({
						hydraHead,
						wallet,
						blockchainProvider,
						walletId: localParticipant.walletId,
					}),
				});
			} catch (flowError) {
				if (flowError instanceof HydraCommitFlowError) {
					throw createHttpError(502, `Refusing unsafe Hydra top-up draft: ${flowError.message}`);
				}
				throw flowError;
			}

			const committedLovelace = validatedDraft.committedValue.get('lovelace') ?? 0n;
			const committedAssets: Record<string, string> = {};
			for (const [unit, quantity] of validatedDraft.committedValue) {
				if (unit !== 'lovelace') committedAssets[unit] = quantity.toString();
			}

			let submitResult: unknown;
			let topupId: string;
			try {
				({ topupId, submitResult } = await reserveAndSubmitHydraTopup(
					{
						hydraHeadId: head.id,
						hydraLocalParticipantId: localParticipant.id,
						depositTxHash: validatedDraft.txId,
						invalidHereafterSlot: validatedDraft.invalidHereafterSlot,
						committedLovelace,
						committedAssets,
					},
					async () =>
						await hydraHead.cardanoTransaction(
							{ type: HydraTransactionType.TxConwayEra, description: '', cborHex: validatedDraft.signedCommitTx },
							localParticipant.walletId,
						),
				));
			} catch (error) {
				if (error instanceof HydraTopupReservationConflictError) throw createHttpError(409, error.message);
				throw error;
			}

			const interpreted = interpretCardanoTxSubmitResult(submitResult);
			const reconciliation = await reconcilePendingHydraTopup({
				id: topupId,
				status: 'Pending',
				depositTxHash: validatedDraft.txId,
				invalidHereafterSlot: validatedDraft.invalidHereafterSlot,
				network: hotWallet.PaymentSource.network,
				rpcProviderApiKey,
			});

			if (!interpreted.ok && reconciliation !== 'confirmed') {
				// The node's rejection is not independent proof the tx never relayed;
				// the Pending row stays reserved for reconciliation.
				throw createHttpError(
					502,
					`Hydra node rejected the top-up tx submission; L1 reconciliation remains pending: ${interpreted.reason}`,
				);
			}

			await prisma.hydraHead.update({ where: { id: head.id }, data: { latestActivityAt: new Date() } });
			logger.info(`[HydraAPI] Top-up deposit submitted for head ${head.id}`, {
				topupId,
				depositTxHash: validatedDraft.txId,
				confirmed: reconciliation === 'confirmed',
			});

			return {
				headId: head.id,
				topupId,
				depositTxHash: validatedDraft.txId,
				confirmed: reconciliation === 'confirmed',
				committedLovelace: committedLovelace.toString(),
				committedAssets,
			};
		} catch (error) {
			await recordHeadError(head.id, head.status, HydraErrorType.CommandFailed, error, 'Topup');
			throw error;
		}
	},
});
