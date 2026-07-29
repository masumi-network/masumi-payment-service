/**
 * What this Host can actually run.
 *
 * The payment service checks this before provisioning, because two couplings
 * cross the image boundary and both fail late and confusingly if they drift:
 *
 *  - `HYDRA_DEPOSIT_SCRIPT_HASH` / `HYDRA_HEAD_SCRIPT_HASH` must match
 *    `hydra-node --hydra-script-catalogue` for the deployed binary;
 *  - the ledger protocol parameters must match the Mesh cost models pinned by
 *    the payment service, or every in-head script spend fails
 *    `PPViewHashesDontMatch`.
 *
 * Reporting a hash of the params file lets the service refuse to provision
 * against a skewed Host instead of discovering the mismatch at first commit.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type Capabilities = {
	hydraVersion: string;
	/** Raw `--hydra-script-catalogue` output, parsed if it is JSON. */
	scriptCatalogue: unknown;
	/** Set when probing the binary failed, so a broken Host is visible rather than reported as empty. */
	probeError: string | null;
	/** SHA-256 of the ledger protocol parameters file, for drift detection. */
	ledgerParamsHash: string | null;
	network: string;
	nodeSlots: { used: number; capacity: number };
};

export type CapabilitiesDeps = {
	hydraNodeBin: string;
	ledgerProtocolParametersFile: string;
	network: string;
	slots: () => { used: number; capacity: number };
	exec?: (file: string, args: string[]) => Promise<{ stdout: string }>;
};

async function hashFile(filePath: string): Promise<string | null> {
	try {
		const contents = await fs.readFile(filePath);
		return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
	} catch {
		// A missing params file is a real misconfiguration, but reporting null
		// lets the caller say so precisely rather than failing the whole probe.
		return null;
	}
}

export async function readCapabilities(deps: CapabilitiesDeps): Promise<Capabilities> {
	// A hung binary must not hang the capabilities request.
	const exec = deps.exec ?? ((file, args) => run(file, args, { timeout: 5_000 }));

	const probeErrors: string[] = [];
	const probe = async (args: string[]): Promise<{ stdout: string }> => {
		try {
			return await exec(deps.hydraNodeBin, args);
		} catch (error) {
			probeErrors.push(`${args.join(' ')}: ${(error as Error).message}`);
			return { stdout: '' };
		}
	};

	const [versionResult, catalogueResult, ledgerParamsHash] = await Promise.all([
		probe(['--version']),
		probe(['--hydra-script-catalogue']),
		hashFile(deps.ledgerProtocolParametersFile),
	]);

	let scriptCatalogue: unknown = null;
	const catalogueText = catalogueResult.stdout.trim();
	if (catalogueText.length > 0) {
		try {
			scriptCatalogue = JSON.parse(catalogueText);
		} catch {
			scriptCatalogue = catalogueText;
		}
	}

	return {
		hydraVersion: versionResult.stdout.trim(),
		scriptCatalogue,
		probeError: probeErrors.length === 0 ? null : probeErrors.join('; '),
		ledgerParamsHash,
		network: deps.network,
		nodeSlots: deps.slots(),
	};
}
