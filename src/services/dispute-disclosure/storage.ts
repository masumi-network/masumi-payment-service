import { prisma } from '@masumi/payment-core/db';
import { Prisma } from '@/generated/prisma/client';
import { encrypt, decrypt } from '@/utils/security/encryption';
import { logger } from '@masumi/payment-core/logger';
import { generateHash } from '@/utils/crypto';
import createHttpError from 'http-errors';
import { assertRequestStillDisputed } from './lookup';

const MAX_DISCLOSURE_BYTES = 2_000_000;

function assertDisclosureSize(data: string, field: string) {
	const byteLength = Buffer.byteLength(data, 'utf8');
	if (byteLength > MAX_DISCLOSURE_BYTES) {
		throw createHttpError(400, `${field} exceeds maximum allowed size`);
	}
}

export async function upsertDisputeInputData(params: {
	blockchainIdentifier: string;
	data: string;
	expectedInputHash: string;
	uploaderId?: string;
}) {
	assertDisclosureSize(params.data, 'inputData');
	const providedHash = generateHash(params.data);
	if (providedHash.toLowerCase() !== params.expectedInputHash.toLowerCase()) {
		throw createHttpError(400, 'Provided input data does not match expected hash');
	}

	const encryptedInputData = encrypt(params.data);

	return prisma.$transaction(async (tx) => {
		await assertRequestStillDisputed(params.blockchainIdentifier, tx);

		logger.info('Dispute disclosure input upsert', {
			blockchainIdentifier: params.blockchainIdentifier,
			uploaderId: params.uploaderId,
		});

		try {
			return await tx.disputeDisclosure.create({
				data: {
					blockchainIdentifier: params.blockchainIdentifier,
					encryptedInputData,
				},
			});
		} catch (error) {
			if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
				throw error;
			}
			const updated = await tx.disputeDisclosure.updateMany({
				where: {
					blockchainIdentifier: params.blockchainIdentifier,
					encryptedInputData: null,
				},
				data: { encryptedInputData },
			});
			if (updated.count === 0) {
				throw createHttpError(409, 'Input disclosure is already stored');
			}
			return tx.disputeDisclosure.findUniqueOrThrow({
				where: { blockchainIdentifier: params.blockchainIdentifier },
			});
		}
	});
}

export async function upsertDisputeResultData(params: {
	blockchainIdentifier: string;
	data: string;
	expectedResultHash: string;
	uploaderId?: string;
}) {
	assertDisclosureSize(params.data, 'resultData');
	const providedHash = generateHash(params.data);
	if (providedHash.toLowerCase() !== params.expectedResultHash.toLowerCase()) {
		throw createHttpError(400, 'Provided result data does not match expected hash');
	}

	const encryptedResultData = encrypt(params.data);

	return prisma.$transaction(async (tx) => {
		await assertRequestStillDisputed(params.blockchainIdentifier, tx);

		logger.info('Dispute disclosure result upsert', {
			blockchainIdentifier: params.blockchainIdentifier,
			uploaderId: params.uploaderId,
		});

		try {
			return await tx.disputeDisclosure.create({
				data: {
					blockchainIdentifier: params.blockchainIdentifier,
					encryptedResultData,
				},
			});
		} catch (error) {
			if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
				throw error;
			}
			const updated = await tx.disputeDisclosure.updateMany({
				where: {
					blockchainIdentifier: params.blockchainIdentifier,
					encryptedResultData: null,
				},
				data: { encryptedResultData },
			});
			if (updated.count === 0) {
				throw createHttpError(409, 'Result disclosure is already stored');
			}
			return tx.disputeDisclosure.findUniqueOrThrow({
				where: { blockchainIdentifier: params.blockchainIdentifier },
			});
		}
	});
}

export async function readDisputeDisclosurePlaintext(blockchainIdentifier: string) {
	const row = await prisma.disputeDisclosure.findUnique({
		where: { blockchainIdentifier },
	});
	if (row == null) {
		return {
			inputData: null as string | null,
			resultData: null as string | null,
			decryptFailed: false,
		};
	}

	const inputData = decryptDisclosureField(row.encryptedInputData, 'input', blockchainIdentifier);
	const resultData = decryptDisclosureField(row.encryptedResultData, 'result', blockchainIdentifier);
	const decryptFailed =
		(row.encryptedInputData != null && inputData === null) || (row.encryptedResultData != null && resultData === null);

	return {
		inputData,
		resultData,
		decryptFailed,
	};
}

function decryptDisclosureField(
	encrypted: string | null,
	field: 'input' | 'result',
	blockchainIdentifier: string,
): string | null {
	if (encrypted == null) {
		return null;
	}
	try {
		return decrypt(encrypted);
	} catch (error) {
		logger.error('Failed to decrypt dispute disclosure field', {
			blockchainIdentifier,
			field,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}
