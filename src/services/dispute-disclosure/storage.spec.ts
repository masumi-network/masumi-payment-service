import { jest } from '@jest/globals';
import { generateHash } from '@/utils/crypto';

const mockCreate = jest.fn(async () => ({ id: 'row-1' }));
const mockUpdateMany = jest.fn(async () => ({ count: 0 }));
const mockFindUniqueOrThrow = jest.fn(async () => ({ id: 'row-1' }));

const prismaMock = {
	disputeDisclosure: {
		create: mockCreate,
		updateMany: mockUpdateMany,
		findUniqueOrThrow: mockFindUniqueOrThrow,
		findUnique: jest.fn(async () => null),
	},
	paymentRequest: {
		count: jest.fn(async () => 1),
	},
	purchaseRequest: {
		count: jest.fn(async () => 0),
	},
	$transaction: jest.fn(async (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock)),
};

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: prismaMock,
}));

jest.unstable_mockModule('@/utils/security/encryption', () => ({
	encrypt: (value: string) => `enc:${value}`,
	decrypt: (value: string) => value.replace(/^enc:/, ''),
}));

const { upsertDisputeInputData, upsertDisputeResultData } = await import('./storage');

describe('dispute disclosure storage', () => {
	beforeEach(() => {
		mockCreate.mockClear();
		mockUpdateMany.mockClear();
		mockFindUniqueOrThrow.mockClear();
		mockCreate.mockResolvedValue({ id: 'row-1' });
	});

	it('stores input when hash matches', async () => {
		const data = 'hello-input';
		await upsertDisputeInputData({
			blockchainIdentifier: 'chain-1',
			data,
			expectedInputHash: generateHash(data),
		});
		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					blockchainIdentifier: 'chain-1',
					encryptedInputData: 'enc:hello-input',
				}),
			}),
		);
	});

	it('rejects input when dispute is no longer Disputed', async () => {
		prismaMock.paymentRequest.count.mockResolvedValueOnce(0);
		prismaMock.purchaseRequest.count.mockResolvedValueOnce(0);
		const data = 'hello-input';
		await expect(
			upsertDisputeInputData({
				blockchainIdentifier: 'chain-1',
				data,
				expectedInputHash: generateHash(data),
			}),
		).rejects.toMatchObject({ statusCode: 409 });
		expect(mockCreate).not.toHaveBeenCalled();
	});

	it('rejects input when hash mismatches', async () => {
		await expect(
			upsertDisputeInputData({
				blockchainIdentifier: 'chain-1',
				data: 'hello-input',
				expectedInputHash: '0'.repeat(64),
			}),
		).rejects.toMatchObject({ statusCode: 400 });
	});

	it('stores result when hash matches', async () => {
		const data = 'hello-result';
		await upsertDisputeResultData({
			blockchainIdentifier: 'chain-1',
			data,
			expectedResultHash: generateHash(data),
		});
		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ encryptedResultData: 'enc:hello-result' }),
			}),
		);
	});
});
