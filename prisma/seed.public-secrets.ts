import { openSync } from 'node:fs';
import { ReadStream } from 'node:tty';
import { createInterface } from 'node:readline/promises';
import { DEFAULTS } from '@masumi/payment-core/config';

/**
 * Public secrets (the built-in default and the .env.example values) are
 * allowed on purpose for one-off setups. The seed warns, and asks for a
 * confirmation when a person runs it in a terminal. Non-interactive runs
 * (CI, containers) only warn, so they keep working unchanged.
 */

const TERMINAL_DEVICE = '/dev/tty';

export const CONFIRM_PUBLIC_SECRETS_ANSWER = 'yes';

export function isPublicAdminKey(adminKey: string): boolean {
	return adminKey === DEFAULTS.DEFAULT_ADMIN_KEY || adminKey === DEFAULTS.EXAMPLE_ADMIN_KEY;
}

export function listPublicSecrets(adminKey: string, encryptionKey: string): string[] {
	const names: string[] = [];
	if (isPublicAdminKey(adminKey)) names.push('ADMIN_KEY');
	if (encryptionKey === DEFAULTS.EXAMPLE_ENCRYPTION_KEY) names.push('ENCRYPTION_KEY');
	return names;
}

type Terminal = {
	input: NodeJS.ReadableStream;
	output: NodeJS.WritableStream;
};

/**
 * `prisma db seed` passes a pipe as stdin and inherits stdout, so stdin is
 * never a TTY there. When stdout is a terminal, read the answer from the
 * controlling terminal instead. Returns null for non-interactive runs.
 */
function openTerminal(): Terminal | null {
	if (process.stdin.isTTY === true) return { input: process.stdin, output: process.stdout };
	if (process.stdout.isTTY !== true) return null;
	try {
		return { input: new ReadStream(openSync(TERMINAL_DEVICE, 'r')), output: process.stdout };
	} catch {
		return null;
	}
}

/** Resolves false only when a person in a terminal declines. */
export async function confirmPublicSecrets(
	names: string[],
	terminal: Terminal | null = names.length > 0 ? openTerminal() : null,
): Promise<boolean> {
	if (names.length === 0) return true;

	console.warn('****************************************************');
	console.warn(`**  WARNING: ${names.join(' and ')} use a PUBLIC value.`);
	console.warn('**  Anyone who reads the source knows it. Use this');
	console.warn('**  only for a one-off or local setup.');
	console.warn('****************************************************');

	if (terminal === null) {
		console.warn('Non-interactive seed: continuing with the public value(s).');
		return true;
	}

	const prompt = createInterface({ input: terminal.input, output: terminal.output });
	try {
		// Ctrl+D or Ctrl+C closes the prompt without an answer: treat it as "no".
		const closed = new Promise<string>((resolve) => prompt.once('close', () => resolve('')));
		const asked = prompt.question(`Type "${CONFIRM_PUBLIC_SECRETS_ANSWER}" to continue: `).catch(() => '');
		const answer = await Promise.race([asked, closed]);
		return answer.trim().toLowerCase() === CONFIRM_PUBLIC_SECRETS_ANSWER;
	} finally {
		prompt.close();
		// A stream opened on the terminal device keeps the process alive.
		if (terminal.input !== process.stdin && 'destroy' in terminal.input) {
			(terminal.input as NodeJS.ReadableStream & { destroy: () => void }).destroy();
		}
	}
}
