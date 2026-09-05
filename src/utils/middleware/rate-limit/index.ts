import { Middleware } from 'express-zod-api';
import createHttpError from 'http-errors';
import type { AuthContext } from '@masumi/payment-core/auth-middleware';
import { z } from '@masumi/payment-core/zod';

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

export type RateLimitConsumeResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export const createRateLimiter = ({ maxRequests, windowMs }: RateLimitOptions) => {
	const bucket = createRateLimitBucket();

	return {
		consume(key: string): RateLimitConsumeResult {
			const now = Date.now();

			if (bucket.size > 2048) {
				cleanupExpiredEntries(bucket, now);
			}

			const update = prepareRateLimitUpdate(bucket, key, now, maxRequests, windowMs);
			if (update.blockedUntil != null) {
				return {
					allowed: false,
					retryAfterSeconds: Math.max(1, Math.ceil((update.blockedUntil - now) / 1000)),
				};
			}

			if (update.nextCounter != null) {
				bucket.set(key, update.nextCounter);
			}

			return { allowed: true };
		},
	};
};

export const createAuthenticatedRateLimitMiddleware = ({ maxRequests, windowMs }: RateLimitOptions) => {
	const limiter = createRateLimiter({ maxRequests, windowMs });

	return new Middleware<AuthContext, AuthContext, string, typeof rateLimitInputSchema>({
		input: rateLimitInputSchema,
		handler: async ({ ctx, response }) => {
			if (ctx.canAdmin) {
				return ctx;
			}

			const result = limiter.consume(ctx.id);
			if (!result.allowed) {
				response.setHeader('Retry-After', String(result.retryAfterSeconds));
				throw createHttpError(429, 'Too many requests');
			}

			return ctx;
		},
	});
};
