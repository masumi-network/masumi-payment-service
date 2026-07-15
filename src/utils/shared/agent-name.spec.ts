import { MAX_AGENT_NAME_LENGTH, normalizeAgentName } from './agent-name';

describe('normalizeAgentName', () => {
	it('returns null for empty, whitespace, null, and undefined', () => {
		expect(normalizeAgentName(null)).toBeNull();
		expect(normalizeAgentName(undefined)).toBeNull();
		expect(normalizeAgentName('')).toBeNull();
		expect(normalizeAgentName('   ')).toBeNull();
	});

	it('trims surrounding whitespace', () => {
		expect(normalizeAgentName('  Agent Smith  ')).toBe('Agent Smith');
	});

	it('passes through names at or below the length cap unchanged', () => {
		const atCap = 'a'.repeat(MAX_AGENT_NAME_LENGTH);
		expect(normalizeAgentName(atCap)).toBe(atCap);
	});

	it('truncates names longer than the cap', () => {
		const overCap = 'a'.repeat(MAX_AGENT_NAME_LENGTH + 50);
		const result = normalizeAgentName(overCap);
		expect(result).toHaveLength(MAX_AGENT_NAME_LENGTH);
	});

	it('trims before applying the length cap', () => {
		const padded = `  ${'b'.repeat(MAX_AGENT_NAME_LENGTH + 10)}  `;
		expect(normalizeAgentName(padded)).toHaveLength(MAX_AGENT_NAME_LENGTH);
	});
});
