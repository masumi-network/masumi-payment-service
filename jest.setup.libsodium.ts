// Mesh SDK (`@meshsdk/core` / `@meshsdk/core-cst`) loads `libsodium-wrappers-sumo`,
// whose WASM backend initializes ASYNCHRONOUSLY via a `.ready` promise. Its ready
// continuation does a lazy `require('libsodium-sumo')` that can land AFTER Jest
// tears the environment down, throwing "require ... after the Jest environment
// has been torn down" — which Node would otherwise turn into a fatal
// UnhandledPromiseRejection even though every test PASSED.
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
// Typed via the ambient declaration in src/libsodium-wrappers-sumo.d.ts.
import sodium from 'libsodium-wrappers-sumo';

beforeAll(async () => {
	await sodium.ready;
});
