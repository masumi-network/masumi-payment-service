import { AuthContext } from '@masumi/payment-core/auth';
import createHttpError from 'http-errors';
import { DisputedRequestRow } from './lookup';

function hasWalletInScope(ctx: AuthContext, walletId: string | null): boolean {
	if (walletId == null || ctx.walletScopeIds == null) {
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
		if (hasWalletInScope(ctx, target.sellerHotWalletId)) {
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
