import { jest } from '@jest/globals';
import { generateHash } from '@/utils/crypto';

const mockUpsert = jest.fn(async () => ({ id: 'row-1' }));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		disputeDisclosure: {
			upsert: mockUpsert,
			findUnique: jest.fn(async () => null),
		},
	},
}));

jest.unstable_mockModule('@/utils/security/encryption', () => ({
	encrypt: (value: string) => `enc:${value}`,
	decrypt: (value: string) => value.replace(/^enc:/, ''),
}));

const { upsertDisputeInputData, upsertDisputeResultData } = await import('./storage');

describe('dispute disclosure storage', () => {
	beforeEach(() => {
		mockUpsert.mockClear();
	});

	it('stores input when hash matches', async () => {
		const data = 'hello-input';
		await upsertDisputeInputData({
			blockchainIdentifier: 'chain-1',
			data,
			expectedInputHash: generateHash(data),
		});
		expect(mockUpsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { blockchainIdentifier: 'chain-1' },
				create: expect.objectContaining({ encryptedInputData: 'enc:hello-input' }),
			}),
		);
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
		expect(mockUpsert).toHaveBeenCalledWith(
			expect.objectContaining({
				update: expect.objectContaining({ encryptedResultData: 'enc:hello-result' }),
			}),
		);
	});
});
