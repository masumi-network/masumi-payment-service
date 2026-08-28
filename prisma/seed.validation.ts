/** Pure helpers for prisma/seed.ts — exported for unit tests. */

export function isMissingEnvValue(value: string | undefined): boolean {
	return value == null || value.trim() === '';
}

export type PreprodSeedPrerequisites = {
	DATABASE_URL?: string;
	ENCRYPTION_KEY?: string;
	BLOCKFROST_API_KEY_PREPROD?: string;
};

export function validatePreprodSeedPrerequisites(
	env: PreprodSeedPrerequisites,
): { ok: true } | { ok: false; missing: string[] } {
	const missing: string[] = [];
	if (isMissingEnvValue(env.DATABASE_URL)) {
		missing.push('DATABASE_URL');
	}
	if (isMissingEnvValue(env.ENCRYPTION_KEY)) {
		missing.push('ENCRYPTION_KEY');
	}
	if (isMissingEnvValue(env.BLOCKFROST_API_KEY_PREPROD)) {
		missing.push('BLOCKFROST_API_KEY_PREPROD');
	}
	if (missing.length > 0) {
		return { ok: false, missing };
	}
	return { ok: true };
}

export function formatMissingEnvError(missing: string[]): string {
	return `Seed aborted: missing required environment variable(s): ${missing.join(', ')}`;
}

export type ResolvedMnemonic = {
	mnemonic: string;
	wasGenerated: boolean;
	envName: string;
};

export function resolveMnemonic(
	raw: string | undefined,
	envName: string,
	brew: () => string,
): ResolvedMnemonic {
	if (!isMissingEnvValue(raw)) {
		return { mnemonic: raw!.trim(), wasGenerated: false, envName };
	}
	return { mnemonic: brew(), wasGenerated: true, envName };
}

export function printGeneratedMnemonics(generated: ResolvedMnemonic[]): void {
	const toShow = generated.filter((entry) => entry.wasGenerated);
	if (toShow.length === 0) {
		return;
	}

	console.warn('****************************************************');
	console.warn('**  GENERATED WALLET MNEMONICS — SAVE THESE NOW!   **');
	console.warn('**  These were not in your .env. Store them securely.**');
	console.warn('****************************************************');
	for (const entry of toShow) {
		console.warn(`${entry.envName}=${entry.mnemonic}`);
	}
	console.warn('****************************************************');
}
