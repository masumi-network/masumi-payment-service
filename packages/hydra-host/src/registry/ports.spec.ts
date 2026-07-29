import { describe, expect, it } from '@jest/globals';
import {
	MAX_NODES_PER_NAMESPACE,
	PortAllocator,
	PortExhaustedError,
	PortLayoutError,
	derivedEtcdClientPort,
	validatePortLayout,
} from './ports.js';

const LAYOUT = { peerStart: 5001, apiStart: 4001, monitoringStart: 6001, capacity: 32 };

describe('derivedEtcdClientPort', () => {
	it('matches hydra-node: 2379 + (listenPort - 5001)', () => {
		expect(derivedEtcdClientPort(5001)).toBe(2379);
		expect(derivedEtcdClientPort(5002)).toBe(2380);
		expect(derivedEtcdClientPort(5032)).toBe(2410);
	});
});

describe('validatePortLayout', () => {
	it('accepts a sane default layout', () => {
		expect(() => validatePortLayout(LAYOUT)).not.toThrow();
	});

	it('rejects a capacity beyond the derived-client-port ceiling', () => {
		expect(() => validatePortLayout({ ...LAYOUT, capacity: MAX_NODES_PER_NAMESPACE + 1 })).toThrow(
			/exceeds the 2621-node ceiling/,
		);
	});

	// The naive "just raise capacity" move silently breaks: with capacity 1000
	// the api range (4001-5000) runs straight into the peer range (5001-6000)
	// only because it stops one short. At 1001 it collides.
	it('rejects a capacity that walks the api range into the peer range', () => {
		expect(() => validatePortLayout({ ...LAYOUT, capacity: 1001 })).toThrow(
			/api range .* overlaps the peer range|peer range .* overlaps the api range/,
		);
	});

	it('rejects a layout whose derived client range collides with the peer range', () => {
		// peer 5001-5100 derives clients 2379-2478; putting api at 2379 collides
		// with the derived range rather than with any range we chose directly.
		expect(() => validatePortLayout({ ...LAYOUT, apiStart: 2379, capacity: 100 })).toThrow(/derived etcd client range/);
	});

	it('rejects non-positive capacity and invalid ports', () => {
		expect(() => validatePortLayout({ ...LAYOUT, capacity: 0 })).toThrow(PortLayoutError);
		expect(() => validatePortLayout({ ...LAYOUT, peerStart: 0 })).toThrow(/valid TCP port/);
		expect(() => validatePortLayout({ ...LAYOUT, monitoringStart: 70000 })).toThrow(/valid TCP port/);
	});

	it('rejects a range that runs past the top of the port space', () => {
		expect(() => validatePortLayout({ ...LAYOUT, monitoringStart: 65530, capacity: 32 })).toThrow(
			/outside the valid TCP port space/,
		);
	});
});

describe('PortAllocator', () => {
	it('allocates aligned triples from the low end', () => {
		const allocator = new PortAllocator(LAYOUT);
		expect(allocator.allocate()).toEqual({ peerPort: 5001, apiPort: 4001, monitoringPort: 6001 });
		expect(allocator.allocate()).toEqual({ peerPort: 5002, apiPort: 4002, monitoringPort: 6002 });
	});

	it('never hands out two nodes the same peer port', () => {
		const allocator = new PortAllocator(LAYOUT);
		const seen = new Set<number>();
		for (let i = 0; i < LAYOUT.capacity; i++) {
			const { peerPort } = allocator.allocate();
			expect(seen.has(peerPort)).toBe(false);
			seen.add(peerPort);
		}
		expect(seen.size).toBe(LAYOUT.capacity);
	});

	it('rehydrates taken ports from the durable registry and skips them', () => {
		const allocator = new PortAllocator(LAYOUT, [5001, 5002]);
		expect(allocator.used).toBe(2);
		expect(allocator.allocate().peerPort).toBe(5003);
	});

	it('reuses a port only after it is released', () => {
		const allocator = new PortAllocator(LAYOUT);
		const first = allocator.allocate();
		allocator.allocate();
		expect(allocator.allocate().peerPort).toBe(5003);

		allocator.release(first.peerPort);
		expect(allocator.allocate().peerPort).toBe(5001);
	});

	it('refuses to exhaust silently', () => {
		const allocator = new PortAllocator({ ...LAYOUT, capacity: 2 });
		allocator.allocate();
		allocator.allocate();
		expect(() => allocator.allocate()).toThrow(PortExhaustedError);
		expect(() => allocator.allocate()).toThrow(/add another host/);
	});

	it('rejects rehydrating a duplicate or out-of-range port', () => {
		expect(() => new PortAllocator(LAYOUT, [5001, 5001])).toThrow(/already allocated/);
		expect(() => new PortAllocator(LAYOUT, [9999])).toThrow(/outside the configured range/);
	});

	it('tracks free capacity', () => {
		const allocator = new PortAllocator({ ...LAYOUT, capacity: 3 });
		expect(allocator.free).toBe(3);
		const triple = allocator.allocate();
		expect(allocator.free).toBe(2);
		allocator.release(triple.peerPort);
		expect(allocator.free).toBe(3);
	});
});
