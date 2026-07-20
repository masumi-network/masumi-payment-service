import { describe, expect, it } from '@jest/globals';
import {
	listAvailableNetworksSchemaOutput,
	reconcilePaymentSchemaInput,
	upsertNetworkSchemaInput,
	x402PaymentAttemptSchema,
} from './schemas';

const txHash = `0x${'a'.repeat(64)}`;

describe('x402 reconciliation input', () => {
	it('requires txHash when settled', () => {
		expect(reconcilePaymentSchemaInput.safeParse({ attemptId: 'attempt-1', resolution: 'settled' }).success).toBe(
			false,
		);
		expect(
			reconcilePaymentSchemaInput.safeParse({ attemptId: 'attempt-1', resolution: 'settled', txHash }).success,
		).toBe(true);
	});

	it('forbids txHash when failed', () => {
		expect(reconcilePaymentSchemaInput.safeParse({ attemptId: 'attempt-1', resolution: 'failed' }).success).toBe(true);
		expect(
			reconcilePaymentSchemaInput.safeParse({ attemptId: 'attempt-1', resolution: 'failed', txHash }).success,
		).toBe(false);
	});
});

describe('x402 network input', () => {
	const baseNetwork = {
		caip2Id: 'eip155:8453',
		displayName: 'Base',
		rpcUrl: 'https://mainnet.base.org',
	};

	it('requires HTTPS for a remote facilitator', () => {
		expect(
			upsertNetworkSchemaInput.safeParse({
				...baseNetwork,
				facilitatorUrl: 'https://facilitator.example',
			}).success,
		).toBe(true);
		expect(
			upsertNetworkSchemaInput.safeParse({
				...baseNetwork,
				facilitatorUrl: 'http://facilitator.example',
			}).success,
		).toBe(false);
	});

	it('limits RPC URLs to HTTP transports', () => {
		expect(upsertNetworkSchemaInput.safeParse(baseNetwork).success).toBe(true);
		expect(
			upsertNetworkSchemaInput.safeParse({
				...baseNetwork,
				rpcUrl: 'ftp://rpc.example',
			}).success,
		).toBe(false);
	});
});

describe('x402 available network output', () => {
	it('strips operator-only network configuration', () => {
		const parsed = listAvailableNetworksSchemaOutput.parse({
			Networks: [
				{
					id: 'network-1',
					caip2Id: 'eip155:8453',
					displayName: 'Base',
					isTestnet: false,
					isEnabled: true,
					defaultAsset: '0x1111111111111111111111111111111111111111',
					rpcUrl: 'https://rpc.internal.example',
					facilitatorUrl: 'https://facilitator.internal.example',
					facilitatorWalletId: 'wallet-secret-topology',
					createdById: 'admin-key',
				},
			],
		});

		expect(parsed.Networks[0]).toEqual({
			id: 'network-1',
			caip2Id: 'eip155:8453',
			displayName: 'Base',
			isTestnet: false,
			isEnabled: true,
			defaultAsset: '0x1111111111111111111111111111111111111111',
		});
	});
});

describe('x402 payment attempt output', () => {
	it('accepts unknown facilitator mode for migrated legacy attempts', () => {
		const parsed = x402PaymentAttemptSchema.safeParse({
			id: 'attempt-1',
			createdAt: new Date('2026-01-01T00:00:00.000Z'),
			updatedAt: new Date('2026-01-01T00:00:00.000Z'),
			direction: 'InboundSettle',
			status: 'Settled',
			apiKeyId: 'api-key-1',
			evmWalletId: null,
			registryRequestId: null,
			supportedPaymentSourceId: null,
			caip2Network: 'eip155:8453',
			asset: '0x1111111111111111111111111111111111111111',
			amount: '1000',
			payTo: null,
			payer: null,
			resource: null,
			paymentIdentifier: null,
			errorReason: null,
			errorMessage: null,
			facilitator: { mode: 'unknown', address: null },
			Settlement: null,
		});

		expect(parsed.success).toBe(true);
	});
});
