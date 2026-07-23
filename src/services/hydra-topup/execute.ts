import createHttpError from 'http-errors';
import { HydraErrorType, HydraHeadStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import {
	buildValidatedHydraCommit,
	HydraCommitFlowError,
	HydraTransactionType,
	interpretCardanoTxSubmitResult,
	selectCommitUtxos,
	selectCommitUtxosUpToTarget,
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
import { buildHydraCommitFlowDeps } from '@/routes/api/hydra/head/commit-flow-deps';
import { recordHeadError, verifyPersistedHydraHeadOnChain } from '@/routes/api/hydra/head';

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export type ExecuteHydraTopupParams = {
	headId: string;
	/** Which plain wallet UTxOs to draw from. */
	filter: CommitUtxoFilter;
	/**
	 * Bound the top-up to the minimal whole-UTxO set reaching this amount of the
	 * given asset (auto-topup). Omit to commit every matching UTxO (manual top-up).
	 */
	target?: { unit: string; amount: bigint } | null;
};

export type ExecuteHydraTopupResult = {
	headId: string;
	topupId: string;
	depositTxHash: string;
	confirmed: boolean;
	committedLovelace: bigint;
	committedAssets: Record<string, string>;
};

/**
 * Core repeatable incremental-commit (top-up) flow shared by the /hydra/head/topup
 * endpoint and the automatic low-balance top-up. Loads + independently verifies
 * the Open head, selects wallet UTxOs (optionally bounded to a target amount),
 * builds/validates/signs the deposit through the shared commit-flow path, then
 * reserves + submits it and reconciles once against L1. Throws http-errors with
 * meaningful status codes; the caller decides how to surface them.
 */
export async function executeHydraTopup(params: ExecuteHydraTopupParams): Promise<ExecuteHydraTopupResult> {
	const head = await prisma.hydraHead.findUnique({
		where: { id: params.headId },
		include: { LocalParticipant: true },
	});

	if (!head) throw createHttpError(404, 'Hydra head not found');
	if (!head.isEnabled) throw createHttpError(409, 'Cannot top up a disabled Hydra head');
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

		// Reconcile any prior pending top-up first; only one Pending deposit per
		// participant is permitted, so refuse a new one while an earlier could land.
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
		if (utxos.length === 0) throw createHttpError(400, 'Local participant wallet has no L1 UTxOs available to top up');

		const { commitUtxos } = params.target
			? selectCommitUtxosUpToTarget(utxos, params.filter, params.target)
			: selectCommitUtxos(utxos, params.filter);
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
			committedLovelace,
			committedAssets,
		};
	} catch (error) {
		await recordHeadError(head.id, head.status, HydraErrorType.CommandFailed, error, 'Topup');
		throw error;
	}
}
