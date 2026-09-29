import createHttpError from 'http-errors';
import { HotWalletType, PaymentSourceType, Prisma } from '@/generated/prisma/client';
import type { AuthContext } from '@masumi/payment-core/auth';
import { CONFIG } from '@masumi/payment-core/config';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { z } from '@masumi/payment-core/zod';
import {
	ExchainRegistrationError,
	inspectGuardedWallet,
	registerGuardedWalletWithExchain,
	type GuardedWalletParams,
	type GuardedWalletState,
} from '@masumi/payment-source-v2/smart-wallet/guarded-wallet';
import { convertNetwork } from '@/utils/converter/network-convert';
import { buildHotWalletScopeFilter } from '@/utils/shared/wallet-scope';
import type { getGuardedWalletSchemaOutput, postGuardedWalletSchemaInput } from './schemas';

type AttachInput = z.infer<typeof postGuardedWalletSchemaInput>;
type Scope = Pick<AuthContext, 'networkLimit' | 'walletScopeIds'>;

/** The hot wallet a guarded wallet may attach to: a live Purchasing wallet on a V2 source this key can see. */
async function loadPurchasingHotWallet(hotWalletId: string, scope: Scope) {
	const hotWallet = await prisma.hotWallet.findFirst({
		where: {
			id: hotWalletId,
			deletedAt: null,
			PaymentSource: { network: { in: scope.networkLimit }, deletedAt: null },
			...buildHotWalletScopeFilter(scope.walletScopeIds),
		},
		include: { PaymentSource: { include: { PaymentSourceConfig: true } }, GuardedWallet: true },
	});
	if (hotWallet == null) throw createHttpError(404, 'Hot wallet not found');
	return hotWallet;
}

function describeChainError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function attachGuardedWallet(input: AttachInput, scope: Scope) {
	const hotWallet = await loadPurchasingHotWallet(input.hotWalletId, scope);
	if (hotWallet.type !== HotWalletType.Purchasing) {
		throw createHttpError(400, 'Only a Purchasing hot wallet can be guarded');
	}
	if (hotWallet.PaymentSource.paymentSourceType !== PaymentSourceType.Web3CardanoV2) {
		throw createHttpError(400, 'Guarded wallets need a V2 payment source');
	}
	if (hotWallet.GuardedWallet != null) throw createHttpError(409, 'This hot wallet is already guarded');
	// A batch in flight was packed as unguarded; attaching now would not stop it locking from the hot wallet key.
	if (hotWallet.lockedAt != null || hotWallet.pendingTransactionId != null) {
		throw createHttpError(409, 'The hot wallet is busy with a transaction; retry once it is unlocked');
	}

	const params: GuardedWalletParams = {
		ownerAddress: input.ownerAddress,
		quorumVkhs: input.quorumVkhs,
		threshold: input.threshold,
		stateTokenName: input.stateTokenName,
		network: convertNetwork(hotWallet.PaymentSource.network),
	};
	let state: GuardedWalletState;
	try {
		state = await inspectGuardedWallet(params, hotWallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey);
	} catch (error) {
		throw createHttpError(409, `The smart wallet could not be verified on chain: ${describeChainError(error)}`);
	}
	if (state.agentVkh !== hotWallet.walletVkey) {
		throw createHttpError(409, "The smart wallet's agent key is not this hot wallet's key");
	}

	let exchainWalletId = input.exchainWalletId ?? null;
	let mandateEnglish: string | null = null;
	if (input.register != null) {
		const { EXCHAIN_COSIGN_URL, EXCHAIN_NODE_TOKEN, EXCHAIN_NODE_ID, EXCHAIN_ORG_ID } = CONFIG;
		if (EXCHAIN_COSIGN_URL == null || EXCHAIN_NODE_TOKEN == null || EXCHAIN_NODE_ID == null || EXCHAIN_ORG_ID == null) {
			throw createHttpError(503, 'Exchain co-signing is not configured on this node');
		}
		if (BigInt(input.register.mandate.daily) !== state.periodLimitLovelace) {
			throw createHttpError(
				400,
				`The mandate's daily limit must equal the wallet's on-chain period limit (${state.periodLimitLovelace} lovelace)`,
			);
		}
		try {
			const registered = await registerGuardedWalletWithExchain({
				baseUrl: EXCHAIN_COSIGN_URL,
				token: EXCHAIN_NODE_TOKEN,
				nodeId: EXCHAIN_NODE_ID,
				orgId: EXCHAIN_ORG_ID,
				wallet: { ...params, scriptAddress: state.scriptAddress, policyId: state.policyId },
				agentVkhs: [state.agentVkh],
				escrowAddresses: [hotWallet.PaymentSource.smartContractAddress],
				mandate: input.register.mandate,
				// Real purchases name registered agents, so Exchain may check them against the registry.
				registryGate: true,
			});
			exchainWalletId = registered.walletId;
			mandateEnglish = registered.mandateEnglish;
		} catch (error) {
			if (!(error instanceof ExchainRegistrationError)) throw error;
			logger.warn('Exchain refused a guarded wallet registration', { hotWalletId: hotWallet.id, status: error.status });
			throw createHttpError(502, error.message);
		}
	}

	try {
		const record = await prisma.guardedWallet.create({
			data: {
				hotWalletId: hotWallet.id,
				ownerAddress: input.ownerAddress,
				quorumVkhs: input.quorumVkhs,
				threshold: input.threshold,
				stateTokenName: input.stateTokenName,
				scriptAddress: state.scriptAddress,
				policyId: state.policyId,
				exchainWalletId,
			},
		});
		return { ...record, mandateEnglish };
	} catch (error) {
		if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
			throw createHttpError(409, 'This hot wallet is already guarded');
		}
		throw error;
	}
}

export async function detachGuardedWallet(hotWalletId: string, scope: Scope) {
	const hotWallet = await loadPurchasingHotWallet(hotWalletId, scope);
	if (hotWallet.GuardedWallet == null) throw createHttpError(404, 'This hot wallet is not guarded');
	// A batch in flight holds the lock; detaching now would change how it must be signed.
	if (hotWallet.lockedAt != null || hotWallet.pendingTransactionId != null) {
		throw createHttpError(409, 'The hot wallet is busy with a transaction; retry once it is unlocked');
	}
	return prisma.guardedWallet.delete({ where: { hotWalletId: hotWallet.id } });
}

export async function getGuardedWallet(
	hotWalletId: string,
	scope: Scope,
): Promise<z.infer<typeof getGuardedWalletSchemaOutput>> {
	const hotWallet = await loadPurchasingHotWallet(hotWalletId, scope);
	const guarded = hotWallet.GuardedWallet;
	if (guarded == null) return { guardedWallet: null, chain: null, chainError: null };
	try {
		const state = await inspectGuardedWallet(
			{
				ownerAddress: guarded.ownerAddress,
				quorumVkhs: guarded.quorumVkhs,
				threshold: guarded.threshold,
				stateTokenName: guarded.stateTokenName,
				network: convertNetwork(hotWallet.PaymentSource.network),
			},
			hotWallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
		);
		return {
			guardedWallet: guarded,
			chain: {
				lovelace: state.lovelace.toString(),
				periodLimitLovelace: state.periodLimitLovelace.toString(),
				spentInPeriodLovelace: state.spentInPeriodLovelace.toString(),
				periodStart: new Date(Number(state.periodStartMs)),
				periodLengthMs: state.periodLengthMs.toString(),
				minBalanceLovelace: state.minBalanceLovelace.toString(),
			},
			chainError: null,
		};
	} catch (error) {
		return { guardedWallet: guarded, chain: null, chainError: describeChainError(error) };
	}
}

/** The Exchain wallet id registered for a guarded hot wallet, or null. */
export async function exchainWalletIdFor(hotWalletId: string, scope: Scope): Promise<string | null> {
	const hotWallet = await loadPurchasingHotWallet(hotWalletId, scope);
	return hotWallet.GuardedWallet?.exchainWalletId ?? null;
}
