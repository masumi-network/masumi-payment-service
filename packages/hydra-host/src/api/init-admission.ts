/** Fresh L1 and L2 ledger admission for every direct Host admin Init. */
import { readFile } from 'node:fs/promises';
import type { HostConfig } from '../config.js';
import { FANOUT_ENVELOPE_BYTES, FANOUT_SAFETY_MARGIN_BYTES, MAX_L2_TX_SIZE } from '../ledger-params.js';
import { NodeClient } from '../node-client.js';
import { getOwnValue, isPlainObject } from '../registry/json.js';
import type { NodeRecord } from '../registry/types.js';
import { HostApiError } from './http-error.js';

const BLOCKFROST_BASE_URL = {
	preprod: 'https://cardano-preprod.blockfrost.io/api/v0',
	mainnet: 'https://cardano-mainnet.blockfrost.io/api/v0',
} as const;
const BLOCKFROST_TIMEOUT_MS = 5_000;
const MAX_BLOCKFROST_RESPONSE_BYTES = 64 * 1024;
const MAX_PROJECT_ID_BYTES = 256;

export type ReadCurrentL1Parameters = (
	network: HostConfig['network'],
	blockfrostProjectFile: string,
) => Promise<unknown>;

function unavailableL1(): HostApiError {
	return new HostApiError('Could not read current L1 protocol parameters from Blockfrost; Init was not posted', 503);
}

/** Read the Host's existing Blockfrost secret, then fetch a bounded fresh response. */
export async function readBlockfrostLatestParameters(
	network: HostConfig['network'],
	projectFile: string,
	fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
	let projectId: string;
	try {
		projectId = (await readFile(projectFile, 'utf8')).trim();
	} catch {
		throw new HostApiError('Could not read the Blockfrost project ID; Init was not posted', 503);
	}
	if (projectId.length === 0 || Buffer.byteLength(projectId) > MAX_PROJECT_ID_BYTES || /\s/.test(projectId)) {
		throw new HostApiError('The Blockfrost project ID is invalid; Init was not posted', 503);
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), BLOCKFROST_TIMEOUT_MS);
	try {
		const response = await fetchImpl(`${BLOCKFROST_BASE_URL[network]}/epochs/latest/parameters`, {
			headers: { project_id: projectId },
			signal: controller.signal,
			redirect: 'error',
		});
		if (!response.ok || response.body === null) throw unavailableL1();
		const declaredLength = Number(response.headers.get('content-length'));
		if (Number.isFinite(declaredLength) && declaredLength > MAX_BLOCKFROST_RESPONSE_BYTES) throw unavailableL1();
		const reader = response.body.getReader();
		const chunks: Buffer[] = [];
		let totalBytes = 0;
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			totalBytes += chunk.value.byteLength;
			if (totalBytes > MAX_BLOCKFROST_RESPONSE_BYTES) {
				void reader.cancel().catch(() => undefined);
				throw unavailableL1();
			}
			chunks.push(Buffer.from(chunk.value));
		}
		return JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8')) as unknown;
	} catch {
		throw unavailableL1();
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}

function positiveSafeInteger(value: unknown, allowDecimalString: boolean): number | null {
	if (allowDecimalString && typeof value === 'string') {
		if (!/^[1-9]\d*$/.test(value)) return null;
		value = Number(value);
	}
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function requiredInteger(parameters: unknown, field: string, ledger: 'L1' | 'L2'): number {
	const value = isPlainObject(parameters) ? positiveSafeInteger(getOwnValue(parameters, field), ledger === 'L1') : null;
	if (value === null) {
		throw new HostApiError(
			`${ledger} protocol parameters report no usable ${field}; Init was not posted`,
			ledger === 'L1' ? 503 : 409,
		);
	}
	return value;
}

/** A missing observer or an unsafe parameter must never reach dispatchInit. */
export async function assertSafeHostInitLedgerParams(
	record: NodeRecord,
	config: Pick<HostConfig, 'network' | 'blockfrostProjectFile'>,
	readCurrentL1Parameters: ReadCurrentL1Parameters,
): Promise<void> {
	if (record.network !== config.network) {
		throw new HostApiError('The node network differs from its Host; Init was not posted', 409);
	}
	let nodeParams: unknown;
	try {
		nodeParams = await new NodeClient(record.apiPort).fetchProtocolParameters();
	} catch {
		throw new HostApiError("Could not read this node's L2 protocol parameters; Init was not posted", 503);
	}
	const maxTxSize = requiredInteger(nodeParams, 'maxTxSize', 'L2');
	if (maxTxSize > MAX_L2_TX_SIZE) {
		throw new HostApiError(`This node's L2 maxTxSize exceeds ${MAX_L2_TX_SIZE}; Init was not posted`, 409);
	}
	const maxValueSize = requiredInteger(nodeParams, 'maxValueSize', 'L2');
	const utxoCostPerByte = requiredInteger(nodeParams, 'utxoCostPerByte', 'L2');

	let chainParams: unknown;
	try {
		chainParams = await readCurrentL1Parameters(config.network, config.blockfrostProjectFile);
	} catch {
		throw unavailableL1();
	}
	const chainMaxTxSize = requiredInteger(chainParams, 'max_tx_size', 'L1');
	const chainMaxValueSize = requiredInteger(chainParams, 'max_val_size', 'L1');
	const chainUtxoCostPerByte = requiredInteger(chainParams, 'coins_per_utxo_size', 'L1');
	if (maxTxSize + FANOUT_ENVELOPE_BYTES + FANOUT_SAFETY_MARGIN_BYTES > chainMaxTxSize) {
		throw new HostApiError('L2 maxTxSize leaves no fanout room under current L1 max_tx_size; Init was not posted', 409);
	}
	if (maxValueSize > chainMaxValueSize) {
		throw new HostApiError('L2 maxValueSize exceeds current L1 max_val_size; Init was not posted', 409);
	}
	if (utxoCostPerByte < chainUtxoCostPerByte) {
		throw new HostApiError('L2 utxoCostPerByte is below current L1 coins_per_utxo_size; Init was not posted', 409);
	}
}
