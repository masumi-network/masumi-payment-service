import { HotWalletType, type Prisma } from '@/generated/prisma/client';
import { logger } from '@masumi/payment-core/logger';

/**
 * Report an initial lock on L1 that has no local purchase row.
 *
 * Every lock on the payment contract reaches the purchase side, whoever the
 * buyer is, so on a node that did not buy the job this is the normal case:
 * every lock a seller-only node sees takes this path. That stays at debug.
 *
 * When the lock's buyer key is one of this node's purchasing wallets, it is
 * not normal: this node locked funds for a purchase it has no record of
 * (the row was deleted, or never committed), and nothing else will notice.
 *
 * Call it after the sync transaction, not inside it: this log-only wallet read
 * would add HotWallet to that Serializable read set and conflict with the
 * batchers, which write HotWallet locks all the time. It never throws, so a
 * failed lookup cannot hold up the rest of the sync.
 */
export async function reportInitialLockWithoutPurchaseRow(
	db: Pick<Prisma.TransactionClient, 'hotWallet'>,
	details: { txHash: string; paymentSourceId: string; blockchainIdentifier: string; buyerVkey: string },
): Promise<void> {
	let ownBuyerWallet: { id: string } | null;
	try {
		// Any payment source and network, deleted wallets included: the same key
		// is the same signer, so a lock it made is ours wherever it was registered.
		ownBuyerWallet = await db.hotWallet.findFirst({
			where: { walletVkey: details.buyerVkey, type: HotWalletType.Purchasing },
			select: { id: true },
		});
	} catch (error) {
		logger.warn('tx-sync: could not check whether a lock without a purchase row is ours', { ...details, error });
		return;
	}
	if (ownBuyerWallet == null) {
		logger.debug('tx-sync: initial purchase output belongs to another buyer', details);
		return;
	}
	logger.error('tx-sync: this node locked funds for a purchase it has no local row for', {
		...details,
		hotWalletId: ownBuyerWallet.id,
	});
}
