import { createHash } from 'node:crypto';
import { prisma } from '@masumi/payment-core/db';
import { Prisma } from '@/generated/prisma/client';

function digestForRevealSignature(input: { signature: string; key: string; blockchainIdentifier: string }): string {
	return createHash('sha256').update(`${input.blockchainIdentifier}\0${input.key}\0${input.signature}`).digest('hex');
}

export type MarkRevealSignatureResult = { status: 'recorded' } | { status: 'idempotent' } | { status: 'rejected' };

export async function markRevealSignatureUsed(input: {
	signature: string;
	key: string;
	blockchainIdentifier: string;
	validUntil: number;
}): Promise<MarkRevealSignatureResult> {
	const digest = digestForRevealSignature(input);
	try {
		await prisma.revealSignatureUsage.create({
			data: {
				digest,
				validUntil: new Date(input.validUntil),
			},
		});
		return { status: 'recorded' };
	} catch (error) {
		if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
			const existing = await prisma.revealSignatureUsage.findUnique({
				where: { digest },
			});
			if (existing != null && existing.validUntil.getTime() >= Date.now()) {
				return { status: 'idempotent' };
			}
			return { status: 'rejected' };
		}
		throw error;
	}
}

export async function pruneExpiredRevealSignatureUsage(): Promise<number> {
	const result = await prisma.revealSignatureUsage.deleteMany({
		where: { validUntil: { lt: new Date() } },
	});
	return result.count;
}
