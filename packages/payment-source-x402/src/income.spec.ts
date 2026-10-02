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
	it('treats verified outbound pay as income (Masumi hire)', () => {
		expect(
			classifyX402AttemptForEarnings({
				direction: X402PaymentDirection.OutboundPayment,
				status: X402PaymentStatus.Verified,
				Settlement: null,
			}),
		).toBe('income');
	});

	it('treats payment-required outbound as pending', () => {
		expect(
			classifyX402AttemptForEarnings({
				direction: X402PaymentDirection.OutboundPayment,
				status: X402PaymentStatus.PaymentRequired,
				Settlement: null,
			}),
		).toBe('pending');
	});
});
