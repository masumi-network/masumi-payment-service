import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writePrivateFileSync } from './private-file.mts';

test('secret output stays owner-only with a permissive umask and existing file', () => {
	const directory = mkdtempSync(join(tmpdir(), 'hydra-private-file-'));
	const output = join(directory, 'secret.txt');
	const priorUmask = process.umask(0);
	try {
		writePrivateFileSync(output, 'first-secret');
		assert.equal(statSync(output).mode & 0o777, 0o600);
		chmodSync(output, 0o666);
		writeFileSync(output, 'old-secret');
		assert.equal(statSync(output).mode & 0o777, 0o666);
		writePrivateFileSync(output, 'new-secret');
		assert.equal(readFileSync(output, 'utf8'), 'new-secret');
		assert.equal(statSync(output).mode & 0o777, 0o600);
	} finally {
		process.umask(priorUmask);
		rmSync(directory, { recursive: true, force: true });
	}
});

test('secret output replaces a symlink without writing through it', () => {
	const directory = mkdtempSync(join(tmpdir(), 'hydra-private-file-'));
	const target = join(directory, 'target.txt');
	const output = join(directory, 'secret.txt');
	try {
		writeFileSync(target, 'unchanged');
		symlinkSync(target, output);
		writePrivateFileSync(output, 'secret');
		assert.equal(readFileSync(target, 'utf8'), 'unchanged');
		assert.equal(readFileSync(output, 'utf8'), 'secret');
		assert.equal(statSync(output).mode & 0o777, 0o600);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
