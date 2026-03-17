import { interpretBlockchainError } from './index';

describe('interpretBlockchainError', () => {
	describe('fallback behaviour', () => {
		it('should return the raw message unchanged for unknown errors', () => {
			expect(interpretBlockchainError(new Error('some unknown error'))).toBe('some unknown error');
		});

		it('should handle null', () => {
			expect(interpretBlockchainError(null)).toBe('Unknown error');
		});

		it('should handle undefined', () => {
			expect(interpretBlockchainError(undefined)).toBe('Unknown error');
		});

		it('should handle plain objects without matching patterns', () => {
			const result = interpretBlockchainError({ code: 999, msg: 'unrecognised' });
			expect(result).not.toContain('. Hint:');
		});
	});

	describe('pattern 1 — UTxO fully depleted', () => {
		it('should match exact message', () => {
			const result = interpretBlockchainError(new Error('UTxO Fully Depleted'));
			expect(result).toContain('. Hint:');
			expect(result).toContain('no UTxOs available');
		});

		it('should match case-insensitively', () => {
			expect(interpretBlockchainError(new Error('UTXO FULLY DEPLETED'))).toContain('. Hint:');
		});

		it('should match inside a JSON Blockfrost error object', () => {
			const result = interpretBlockchainError({ status_code: 400, message: 'UTxO Fully Depleted' });
			expect(result).toContain('. Hint:');
			expect(result).toContain('no UTxOs available');
		});
	});

	describe('pattern 2 — insufficient balance', () => {
		it('should match "insufficient balance"', () => {
			expect(interpretBlockchainError(new Error('Insufficient balance'))).toContain('. Hint:');
		});

		it('should match "not enough ada"', () => {
			expect(interpretBlockchainError(new Error('Not enough ADA to cover fees'))).toContain('. Hint:');
		});

		it('should match "not enough lovelace"', () => {
			expect(interpretBlockchainError(new Error('Not enough lovelace'))).toContain('. Hint:');
		});
	});

	describe('pattern 3 — execution units exceeded', () => {
		it('should match "exbudget"', () => {
			expect(interpretBlockchainError(new Error('ExBudget exceeded'))).toContain('. Hint:');
		});

		it('should match "exceededmemorylimit"', () => {
			expect(interpretBlockchainError(new Error('ExceededMemoryLimit'))).toContain('. Hint:');
		});

		it('should match "exceededsteplimit"', () => {
			expect(interpretBlockchainError(new Error('ExceededStepLimit'))).toContain('. Hint:');
		});
	});

	describe('pattern 4 — bad inputs UTxO', () => {
		it('should match "badinputsutxo"', () => {
			expect(interpretBlockchainError(new Error('BadInputsUTxO'))).toContain('. Hint:');
		});

		it('should match "bad inputs"', () => {
			expect(interpretBlockchainError(new Error('bad inputs detected'))).toContain('. Hint:');
		});
	});

	describe('pattern 5 — value not conserved', () => {
		it('should match "valuenotconserved"', () => {
			expect(interpretBlockchainError(new Error('ValueNotConserved'))).toContain('. Hint:');
		});
	});

	describe('pattern 6 — fee too small', () => {
		it('should match "feetoosmall"', () => {
			expect(interpretBlockchainError(new Error('FeeTooSmall'))).toContain('. Hint:');
		});

		it('should match "fee" + "too small"', () => {
			expect(interpretBlockchainError(new Error('The fee is too small for this transaction'))).toContain('. Hint:');
		});
	});

	describe('pattern 7 — output too small', () => {
		it('should match "outputtoosmall"', () => {
			expect(interpretBlockchainError(new Error('OutputTooSmall'))).toContain('. Hint:');
		});

		it('should match "minimum ada"', () => {
			expect(interpretBlockchainError(new Error('minimum ADA not met'))).toContain('. Hint:');
		});

		it('should match "min ada"', () => {
			expect(interpretBlockchainError(new Error('min ADA requirement'))).toContain('. Hint:');
		});
	});

	describe('pattern 8 — already in ledger', () => {
		it('should match "alreadyinledger"', () => {
			expect(interpretBlockchainError(new Error('AlreadyInLedger'))).toContain('. Hint:');
		});

		it('should match "already submitted"', () => {
			expect(interpretBlockchainError(new Error('Transaction already submitted'))).toContain('. Hint:');
		});
	});

	describe('pattern 9 — timeout', () => {
		it('should match "timeout" for a blockchain timeout', () => {
			const result = interpretBlockchainError(new Error('Timeout batching purchase requests'));
			expect(result).toContain('. Hint:');
			expect(result).toContain('timed out');
		});

		it('should NOT match "mutex timeout" (goes to pattern 20 instead)', () => {
			const result = interpretBlockchainError(new Error('Mutex timeout when locking'));
			expect(result).toContain('. Hint:');
			expect(result).toContain('concurrency lock');
			expect(result).not.toContain('timed out');
		});
	});

	describe('pattern 10 — Blockfrost 402', () => {
		it('should match "status 402"', () => {
			expect(interpretBlockchainError(new Error('status 402'))).toContain('. Hint:');
		});

		it('should match JSON status_code 402', () => {
			expect(interpretBlockchainError('{"status_code":402,"error":"Payment Required"}')).toContain('. Hint:');
		});

		it('should match "project plan limit"', () => {
			expect(interpretBlockchainError(new Error('project plan limit exceeded'))).toContain('. Hint:');
		});
	});

	describe('pattern 11 — Blockfrost 403', () => {
		it('should match "status 403"', () => {
			expect(interpretBlockchainError(new Error('status 403'))).toContain('. Hint:');
		});

		it('should match "not authorized"', () => {
			expect(interpretBlockchainError(new Error('not authorized'))).toContain('. Hint:');
		});
	});

	describe('pattern 12 — Blockfrost 404', () => {
		it('should match "status 404"', () => {
			expect(interpretBlockchainError(new Error('status 404'))).toContain('. Hint:');
		});

		it('should match JSON status_code 404', () => {
			const result = interpretBlockchainError('{"status_code":404,"error":"Not Found"}');
			expect(result).toContain('. Hint:');
			expect(result).toContain('Blockfrost 404');
		});
	});

	describe('pattern 13 — Blockfrost 418', () => {
		it('should match "status 418"', () => {
			expect(interpretBlockchainError(new Error('status 418'))).toContain('. Hint:');
		});

		it('should match JSON status_code 418', () => {
			expect(interpretBlockchainError('{"status_code":418}')).toContain('. Hint:');
		});
	});

	describe('pattern 14 — Blockfrost 429 / rate limit', () => {
		it('should match "status 429"', () => {
			expect(interpretBlockchainError(new Error('status 429'))).toContain('. Hint:');
		});

		it('should match JSON status_code 429', () => {
			const result = interpretBlockchainError(
				'{"status_code":429,"error":"Too Many Requests","message":"Backend is rate limited."}',
			);
			expect(result).toContain('. Hint:');
			expect(result).toContain('rate limit');
		});

		it('should match "too many requests"', () => {
			expect(interpretBlockchainError(new Error('Too many requests'))).toContain('. Hint:');
		});

		it('should match "rate limit"', () => {
			expect(interpretBlockchainError(new Error('rate limit exceeded'))).toContain('. Hint:');
		});
	});

	describe('pattern 15 — Blockfrost 500', () => {
		it('should match "status 500"', () => {
			expect(interpretBlockchainError(new Error('status 500'))).toContain('. Hint:');
		});

		it('should match "server error"', () => {
			expect(interpretBlockchainError(new Error('Internal server error'))).toContain('. Hint:');
		});
	});

	describe('pattern 16 — empty wallet', () => {
		it('should match "no utxos found"', () => {
			const result = interpretBlockchainError(new Error('No UTXOs found in the wallet. Wallet is empty.'));
			expect(result).toContain('. Hint:');
			expect(result).toContain('Fund the wallet');
		});

		it('should match "wallet is empty"', () => {
			expect(interpretBlockchainError(new Error('wallet is empty'))).toContain('. Hint:');
		});

		it('should match the registration variant', () => {
			expect(interpretBlockchainError(new Error('No UTXOs found for the wallet'))).toContain('. Hint:');
		});
	});

	describe('pattern 17 — collateral UTxO not found', () => {
		it('should match "collateral utxo not found"', () => {
			const result = interpretBlockchainError(new Error('Collateral UTXO not found'));
			expect(result).toContain('. Hint:');
			expect(result).toContain('pure-ADA UTxO');
		});
	});

	describe('pattern 18 — UTxO not found (internal)', () => {
		it('should match "utxo not found"', () => {
			const result = interpretBlockchainError(new Error('UTXO not found'));
			expect(result).toContain('. Hint:');
			expect(result).toContain('specific UTxO');
		});

		it('should NOT match pattern 12 (Blockfrost 404)', () => {
			const result = interpretBlockchainError(new Error('UTXO not found'));
			expect(result).not.toContain('Blockfrost 404');
		});

		it('should NOT match pattern 17 (collateral) for plain UTXO not found', () => {
			const result = interpretBlockchainError(new Error('UTXO not found'));
			expect(result).not.toContain('pure-ADA UTxO');
		});
	});

	describe('pattern 19 — no datum found', () => {
		it('should match "no datum found"', () => {
			const result = interpretBlockchainError(new Error('No datum found in UTXO'));
			expect(result).toContain('. Hint:');
			expect(result).toContain('inline datum');
		});
	});

	describe('pattern 20 — mutex / concurrency lock', () => {
		it('should match "mutex"', () => {
			const result = interpretBlockchainError(new Error('Mutex timeout when locking'));
			expect(result).toContain('. Hint:');
			expect(result).toContain('concurrency lock');
		});

		it('should match "tryacquire"', () => {
			expect(interpretBlockchainError(new Error('tryAcquire failed'))).toContain('. Hint:');
		});
	});

	describe('hint format', () => {
		it('should preserve the original raw message before the hint', () => {
			const raw = 'UTxO Fully Depleted';
			const result = interpretBlockchainError(new Error(raw));
			expect(result.startsWith(raw + '. Hint: ')).toBe(true);
		});

		it('should not double-append hints on repeated calls', () => {
			const first = interpretBlockchainError(new Error('UTxO Fully Depleted'));
			const second = interpretBlockchainError(new Error(first));
			const hintCount = (second.match(/\. Hint:/g) ?? []).length;
			expect(hintCount).toBe(1);
		});
	});
});
