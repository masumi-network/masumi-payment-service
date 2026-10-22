import { AuthContext } from '@masumi/payment-core/auth';
import createHttpError from 'http-errors';
import { DisputedRequestRow } from './lookup';

function hasWalletInScope(ctx: AuthContext, walletId: string | null): boolean {
	if (ctx.walletScopeIds === null) {
		return true;
	}
	if (walletId == null) {
		return false;
	}
	return ctx.walletScopeIds.includes(walletId);
}

export function assertCanUploadDisclosureInput(ctx: AuthContext, target: DisputedRequestRow): void {
	if (ctx.canAdmin) {
		return;
	}
	if (target.kind === 'purchase') {
		if (target.requestedById === ctx.id) {
			return;
		}
		throw createHttpError(403, 'Not authorized to upload input disclosure for this request');
	}
	if (target.requestedById === ctx.id) {
		return;
	}
	throw createHttpError(403, 'Not authorized to upload input disclosure for this request');
}

export function assertCanUploadDisclosureResult(ctx: AuthContext, target: DisputedRequestRow): void {
	if (ctx.canAdmin) {
		return;
	}
	if (target.kind === 'purchase') {
		if (target.requestedById === ctx.id) {
			throw createHttpError(403, 'Buyer API key cannot upload result disclosure for this purchase');
		}
		if (target.sellerHotWalletId == null) {
			throw createHttpError(503, 'Seller hot wallet is not configured for this purchase payment source');
		}
		if (ctx.walletScopeIds === null) {
			throw createHttpError(403, 'Purchase result disclosure requires a seller-scoped API key');
		}
		if (hasWalletInScope(ctx, target.sellerHotWalletId)) {
			return;
		}
		throw createHttpError(403, 'Not authorized to upload result disclosure for this request');
	}
	if (target.requestedById === ctx.id) {
		return;
	}
	throw createHttpError(403, 'Not authorized to upload result disclosure for this request');
}
