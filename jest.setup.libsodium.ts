import { webcrypto } from 'node:crypto';

// Mesh SDK (`@meshsdk/core` / `@meshsdk/core-cst`) loads `libsodium-wrappers-sumo`,
// whose WASM backend initializes ASYNCHRONOUSLY via a `.ready` promise. Its ready
// continuation can lazily initialize secure random support after Jest tears the
// environment down, throwing "require ... after the Jest environment has been
// torn down" or "No secure random number generator found" even though every test
// PASSED.
//
// This file is only the FIRST line of defense: awaiting `.ready` before tests run
// forces most continuations to fire during the test lifecycle, so short unit
// suites never hit the race. It is NOT sufficient on its own — a handler added
// here can't catch a POST-teardown rejection because setup files run inside the
// Jest VM sandbox, on a `process` that is gone by the time the late rejection
// fires. The actual guarantee comes from the `--require ./jest.preload.cjs`
// preload in the test scripts' NODE_OPTIONS, which installs an unhandledRejection
// handler on the REAL worker process (surviving teardown) that drops only the
// libsodium noise and rethrows real faults. See jest.preload.cjs.
//
type SodiumGlobal = typeof globalThis & {
	self?: typeof globalThis;
	crypto?: typeof webcrypto;
};

function installLibsodiumRandomSource(): void {
	const runtimeGlobal = globalThis as SodiumGlobal;

	if (!runtimeGlobal.self) {
		Object.defineProperty(runtimeGlobal, 'self', {
			value: runtimeGlobal,
			configurable: true,
		});
	}

	if (!runtimeGlobal.crypto || typeof runtimeGlobal.crypto.getRandomValues !== 'function') {
		Object.defineProperty(runtimeGlobal, 'crypto', {
			value: webcrypto,
			configurable: true,
		});
	}
}

installLibsodiumRandomSource();

const sodiumReady = import('libsodium-wrappers-sumo').then(async ({ default: sodium }) => {
	await sodium.ready;
});
void sodiumReady.catch(() => undefined);

beforeAll(async () => {
	await sodiumReady;
});
