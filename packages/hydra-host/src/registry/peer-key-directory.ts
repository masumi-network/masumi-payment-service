import path from 'node:path';

const PEER_KEY_GENERATION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isPeerKeyGeneration(value: unknown): value is string {
	return typeof value === 'string' && PEER_KEY_GENERATION_PATTERN.test(value);
}

/** Older node records keep their verification keys directly under peers/. */
export function peerKeyDirectory(nodeDir: string, generation?: string): string {
	if (generation === undefined) {
		return path.join(nodeDir, 'peers');
	}
	if (!isPeerKeyGeneration(generation)) {
		throw new Error('invalid peer key generation in node record');
	}
	return path.join(nodeDir, 'peers', generation);
}
