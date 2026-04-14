import { Middleware } from 'express-zod-api';
import createHttpError from 'http-errors';
import type { AuthContext } from '@/utils/middleware/auth-middleware';
import { z } from '@/utils/zod-openapi';

type RateLimitCounter = {
	count: number;
	resetAt: number;
};

type PendingRateLimitUpdate = {
	blockedUntil: number | null;
	nextCounter: RateLimitCounter | null;
};

type RateLimitOptions = {
	maxRequests: number;
	windowMs: number;
};

const rateLimitInputSchema = z.object({});

const createRateLimitBucket = () => new Map<string, RateLimitCounter>();

const cleanupExpiredEntries = (bucket: Map<string, RateLimitCounter>, now: number) => {
	for (const [key, value] of bucket.entries()) {
		if (value.resetAt <= now) {
			bucket.delete(key);
		}
	}
};

const prepareRateLimitUpdate = (
	bucket: Map<string, RateLimitCounter>,
	key: string,
	now: number,
	maxRequests: number,
	windowMs: number,
): PendingRateLimitUpdate => {
	const current = bucket.get(key);
	if (current == null || current.resetAt <= now) {
		return {
			blockedUntil: null,
			nextCounter: {
				count: 1,
				resetAt: now + windowMs,
			},
		};
	}

	if (current.count >= maxRequests) {
		return {
			blockedUntil: current.resetAt,
			nextCounter: null,
		};
	}

	return {
		blockedUntil: null,
		nextCounter: {
			count: current.count + 1,
			resetAt: current.resetAt,
		},
	};
};

export const createAuthenticatedRateLimitMiddleware = ({ maxRequests, windowMs }: RateLimitOptions) => {
	const apiKeyBucket = createRateLimitBucket();

	return new Middleware<AuthContext, Record<string, never>, string, typeof rateLimitInputSchema>({
		input: rateLimitInputSchema,
		handler: async ({ ctx, response }) => {
			if (ctx.canAdmin) {
				return {};
			}

			const now = Date.now();

			if (apiKeyBucket.size > 2048) {
				cleanupExpiredEntries(apiKeyBucket, now);
			}

			const apiKeyUpdate = prepareRateLimitUpdate(apiKeyBucket, ctx.id, now, maxRequests, windowMs);
			const blockedUntil = apiKeyUpdate.blockedUntil ?? 0;

			if (blockedUntil > 0) {
				const retryAfterSeconds = Math.max(1, Math.ceil((blockedUntil - now) / 1000));
				response.setHeader('Retry-After', String(retryAfterSeconds));
				throw createHttpError(429, 'Too many requests');
			}

			if (apiKeyUpdate.nextCounter != null) {
				apiKeyBucket.set(ctx.id, apiKeyUpdate.nextCounter);
			}

			return {};
		},
	});
};
