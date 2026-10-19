import { describe, expect, it, jest } from '@jest/globals';
import { PassThrough } from 'node:stream';
import { DEFAULTS } from '@masumi/payment-core/config';
import { confirmPublicSecrets, listPublicSecrets } from './seed.public-secrets.js';

function terminal(answer: string) {
	const input = new PassThrough();
	setImmediate(() => input.write(`${answer}\n`));
	return { input, output: new PassThrough() };
}

describe('seed.public-secrets', () => {
	jest.spyOn(console, 'warn').mockImplementation(() => {});

	it('flags the default and both .env.example values, not a private key', () => {
		expect(listPublicSecrets(DEFAULTS.DEFAULT_ADMIN_KEY, 'private-encryption-key-123')).toEqual(['ADMIN_KEY']);
		expect(listPublicSecrets(DEFAULTS.EXAMPLE_ADMIN_KEY, DEFAULTS.EXAMPLE_ENCRYPTION_KEY)).toEqual([
			'ADMIN_KEY',
			'ENCRYPTION_KEY',
		]);
		expect(listPublicSecrets('private-admin-key-123', 'private-encryption-key-123')).toEqual([]);
	});

	it('continues without a prompt when there is no terminal (CI, containers)', async () => {
		await expect(confirmPublicSecrets(['ADMIN_KEY'], null)).resolves.toBe(true);
	});

	it('aborts when a person declines, continues on "yes"', async () => {
		await expect(confirmPublicSecrets(['ADMIN_KEY'], terminal('no'))).resolves.toBe(false);
		await expect(confirmPublicSecrets(['ADMIN_KEY'], terminal('YES'))).resolves.toBe(true);
	});

	it('treats a closed terminal (Ctrl+D) as a decline instead of hanging', async () => {
		const input = new PassThrough();
		setImmediate(() => input.end());
		await expect(confirmPublicSecrets(['ADMIN_KEY'], { input, output: new PassThrough() })).resolves.toBe(false);
	});
});
