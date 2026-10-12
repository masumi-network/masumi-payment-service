/**
 * Recovering an unabsorbed Hydra deposit when the head's node is gone.
 *
 * The node's `DELETE /commits/{txId}` is the normal path, but a closed, disabled
 * or quarantined head has no live node, and the deposit would stay at the
 * deposit script. The deposit validator does not need the node: `Recover` checks
 * only the deadline and that the outputs recreate the committed UTxOs (hydra
 * 2.4.1 `deposit.ak`), so a hot wallet of this service posts the recover itself
 * and pays its fee. The funds go back to the addresses that committed them.
 */

import createHttpError from 'http-errors';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { DepositDatumError } from '@masumi/payment-source-v2/hydra-deposit/deposit-datum';
import { DepositNotRecoverableError, recoverDepositOnL1 } from '@masumi/payment-source-v2/hydra-deposit/recover-tx';
import { lookupConfirmedChainTx } from '@/services/shared/chain-tx-lookup';
import { convertNetwork } from '@/utils/converter/network-convert';
import { claimHotWalletForL1, releaseHotWalletAfterL1 } from '@/utils/db/hot-wallet-lock';
import { resolveHydraL2EvidenceSlotConfig } from '@/utils/hydra/l2-slot-context';
import { decrypt } from '@/utils/security/encryption';

const CONFIRM_POLL_MS = 15_000;
// Room for Blockfrost to index a recover that landed in its last valid slot.
// Absent after its expiry plus this, the recover can no longer land.
const EXPIRY_GRACE_MS = 5 * 60 * 1000;

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Post the recover of `depositTxHash` with `hotWalletId` paying the fee.
 * Returns the recover transaction hash once it is submitted.
 */
export async function recoverDepositWithoutNode(params: {
	hotWalletId: string;
	depositTxHash: string;
	/** The head's on-chain id. The deposit datum must name it. */
	headIdentifier: string | null;
}): Promise<{ recoverTxHash: string }> {
	const hotWallet = await prisma.hotWallet.findUnique({
		where: { id: params.hotWalletId },
		select: {
			Secret: { select: { encryptedMnemonic: true } },
			PaymentSource: { select: { network: true, PaymentSourceConfig: { select: { rpcProviderApiKey: true } } } },
		},
	});
	if (hotWallet == null) throw createHttpError(404, 'The wallet that pays the recovery fee was not found');
	const network = convertNetwork(hotWallet.PaymentSource.network);
	const slotConfig = resolveHydraL2EvidenceSlotConfig(network);
	if (slotConfig == null) throw createHttpError(500, 'Hydra L1 slot configuration is incomplete or invalid');
	const rpcApiKey = hotWallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey;

	await claimHotWalletForL1(params.hotWalletId, 'deposit recovery');
	// Set from a callback, so it lives in an object TypeScript does not narrow.
	const signed: { txHash: string | null; validUntilMs: number } = { txHash: null, validUntilMs: 0 };
	try {
		const { txHash, validUntilMs } = await recoverDepositOnL1({
			rpcApiKey,
			network,
			slotConfig,
			depositTxHash: params.depositTxHash,
			expectedHeadId: params.headIdentifier ?? undefined,
			mnemonic: decrypt(hotWallet.Secret.encryptedMnemonic).split(' '),
			onSigned: (recover) => {
				signed.txHash = recover.txHash;
				signed.validUntilMs = recover.validUntilMs;
				return Promise.resolve();
			},
		});
		logger.info('Posted an L1 recover of a Hydra deposit without the node', {
			depositTxHash: params.depositTxHash,
			recoverTxHash: txHash,
		});
		releaseOnceSettled({
			walletId: params.hotWalletId,
			txHash,
			validUntilMs,
			network: hotWallet.PaymentSource.network,
			rpcApiKey,
		});
		return { recoverTxHash: txHash };
	} catch (error) {
		if (signed.txHash != null) {
			// A submit with no clear answer may still land: keep the wallet until it settles.
			releaseOnceSettled({
				walletId: params.hotWalletId,
				txHash: signed.txHash,
				validUntilMs: signed.validUntilMs,
				network: hotWallet.PaymentSource.network,
				rpcApiKey,
			});
			throw createHttpError(
				502,
				`The recover ${signed.txHash} was signed but its submit failed: ${describeError(error)}. Check that transaction before retrying`,
			);
		}
		await releaseHotWalletAfterL1(params.hotWalletId);
		if (error instanceof DepositNotRecoverableError || error instanceof DepositDatumError) {
			throw createHttpError(409, error.message);
		}
		throw createHttpError(502, `Could not recover the deposit on L1: ${describeError(error)}`);
	}
}

/**
 * Release the fee wallet once the recover is on chain, or once it has expired
 * without landing. Until then a batcher could build over its fee inputs. If the
 * process stops first, the stale-lock sweep frees the wallet.
 */
function releaseOnceSettled(watch: {
	walletId: string;
	txHash: string;
	validUntilMs: number;
	network: Parameters<typeof lookupConfirmedChainTx>[0]['network'];
	rpcApiKey: string;
}): void {
	const { walletId, txHash } = watch;
	void (async () => {
		for (;;) {
			// Unref: a pending watch never holds a shutting-down process open.
			await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS).unref());
			const result = await lookupConfirmedChainTx({
				network: watch.network,
				rpcProviderApiKey: watch.rpcApiKey,
				txHash,
				requiredConfirmations: 1,
			});
			if (result === 'confirmed-valid' || result === 'confirmed-invalid') break;
			if (Date.now() > watch.validUntilMs + EXPIRY_GRACE_MS) {
				if (result === 'not-found') break;
				logger.warn('An L1 deposit recover is unsettled past its expiry; the stale-lock sweep frees its wallet', {
					txHash,
					result,
				});
				return;
			}
		}
		await releaseHotWalletAfterL1(walletId);
	})().catch((error: unknown) => {
		logger.warn('Watching an L1 deposit recover failed; the stale-lock sweep frees its wallet', {
			txHash,
			error: describeError(error),
		});
	});
}
