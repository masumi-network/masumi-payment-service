import { describe, it, expect, jest } from '@jest/globals';

jest.unstable_mockModule('@/utils/config', () => ({
	CONFIG: {
		ENCRYPTION_KEY: '12345678901234567890',
	},
}));

const { encrypt, decrypt } = await import('./index');

describe('encryption utils', () => {
	it('should encrypt and decrypt a string correctly', () => {
		const originalText = 'test secret message';
		const encrypted = encrypt(originalText);
		const decrypted = decrypt(encrypted);

		expect(decrypted).toBe(originalText);
		expect(encrypted).not.toBe(originalText);
		expect(typeof encrypted).toBe('string');
	});

	it('should generate different ciphertexts for same plaintext', () => {
		const text = 'same message';
		const encrypted1 = encrypt(text);
		const encrypted2 = encrypt(text);

		expect(encrypted1).not.toBe(encrypted2);
		expect(decrypt(encrypted1)).toBe(text);
		expect(decrypt(encrypted2)).toBe(text);
	});

	it('should handle empty strings', () => {
		const emptyText = '';
		const encrypted = encrypt(emptyText);
		const decrypted = decrypt(encrypted);

		expect(decrypted).toBe(emptyText);
	});

	it('should handle special characters', () => {
		const specialChars = '!@#$%^&*()_+-=[]{}|;:,.<>?`~';
		const encrypted = encrypt(specialChars);
		const decrypted = decrypt(encrypted);

		expect(decrypted).toBe(specialChars);
	});
	it('shall not be the same as the original text', () => {
		const originalText = 'test secret message';
		const encrypted = encrypt(originalText);
		expect(encrypted).not.toBe(originalText);
	});

	it('should throw error when trying to decrypt invalid data', () => {
		const invalidData = 'invalid encrypted data';
		expect(() => decrypt(invalidData)).toThrow();
	});
});
