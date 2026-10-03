import { describe, expect, it } from '@jest/globals';
import { X402PaymentDirection, X402PaymentStatus } from '@masumi/payment-core/db';

import { classifyX402AttemptForEarnings, x402IncomeUnit } from './income';

describe('x402IncomeUnit', () => {
	it('formats CAIP-19 erc20 units for earnings', () => {
		expect(x402IncomeUnit('eip155:84532', '0x036CbD53842c5426634e7929541eC2318f3dCF7e')).toBe(
			'eip155:84532/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e',
		);
	});
});

describe('classifyX402AttemptForEarnings', () => {
	const classify = (
		direction: X402PaymentDirection,
		status: X402PaymentStatus,
		Settlement: { success: boolean } | null = null,
	) => classifyX402AttemptForEarnings({ direction, status, Settlement });

	it('counts a successfully settled inbound attempt as income', () => {
		expect(classify(X402PaymentDirection.InboundSettle, X402PaymentStatus.Settled, { success: true })).toBe('income');
	});

	it('does not count a failed settlement as income', () => {
		expect(classify(X402PaymentDirection.InboundSettle, X402PaymentStatus.Settled, { success: false })).toBeNull();
	});

	it('does not re-count a replayed settle (no Settlement of its own)', () => {
		expect(classify(X402PaymentDirection.InboundSettle, X402PaymentStatus.Replayed)).toBeNull();
	});

	it('treats in-flight inbound settles as pending', () => {
		expect(classify(X402PaymentDirection.InboundSettle, X402PaymentStatus.Verified)).toBe('pending');
		expect(classify(X402PaymentDirection.InboundSettle, X402PaymentStatus.Settled)).toBe('pending');
	});

	it('ignores InboundVerify, whose terminal state is Verified', () => {
		expect(classify(X402PaymentDirection.InboundVerify, X402PaymentStatus.Verified)).toBeNull();
	});

	it('never counts outbound pay (signed authorization, settlement untracked)', () => {
		for (const status of Object.values(X402PaymentStatus)) {
			expect(classify(X402PaymentDirection.OutboundPayment, status)).toBeNull();
		}
	});

	it('does not classify Failed attempts as refunds', () => {
		for (const direction of Object.values(X402PaymentDirection)) {
			expect(classify(direction, X402PaymentStatus.Failed)).toBeNull();
		}
	});
});
