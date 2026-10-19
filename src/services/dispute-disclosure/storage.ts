import { prisma } from '@masumi/payment-core/db';
import { encrypt, decrypt } from '@/utils/security/encryption';
import { logger } from '@masumi/payment-core/logger';
import { generateHash } from '@/utils/crypto';
import createHttpError from 'http-errors';

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
}) {
	assertDisclosureSize(params.data, 'inputData');
	const providedHash = generateHash(params.data);
	if (providedHash.toLowerCase() !== params.expectedInputHash.toLowerCase()) {
		throw createHttpError(400, 'Provided input data does not match expected hash');
	}

	return prisma.disputeDisclosure.upsert({
		where: { blockchainIdentifier: params.blockchainIdentifier },
		create: {
			blockchainIdentifier: params.blockchainIdentifier,
			encryptedInputData: encrypt(params.data),
		},
		update: {
			encryptedInputData: encrypt(params.data),
		},
	});
}

export async function upsertDisputeResultData(params: {
	blockchainIdentifier: string;
	data: string;
	expectedResultHash: string;
}) {
	assertDisclosureSize(params.data, 'resultData');
	const providedHash = generateHash(params.data);
	if (providedHash.toLowerCase() !== params.expectedResultHash.toLowerCase()) {
		throw createHttpError(400, 'Provided result data does not match expected hash');
	}

	return prisma.disputeDisclosure.upsert({
		where: { blockchainIdentifier: params.blockchainIdentifier },
		create: {
			blockchainIdentifier: params.blockchainIdentifier,
			encryptedResultData: encrypt(params.data),
		},
		update: {
			encryptedResultData: encrypt(params.data),
		},
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
