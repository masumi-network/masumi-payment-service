import { describe, expect, it } from '@jest/globals';

import { x402IncomeUnit } from './income';

describe('x402IncomeUnit', () => {
	it('formats CAIP-19 erc20 units for earnings', () => {
		expect(x402IncomeUnit('eip155:84532', '0x036CbD53842c5426634e7929541eC2318f3dCF7e')).toBe(
			'eip155:84532/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e',
		);
	});
});
