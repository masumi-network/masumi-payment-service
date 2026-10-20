import { prisma } from '@masumi/payment-core/db';
import { AuthContext } from '@masumi/payment-core/auth';
import { HotWalletType, Network, OnChainState, PaymentSourceType } from '@/generated/prisma/client';
import createHttpError from 'http-errors';
import { logger } from '@masumi/payment-core/logger';
import { assertCanUploadDisclosureInput, assertCanUploadDisclosureResult } from './upload-authorization';

export type DisputedRequestKind = 'payment' | 'purchase';

export type DisputedRequestRow = {
	kind: DisputedRequestKind;
	blockchainIdentifier: string;
	inputHash: string;
	resultHash: string | null;
	smartContractWalletId: string | null;
	requestedById: string;
	/** Selling hot wallet for purchase disputes; null for payment disputes. */
	sellerHotWalletId: string | null;
};

export type DisclosureUploadSide = 'input' | 'result';

const v2SourceFilterActive = {
	paymentSourceType: PaymentSourceType.Web3CardanoV2,
	deletedAt: null,
};

function disputedFilter(blockchainIdentifier: string, network: Network) {
	return {
		blockchainIdentifier,
		onChainState: OnChainState.Disputed,
		PaymentSource: {
			network,
			...v2SourceFilterActive,
		},
	} as const;
}

async function mapPurchaseRow(purchase: {
	blockchainIdentifier: string;
	inputHash: string;
	resultHash: string | null;
	smartContractWalletId: string | null;
	requestedById: string;
	paymentSourceId: string;
	SellerWallet: { walletVkey: string };
}): Promise<DisputedRequestRow> {
	return {
		kind: 'purchase',
		blockchainIdentifier: purchase.blockchainIdentifier,
		inputHash: purchase.inputHash,
		resultHash: purchase.resultHash,
		smartContractWalletId: purchase.smartContractWalletId,
		requestedById: purchase.requestedById,
		sellerHotWalletId: await resolveSellerHotWalletId({
			paymentSourceId: purchase.paymentSourceId,
			sellerWalletVkey: purchase.SellerWallet.walletVkey,
		}),
	};
}

function mapPaymentRow(payment: {
	blockchainIdentifier: string;
	inputHash: string;
	resultHash: string | null;
	smartContractWalletId: string | null;
	requestedById: string;
}): DisputedRequestRow {
	return {
		kind: 'payment',
		blockchainIdentifier: payment.blockchainIdentifier,
		inputHash: payment.inputHash,
		resultHash: payment.resultHash,
		smartContractWalletId: payment.smartContractWalletId,
		requestedById: payment.requestedById,
		sellerHotWalletId: payment.smartContractWalletId,
	};
}

async function loadDisputedPurchaseRow(params: {
	blockchainIdentifier: string;
	network: Network;
}): Promise<DisputedRequestRow | null> {
	const purchase = await prisma.purchaseRequest.findFirst({
		where: disputedFilter(params.blockchainIdentifier, params.network),
		include: { SellerWallet: true },
	});
	if (purchase == null) {
		return null;
	}
	return mapPurchaseRow(purchase);
}

async function loadDisputedPaymentRow(params: {
	blockchainIdentifier: string;
	network: Network;
}): Promise<DisputedRequestRow | null> {
	const payment = await prisma.paymentRequest.findFirst({
		where: disputedFilter(params.blockchainIdentifier, params.network),
	});
	if (payment == null) {
		return null;
	}
	return mapPaymentRow(payment);
}

export async function loadDisputedV2RequestCandidates(params: {
	blockchainIdentifier: string;
	network: Network;
}): Promise<DisputedRequestRow[]> {
	const [purchaseRow, paymentRow] = await Promise.all([
		loadDisputedPurchaseRow(params),
		loadDisputedPaymentRow(params),
	]);
	return [paymentRow, purchaseRow].filter((row): row is DisputedRequestRow => row != null);
}

function pickAuthorizedDisputedRow(
	authorized: DisputedRequestRow[],
	side: DisclosureUploadSide,
): DisputedRequestRow {
	if (authorized.length === 1) {
		return authorized[0];
	}
	if (side === 'result') {
		const withResultHash = authorized.filter((row) => row.resultHash != null);
		if (withResultHash.length === 1) {
			return withResultHash[0];
		}
		if (withResultHash.length > 1) {
			return withResultHash.find((row) => row.kind === 'payment') ?? withResultHash[0];
		}
	}
	return authorized.find((row) => row.kind === 'payment') ?? authorized[0];
}

function httpStatus(error: unknown): number | null {
	if (typeof error !== 'object' || error == null || !('statusCode' in error)) {
		return null;
	}
	const statusCode = error.statusCode;
	return typeof statusCode === 'number' ? statusCode : null;
}

export function selectAuthorizedDisputedRow(
	candidates: DisputedRequestRow[],
	ctx: AuthContext,
	side: DisclosureUploadSide,
): DisputedRequestRow {
	if (candidates.length === 0) {
		throw createHttpError(404, 'Disputed V2 payment or purchase not found');
	}

	const authorized = candidates.filter((row) => {
		try {
			if (side === 'input') {
				assertCanUploadDisclosureInput(ctx, row);
			} else {
				assertCanUploadDisclosureResult(ctx, row);
			}
			return true;
		} catch (error) {
			const status = httpStatus(error);
			if (status === 403 || status === 503) {
				return false;
			}
			throw error;
		}
	});

	if (authorized.length >= 1) {
		return pickAuthorizedDisputedRow(authorized, side);
	}

	for (const row of candidates) {
		if (side === 'input') {
			assertCanUploadDisclosureInput(ctx, row);
		} else {
			assertCanUploadDisclosureResult(ctx, row);
		}
	}

	throw createHttpError(403, 'Not authorized to upload disclosure for this request');
}

export async function findDisputedV2RequestForUpload(
	params: {
		blockchainIdentifier: string;
		network: Network;
	},
	ctx: AuthContext,
	side: DisclosureUploadSide,
): Promise<DisputedRequestRow> {
	const candidates = await loadDisputedV2RequestCandidates(params);
	return selectAuthorizedDisputedRow(candidates, ctx, side);
}

/** @deprecated Use findDisputedV2RequestForUpload for upload routes. */
export async function findDisputedV2Request(params: {
	blockchainIdentifier: string;
	network: Network;
}): Promise<DisputedRequestRow | null> {
	const candidates = await loadDisputedV2RequestCandidates(params);
	if (candidates.length === 0) {
		return null;
	}
	return candidates.find((row) => row.kind === 'payment') ?? candidates[0];
}

export async function resolveSellerHotWalletId(params: {
	paymentSourceId: string;
	sellerWalletVkey: string;
}): Promise<string | null> {
	const sellingWallets = await prisma.hotWallet.findMany({
		where: {
			paymentSourceId: params.paymentSourceId,
			type: HotWalletType.Selling,
			deletedAt: null,
			walletVkey: params.sellerWalletVkey,
		},
		orderBy: { createdAt: 'asc' },
		select: { id: true },
		take: 2,
	});
	if (sellingWallets.length === 0) {
		return null;
	}
	if (sellingWallets.length > 1) {
		logger.warn('Multiple selling hot wallets share seller walletVkey; using oldest', {
			paymentSourceId: params.paymentSourceId,
			sellerWalletVkey: params.sellerWalletVkey,
		});
	}
	return sellingWallets[0].id;
}

const disputedV2RowFilter = (blockchainIdentifier: string) => ({
	blockchainIdentifier,
	onChainState: OnChainState.Disputed,
	PaymentSource: v2SourceFilterActive,
});

type DisputedCountClient = Pick<typeof prisma, 'paymentRequest' | 'purchaseRequest'>;

export async function countActiveDisputedV2Rows(
	blockchainIdentifier: string,
	client: DisputedCountClient = prisma,
): Promise<number> {
	const [paymentCount, purchaseCount] = await Promise.all([
		client.paymentRequest.count({
			where: disputedV2RowFilter(blockchainIdentifier),
		}),
		client.purchaseRequest.count({
			where: disputedV2RowFilter(blockchainIdentifier),
		}),
	]);
	return paymentCount + purchaseCount;
}

export async function assertRequestStillDisputed(
	blockchainIdentifier: string,
	client: DisputedCountClient = prisma,
): Promise<void> {
	if ((await countActiveDisputedV2Rows(blockchainIdentifier, client)) === 0) {
		throw createHttpError(409, 'Dispute is no longer in Disputed state');
	}
}
