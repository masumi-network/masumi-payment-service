import { describe, expect, it, jest } from '@jest/globals';
import {
	formatMissingEnvError,
	isMissingEnvValue,
	isSeedV1LegacyEnabled,
	printGeneratedMnemonics,
	resolveMnemonic,
	validatePreprodSeedPrerequisites,
	type ResolvedMnemonic,
} from './seed.validation.js';

describe('seed.validation', () => {
	describe('isMissingEnvValue', () => {
		it('treats undefined, empty, and whitespace-only values as missing', () => {
			expect(isMissingEnvValue(undefined)).toBe(true);
			expect(isMissingEnvValue('')).toBe(true);
			expect(isMissingEnvValue('   ')).toBe(true);
			expect(isMissingEnvValue('\t\n')).toBe(true);
		});

		it('treats non-empty strings as present', () => {
			expect(isMissingEnvValue('abc')).toBe(false);
			expect(isMissingEnvValue(' abc ')).toBe(false);
		});
	});

	describe('validatePreprodSeedPrerequisites', () => {
		it('passes when all required variables are set', () => {
			expect(
				validatePreprodSeedPrerequisites({
					DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
					ENCRYPTION_KEY: '12345678901234567890123456789012',
					BLOCKFROST_API_KEY_PREPROD: 'preprod123',
				}),
			).toEqual({ ok: true });
		});

		it('lists every missing required variable', () => {
			expect(
				validatePreprodSeedPrerequisites({
					DATABASE_URL: '',
					ENCRYPTION_KEY: '   ',
					BLOCKFROST_API_KEY_PREPROD: undefined,
				}),
			).toEqual({
				ok: false,
				missing: ['DATABASE_URL', 'ENCRYPTION_KEY', 'BLOCKFROST_API_KEY_PREPROD'],
			});
		});

		it('names a blank Blockfrost key as missing', () => {
			const result = validatePreprodSeedPrerequisites({
				DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
				ENCRYPTION_KEY: '12345678901234567890123456789012',
				BLOCKFROST_API_KEY_PREPROD: '',
			});
			expect(result).toEqual({ ok: false, missing: ['BLOCKFROST_API_KEY_PREPROD'] });
		});
	});

	describe('formatMissingEnvError', () => {
		it('includes each missing variable name', () => {
			expect(formatMissingEnvError(['DATABASE_URL', 'BLOCKFROST_API_KEY_PREPROD'])).toBe(
				'Seed aborted: missing required environment variable(s): DATABASE_URL, BLOCKFROST_API_KEY_PREPROD',
			);
		});
	});

	describe('isSeedV1LegacyEnabled', () => {
		it('enables legacy V1 seeding only when explicitly true', () => {
			expect(isSeedV1LegacyEnabled('true')).toBe(true);
			expect(isSeedV1LegacyEnabled('TRUE')).toBe(true);
			expect(isSeedV1LegacyEnabled('false')).toBe(false);
			expect(isSeedV1LegacyEnabled(undefined)).toBe(false);
		});
	});

	describe('resolveMnemonic', () => {
		it('generates a mnemonic when the env value is empty or whitespace', () => {
			const brewed = 'word '.repeat(23).trim() + ' last';
			const purchase = resolveMnemonic('   ', 'PURCHASE_WALLET_PREPROD_MNEMONIC', () => brewed);
			expect(purchase).toEqual({
				mnemonic: brewed,
				wasGenerated: true,
				envName: 'PURCHASE_WALLET_PREPROD_MNEMONIC',
			});
		});

		it('uses a supplied mnemonic without marking it generated', () => {
			const supplied = 'abandon '.repeat(23).trim() + ' about';
			const selling = resolveMnemonic(supplied, 'SELLING_WALLET_PREPROD_MNEMONIC', () => 'brewed');
			expect(selling).toEqual({
				mnemonic: supplied,
				wasGenerated: false,
				envName: 'SELLING_WALLET_PREPROD_MNEMONIC',
			});
		});
	});

	describe('printGeneratedMnemonics', () => {
		it('prints only generated mnemonics once', () => {
			const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
			const generated: ResolvedMnemonic[] = [
				{
					mnemonic: 'generated purchase phrase',
					wasGenerated: true,
					envName: 'PURCHASE_WALLET_PREPROD_MNEMONIC',
				},
				{
					mnemonic: 'supplied selling phrase',
					wasGenerated: false,
					envName: 'SELLING_WALLET_PREPROD_MNEMONIC',
				},
			];

			printGeneratedMnemonics(generated);

			const output = warnSpy.mock.calls.map((call) => call[0]).join('\n');
			expect(output).toContain('PURCHASE_WALLET_PREPROD_MNEMONIC=generated purchase phrase');
			expect(output).not.toContain('SELLING_WALLET_PREPROD_MNEMONIC=supplied selling phrase');
			warnSpy.mockRestore();
		});
	});
});
