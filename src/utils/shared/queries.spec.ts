import { buildTransactionSearchFilter } from './queries';

describe('buildTransactionSearchFilter', () => {
	it('includes agentName in search OR clauses', () => {
		const filter = buildTransactionSearchFilter('phone', undefined, undefined, 'RequestedFunds');

		expect(filter).toEqual({
			OR: expect.arrayContaining([
				{
					agentName: {
						contains: 'phone',
						mode: 'insensitive',
					},
				},
			]),
		});
	});
});
