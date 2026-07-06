import { buildNeedsManualActionFilter } from './queries';

describe('buildNeedsManualActionFilter', () => {
	it('returns an empty fragment when the filter is off', () => {
		expect(buildNeedsManualActionFilter(undefined)).toEqual({});
		expect(buildNeedsManualActionFilter(false)).toEqual({});
	});

	it('matches WaitingForManualAction or a recorded error on the next action', () => {
		expect(buildNeedsManualActionFilter(true)).toEqual({
			NextAction: {
				OR: [{ requestedAction: 'WaitingForManualAction' }, { errorType: { not: null } }],
			},
		});
	});
});
