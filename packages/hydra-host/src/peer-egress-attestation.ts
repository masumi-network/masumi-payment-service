/** Evidence written on the host only after nft loaded and verified the egress rule. */
import { readFileSync, statSync } from 'node:fs';
import { isPlainObject, getOwnValue } from './registry/json.js';
import type { PortLayout } from './registry/ports.js';

export const PEER_EGRESS_ATTESTATION_FILE = '/run/hydra-peer-egress/ready';
const MAX_AGE_MS = 30_000;
const REQUIRED_HOST_UID = 10001;

export function assertPeerEgressAttestation(
	ports: PortLayout,
	options: { path?: string; now?: number; expectedOwnerUid?: number } = {},
): void {
	const file = options.path ?? PEER_EGRESS_ATTESTATION_FILE;
	let raw: string;
	try {
		const metadata = statSync(file);
		if (!metadata.isFile() || metadata.uid !== (options.expectedOwnerUid ?? 0) || (metadata.mode & 0o022) !== 0) {
			throw new Error('the attestation must be a root-owned file without group or world write access');
		}
		raw = readFileSync(file, 'utf8');
	} catch (error) {
		throw new Error(`peer egress firewall attestation at ${file} is unavailable: ${(error as Error).message}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`peer egress firewall attestation at ${file} is invalid JSON`);
	}
	if (!isPlainObject(parsed)) throw new Error('peer egress firewall attestation is not an object');
	if (
		getOwnValue(parsed, 'uid') !== REQUIRED_HOST_UID ||
		getOwnValue(parsed, 'peerStart') !== ports.peerStart ||
		getOwnValue(parsed, 'apiStart') !== ports.apiStart ||
		getOwnValue(parsed, 'count') !== ports.capacity
	) {
		throw new Error('peer egress firewall attestation does not match the Host UID or port layout');
	}
	const verifiedAt = getOwnValue(parsed, 'verifiedAt');
	const age = (options.now ?? Date.now()) - (typeof verifiedAt === 'number' ? verifiedAt : NaN);
	if (typeof verifiedAt !== 'number' || !Number.isSafeInteger(verifiedAt) || age < 0 || age > MAX_AGE_MS) {
		throw new Error(
			'peer egress firewall attestation is stale or has a future timestamp; rerun hydra-peer-egress baseline',
		);
	}
}
