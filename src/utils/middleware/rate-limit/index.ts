import { Middleware } from 'express-zod-api';
import createHttpError from 'http-errors';
import type { AuthContext } from '@/utils/middleware/auth-middleware';
import { z } from '@/utils/zod-openapi';

type RateLimitCounter = {
	count: number;
	resetAt: number;
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

const checkAndIncrement = (
	bucket: Map<string, RateLimitCounter>,
	key: string,
	now: number,
	maxRequests: number,
	windowMs: number,
): number | null => {
	const current = bucket.get(key);
	if (current == null || current.resetAt <= now) {
		bucket.set(key, {
			count: 1,
			resetAt: now + windowMs,
		});
		return null;
	}

	if (current.count >= maxRequests) {
		return current.resetAt;
	}

	current.count += 1;
	bucket.set(key, current);
	return null;
};

export const createAuthenticatedRateLimitMiddleware = ({ maxRequests, windowMs }: RateLimitOptions) => {
	const apiKeyBucket = createRateLimitBucket();
	const ipBucket = createRateLimitBucket();

	return new Middleware<AuthContext, Record<string, never>, string, typeof rateLimitInputSchema>({
		input: rateLimitInputSchema,
		handler: async ({ ctx, request, response }) => {
			const now = Date.now();
			const sourceIp = request.ip || 'unknown';

			if (apiKeyBucket.size > 2048) {
				cleanupExpiredEntries(apiKeyBucket, now);
			}

			if (ipBucket.size > 2048) {
				cleanupExpiredEntries(ipBucket, now);
			}

			const apiKeyResetAt = checkAndIncrement(apiKeyBucket, ctx.id, now, maxRequests, windowMs);
			const ipResetAt = checkAndIncrement(ipBucket, sourceIp, now, maxRequests, windowMs);
			const blockedUntil = Math.max(apiKeyResetAt ?? 0, ipResetAt ?? 0);

			if (blockedUntil > 0) {
				const retryAfterSeconds = Math.max(1, Math.ceil((blockedUntil - now) / 1000));
				response.setHeader('Retry-After', String(retryAfterSeconds));
				throw createHttpError(429, 'Too many requests');
			}

			return {};
		},
	});
};
