import { describe, it, expect } from '@jest/globals';
import { TransactionLayer } from '@/generated/prisma/client';
import {
	forceLayerApiToTransactionLayer,
	hasHydraRequestOwnership,
	canL1ObservationOwnPaymentRequest,
	canL1ObservationOwnPurchaseRequest,
	transactionLayerToForceLayerApi,
	resolveEffectiveForceLayer,
} from './index';

describe('forceLayerApiToTransactionLayer', () => {
	it('maps the API values to TransactionLayer', () => {
		expect(forceLayerApiToTransactionLayer('L1')).toBe(TransactionLayer.L1);
		expect(forceLayerApiToTransactionLayer('Hydra')).toBe(TransactionLayer.L2);
	});
	it('maps absent to null (auto)', () => {
		expect(forceLayerApiToTransactionLayer(null)).toBeNull();
		expect(forceLayerApiToTransactionLayer(undefined)).toBeNull();
	});
});

describe('transactionLayerToForceLayerApi', () => {
	it('maps TransactionLayer back to the API values', () => {
		expect(transactionLayerToForceLayerApi(TransactionLayer.L1)).toBe('L1');
		expect(transactionLayerToForceLayerApi(TransactionLayer.L2)).toBe('Hydra');
		expect(transactionLayerToForceLayerApi(null)).toBeNull();
	});
});

describe('resolveEffectiveForceLayer', () => {
	it('is null when neither side forces (auto)', () => {
		expect(resolveEffectiveForceLayer(null, null)).toBeNull();
	});
	it('uses whichever single side forces', () => {
		expect(resolveEffectiveForceLayer(TransactionLayer.L1, null)).toBe(TransactionLayer.L1);
		expect(resolveEffectiveForceLayer(null, TransactionLayer.L2)).toBe(TransactionLayer.L2);
	});
	it('agrees when both sides force the same layer', () => {
		expect(resolveEffectiveForceLayer(TransactionLayer.L1, TransactionLayer.L1)).toBe(TransactionLayer.L1);
		expect(resolveEffectiveForceLayer(TransactionLayer.L2, TransactionLayer.L2)).toBe(TransactionLayer.L2);
	});
	it('is a conflict when the two sides force different layers', () => {
		expect(resolveEffectiveForceLayer(TransactionLayer.L1, TransactionLayer.L2)).toBe('conflict');
		expect(resolveEffectiveForceLayer(TransactionLayer.L2, TransactionLayer.L1)).toBe('conflict');
	});
});

describe('hasHydraRequestOwnership', () => {
	const l1Request = {
		layer: TransactionLayer.L1,
		currentHydraUtxoTxHash: null,
		currentHydraUtxoOutputIndex: null,
		CurrentTransaction: null,
	};

	it('recognizes every durable Hydra ownership marker', () => {
		expect(hasHydraRequestOwnership({ ...l1Request, layer: TransactionLayer.L2 })).toBe(true);
		expect(
			hasHydraRequestOwnership({
				...l1Request,
				CurrentTransaction: { layer: TransactionLayer.L2 },
			}),
		).toBe(true);
		expect(hasHydraRequestOwnership({ ...l1Request, currentHydraUtxoTxHash: 'a'.repeat(64) })).toBe(true);
		expect(hasHydraRequestOwnership({ ...l1Request, currentHydraUtxoOutputIndex: 0 })).toBe(true);
	});

	it('leaves an unclaimed L1 request available to L1 sync', () => {
		expect(hasHydraRequestOwnership(l1Request)).toBe(false);
	});
});

describe('L1 observation ownership', () => {
	const unclaimed = {
		layer: TransactionLayer.L1,
		currentHydraUtxoTxHash: null,
		currentHydraUtxoOutputIndex: null,
		CurrentTransaction: null,
	};

	it('allows auto/L1 requests and rejects Hydra-forced requests', () => {
		expect(canL1ObservationOwnPaymentRequest({ ...unclaimed, forceLayer: null })).toBe(true);
		expect(canL1ObservationOwnPaymentRequest({ ...unclaimed, forceLayer: TransactionLayer.L1 })).toBe(true);
		expect(canL1ObservationOwnPaymentRequest({ ...unclaimed, forceLayer: TransactionLayer.L2 })).toBe(false);
		expect(
			canL1ObservationOwnPurchaseRequest({
				...unclaimed,
				forceLayer: null,
				paymentForceLayer: TransactionLayer.L2,
			}),
		).toBe(false);
	});

	it('rejects already Hydra-owned and buyer/seller-conflicting requests', () => {
		expect(
			canL1ObservationOwnPaymentRequest({
				...unclaimed,
				layer: TransactionLayer.L2,
				forceLayer: null,
			}),
		).toBe(false);
		expect(
			canL1ObservationOwnPurchaseRequest({
				...unclaimed,
				forceLayer: TransactionLayer.L1,
				paymentForceLayer: TransactionLayer.L2,
			}),
		).toBe(false);
	});

	it('keeps an already L1-owned handoff routable across later transitions and head deletion', () => {
		const migrated = {
			...unclaimed,
			CurrentTransaction: { layer: TransactionLayer.L1, hydraHeadId: 'head-1' },
		};
		expect(
			canL1ObservationOwnPaymentRequest({
				...migrated,
				forceLayer: TransactionLayer.L2,
			}),
		).toBe(true);
		expect(
			canL1ObservationOwnPurchaseRequest({
				...migrated,
				forceLayer: TransactionLayer.L2,
				paymentForceLayer: null,
			}),
		).toBe(true);
		expect(
			canL1ObservationOwnPaymentRequest({
				...unclaimed,
				CurrentTransaction: { layer: TransactionLayer.L1, hydraHeadId: null },
				forceLayer: TransactionLayer.L2,
			}),
		).toBe(true);
		expect(
			canL1ObservationOwnPaymentRequest({
				...unclaimed,
				CurrentTransaction: null,
				forceLayer: TransactionLayer.L2,
			}),
		).toBe(false);
	});
});
