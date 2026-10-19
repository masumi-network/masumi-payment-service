import { AuthContext } from '@masumi/payment-core/auth';
import createHttpError from 'http-errors';
import { DisputedRequestRow } from './lookup';

function sellerHasWalletScope(ctx: AuthContext, smartContractWalletId: string | null): boolean {
	if (smartContractWalletId == null || ctx.walletScopeIds == null) {
		return false;
	}
	return ctx.walletScopeIds.includes(smartContractWalletId);
}

export function assertCanUploadDisclosureInput(ctx: AuthContext, target: DisputedRequestRow): void {
	if (ctx.canAdmin) {
		return;
	}
	if (target.kind === 'purchase') {
		if (target.requestedById === ctx.id) {
			return;
		}
		if (sellerHasWalletScope(ctx, target.smartContractWalletId)) {
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
		if (sellerHasWalletScope(ctx, target.smartContractWalletId)) {
			return;
		}
		throw createHttpError(403, 'Not authorized to upload result disclosure for this request');
	}
	if (target.requestedById === ctx.id) {
		return;
	}
	throw createHttpError(403, 'Not authorized to upload result disclosure for this request');
}
