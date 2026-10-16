import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('@meshsdk/core', () => ({
	resolveTxHash: () => 'a'.repeat(64),
}));

const { describeAmbiguousRegistrySubmit } = await import('./submit-failure');

const SIGNED_TX = '84a300818258';

describe('describeAmbiguousRegistrySubmit', () => {
	/**
	 * The node refused the transaction before broadcast, so nothing reached the
	 * chain. The caller must stamp the original error, not a warning about a
	 * transaction that never existed.
	 */
	it.each(['ScriptWitnessNotValidatingUTXOW', 'BadInputsUTxO', 'ValueNotConservedUTxO', 'InsufficientCollateral'])(
		'returns null for the definitive rejection %s',
		(rejection) => {
			expect(describeAmbiguousRegistrySubmit(SIGNED_TX, new Error(`submit failed: ${rejection}`))).toBeNull();
		},
	);

	/**
	 * A transport failure proves nothing. The burn or mint may have landed, so
	 * the stored reason has to say so and name the hash to check.
	 */
	it('describes a transport failure as ambiguous and names the intended hash', () => {
		const result = describeAmbiguousRegistrySubmit(SIGNED_TX, new Error('socket hang up'));

		expect(result).not.toBeNull();
		expect(result!.intendedTxHash).toBe('a'.repeat(64));
		expect(result!.failure.message).toContain('may still be on chain');
		expect(result!.failure.message).toContain('a'.repeat(64));
		expect(result!.failure.message).toContain('socket hang up');
	});

	/**
	 * Mesh wraps a Blockfrost rejection as a plain object and buries the ledger
	 * detail under `data.message`, so a definitive rejection must not be read as
	 * ambiguous just because it is not an Error instance.
	 */
	it('reads a definitive rejection out of the plain object mesh throws', () => {
		expect(
			describeAmbiguousRegistrySubmit(SIGNED_TX, { status: 400, data: { message: 'ValidationTagMismatch' } }),
		).toBeNull();
	});
});
