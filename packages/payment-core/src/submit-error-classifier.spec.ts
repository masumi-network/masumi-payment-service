import { isDefinitiveNodeRejection, isStaleInputRejection } from './submit-error-classifier';

describe('isDefinitiveNodeRejection', () => {
	describe('definitive ledger rejections', () => {
		it('detects a Plutus phase-2 failure in the Mesh/Blockfrost plain-object shape (the e2e case)', () => {
			// Mesh throws a NON-Error plain object; the ledger detail lives under
			// data.message, not on a top-level `message`.
			const blockfrostError = {
				status: 400,
				headers: { 'content-type': 'application/json' },
				data: {
					error: 'Bad Request',
					message:
						'{"contents":{"contents":{"era":"ShelleyBasedEraConway","error":["ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True) (FailedUnexpectedly (PlutusFailure ...)))))"]}}}',
					status_code: 400,
				},
			};
			expect(isDefinitiveNodeRejection(blockfrostError)).toBe(true);
		});

		it('detects ValidationTagMismatch regardless of Error vs plain object', () => {
			expect(isDefinitiveNodeRejection(new Error('... ValidationTagMismatch (IsValid True) ...'))).toBe(true);
			expect(isDefinitiveNodeRejection('ValidationTagMismatch')).toBe(true);
		});

		it('detects each whitelisted ledger error constructor', () => {
			for (const pattern of [
				'BadInputsUTxO',
				'OutsideValidityIntervalUTxO',
				'InsufficientCollateral',
				'FeeTooSmall',
				'ScriptWitnessNotValidatingUTXOW',
				'ValueNotConservedUTxO',
				'MissingScriptWitnessesUTXOW',
				'MissingVKeyWitnessesUTXOW',
				'PlutusFailure',
			]) {
				expect(isDefinitiveNodeRejection(new Error(`node rejected: ${pattern}`))).toBe(true);
			}
		});

		it('walks a nested cause chain', () => {
			const err = new Error('submit failed');
			(err as Error & { cause?: unknown }).cause = { data: { message: 'PlutusFailure: overspent' } };
			expect(isDefinitiveNodeRejection(err)).toBe(true);
		});
	});

	describe('ambiguous failures (must stay Pending for reconciliation)', () => {
		it('treats transport/network errors as ambiguous', () => {
			expect(isDefinitiveNodeRejection(new Error('ECONNRESET'))).toBe(false);
			expect(isDefinitiveNodeRejection(new Error('socket hang up'))).toBe(false);
			expect(isDefinitiveNodeRejection({ status: 504, data: { message: 'Gateway Timeout' } })).toBe(false);
			expect(isDefinitiveNodeRejection({ status: 500, data: { error: 'Internal Server Error' } })).toBe(false);
		});

		it('returns false for non-error values', () => {
			expect(isDefinitiveNodeRejection(null)).toBe(false);
			expect(isDefinitiveNodeRejection(undefined)).toBe(false);
			expect(isDefinitiveNodeRejection(400)).toBe(false);
			expect(isDefinitiveNodeRejection({})).toBe(false);
		});

		it('does not loop on a circular error object', () => {
			const circular: Record<string, unknown> = { message: 'boom' };
			circular.cause = circular;
			expect(isDefinitiveNodeRejection(circular)).toBe(false);
		});
	});
});

describe('isStaleInputRejection', () => {
	// Verbatim from CI run 33430764978: a V1 funds-lock batch built from a UTxO
	// snapshot that still held an input the wallet's previous batch had spent.
	const staleInputRejection = {
		status: 400,
		data: {
			error: 'Bad Request',
			message:
				'{"contents":{"contents":{"contents":{"era":"ShelleyBasedEraConway","error":' +
				'["ConwayUtxowFailure (UtxoFailure (BadInputsUTxO (NonEmptySet (fromList [TxIn ' +
				'(TxId {unTxId = SafeHash \\"0eb26fbeb06008dc13f02ad6deec36d8b8c57f224029c4384121988725571074\\"}) ' +
				'(TxIx {unTxIx = 3})]))))","ConwayUtxowFailure (UtxoFailure (ValueNotConservedUTxO ...))"],' +
				'"kind":"ShelleyTxValidationError"}}}}',
			status_code: 400,
		},
	};

	it('detects the already-spent-input rejection in the Mesh/Blockfrost shape', () => {
		expect(isStaleInputRejection(staleInputRejection)).toBe(true);
	});

	it('still reports that rejection as definitive, so reverting stays safe', () => {
		expect(isDefinitiveNodeRejection(staleInputRejection)).toBe(true);
	});

	it('does not match the other definitive rejections, which repeat on a rebuild', () => {
		for (const pattern of [
			'OutsideValidityIntervalUTxO',
			'InsufficientCollateral',
			'FeeTooSmall',
			'ScriptWitnessNotValidatingUTXOW',
			'MissingScriptWitnessesUTXOW',
			'MissingVKeyWitnessesUTXOW',
			'ValidationTagMismatch',
			'PlutusFailure',
		]) {
			expect(isStaleInputRejection(new Error(`node rejected: ${pattern}`))).toBe(false);
		}
	});

	it('returns false for transport failures and non-error values', () => {
		expect(isStaleInputRejection(new Error('ECONNRESET'))).toBe(false);
		expect(isStaleInputRejection(null)).toBe(false);
		expect(isStaleInputRejection({})).toBe(false);
	});
});
