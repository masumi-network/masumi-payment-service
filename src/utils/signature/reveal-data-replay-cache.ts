import { createHash } from 'node:crypto';
import { prisma } from '@masumi/payment-core/db';
import { Prisma } from '@/generated/prisma/client';

function digestForRevealSignature(input: { signature: string; key: string; blockchainIdentifier: string }): string {
	return createHash('sha256').update(`${input.blockchainIdentifier}\0${input.key}\0${input.signature}`).digest('hex');
}

export async function markRevealSignatureUsed(input: {
	signature: string;
	key: string;
	blockchainIdentifier: string;
	validUntil: number;
}): Promise<boolean> {
	const digest = digestForRevealSignature(input);
	try {
		await prisma.revealSignatureUsage.create({
			data: {
				digest,
				validUntil: new Date(input.validUntil),
			},
		});
		return true;
	} catch (error) {
		if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
			return false;
		}
		throw error;
	}
}
