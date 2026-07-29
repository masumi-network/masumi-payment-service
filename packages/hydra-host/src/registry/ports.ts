/**
 * Port allocation for supervised hydra-node processes.
 *
 * Every node needs four distinct TCP ports, and only three of them are ours to
 * choose. hydra-node derives its embedded etcd's *client* port arithmetically
 * from the peer port and offers no flag to override it:
 *
 *   clientPort = 2379 + (listenPort - 5001)
 *
 * (`Hydra/Network/Etcd.hs`, `peerPortToClientPort`.) Because the Host runs
 * every node in one network namespace — `--network host` in production — a
 * derived client port that lands on another node's peer/api/monitoring port is
 * a real collision, and it surfaces as an opaque etcd start failure rather than
 * anything self-describing. So the layout is validated up front instead.
 */

/** `2379 - 5001`. Added to a peer port to get its derived etcd client port. */
export const ETCD_CLIENT_PORT_OFFSET = -2622;

/**
 * Largest capacity any single network namespace can support, whatever the
 * bases: beyond this the derived client range necessarily overlaps the peer
 * range it was derived from.
 */
export const MAX_NODES_PER_NAMESPACE = -ETCD_CLIENT_PORT_OFFSET - 1; // 2621

export type PortLayout = {
	peerStart: number;
	apiStart: number;
	monitoringStart: number;
	capacity: number;
};

export type PortTriple = {
	peerPort: number;
	apiPort: number;
	monitoringPort: number;
};

export class PortLayoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PortLayoutError';
	}
}

export class PortExhaustedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PortExhaustedError';
	}
}

export function derivedEtcdClientPort(peerPort: number): number {
	return peerPort + ETCD_CLIENT_PORT_OFFSET;
}

type NamedRange = { name: string; start: number; end: number };

function rangesOverlap(a: NamedRange, b: NamedRange): boolean {
	return a.start <= b.end && b.start <= a.end;
}

/**
 * Reject a layout whose four ranges can collide. Callers get a precise message
 * naming both ranges, because the failure this prevents is otherwise diagnosed
 * as "etcd exited immediately" with no indication of why.
 */
export function validatePortLayout(layout: PortLayout): void {
	const { peerStart, apiStart, monitoringStart, capacity } = layout;

	if (!Number.isSafeInteger(capacity) || capacity < 1) {
		throw new PortLayoutError('capacity must be a positive integer');
	}
	if (capacity > MAX_NODES_PER_NAMESPACE) {
		throw new PortLayoutError(
			`capacity ${capacity} exceeds the ${MAX_NODES_PER_NAMESPACE}-node ceiling imposed by the derived etcd client port`,
		);
	}
	for (const [name, start] of [
		['peerStart', peerStart],
		['apiStart', apiStart],
		['monitoringStart', monitoringStart],
	] as const) {
		if (!Number.isSafeInteger(start) || start < 1 || start > 65535) {
			throw new PortLayoutError(`${name} must be a valid TCP port`);
		}
	}

	const last = capacity - 1;
	const ranges: NamedRange[] = [
		{ name: 'peer', start: peerStart, end: peerStart + last },
		{ name: 'api', start: apiStart, end: apiStart + last },
		{ name: 'monitoring', start: monitoringStart, end: monitoringStart + last },
		{
			name: 'derived etcd client',
			start: derivedEtcdClientPort(peerStart),
			end: derivedEtcdClientPort(peerStart + last),
		},
	];

	for (const range of ranges) {
		if (range.start < 1 || range.end > 65535) {
			throw new PortLayoutError(
				`the ${range.name} range ${range.start}-${range.end} falls outside the valid TCP port space`,
			);
		}
	}

	for (let i = 0; i < ranges.length; i++) {
		for (let j = i + 1; j < ranges.length; j++) {
			const a = ranges[i];
			const b = ranges[j];
			if (rangesOverlap(a, b)) {
				throw new PortLayoutError(
					`the ${a.name} range ${a.start}-${a.end} overlaps the ${b.name} range ${b.start}-${b.end}; ` +
						`choose different bases or a smaller capacity`,
				);
			}
		}
	}
}

/**
 * Durable-by-construction allocator: it holds no state of its own beyond the
 * set of peer ports currently in use, which the caller rehydrates from the
 * on-disk registry at boot. A node's peer port is fixed for the life of its
 * Head, so allocation happens once and release happens only on removal.
 */
export class PortAllocator {
	private readonly layout: PortLayout;
	private readonly takenPeerPorts: Set<number>;

	constructor(layout: PortLayout, takenPeerPorts: Iterable<number> = []) {
		validatePortLayout(layout);
		this.layout = layout;
		this.takenPeerPorts = new Set();
		for (const port of takenPeerPorts) {
			this.claim(port);
		}
	}

	/** Re-take a port recorded on disk. Used when rebuilding state at boot. */
	claim(peerPort: number): void {
		if (!this.isInRange(peerPort)) {
			throw new PortLayoutError(`peer port ${peerPort} lies outside the configured range`);
		}
		if (this.takenPeerPorts.has(peerPort)) {
			throw new PortLayoutError(`peer port ${peerPort} is already allocated`);
		}
		this.takenPeerPorts.add(peerPort);
	}

	allocate(): PortTriple {
		const { peerStart, apiStart, monitoringStart, capacity } = this.layout;
		for (let index = 0; index < capacity; index++) {
			const peerPort = peerStart + index;
			if (this.takenPeerPorts.has(peerPort)) {
				continue;
			}
			this.takenPeerPorts.add(peerPort);
			return {
				peerPort,
				apiPort: apiStart + index,
				monitoringPort: monitoringStart + index,
			};
		}
		throw new PortExhaustedError(
			`all ${capacity} node slots are in use; free a slot by removing a finalised head, or add another host`,
		);
	}

	release(peerPort: number): void {
		this.takenPeerPorts.delete(peerPort);
	}

	get used(): number {
		return this.takenPeerPorts.size;
	}

	get free(): number {
		return this.layout.capacity - this.takenPeerPorts.size;
	}

	private isInRange(peerPort: number): boolean {
		return peerPort >= this.layout.peerStart && peerPort < this.layout.peerStart + this.layout.capacity;
	}
}
