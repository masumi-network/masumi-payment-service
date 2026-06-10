// Mesh SDK (`@meshsdk/core` / `@meshsdk/core-cst`) loads `libsodium-wrappers-sumo`,
// whose WASM backend initializes ASYNCHRONOUSLY via a `.ready` promise. Its ready
// continuation does a lazy `require('libsodium-sumo')` that can land AFTER Jest
// tears the environment down, throwing "require ... after the Jest environment
// has been torn down" — which Node would otherwise turn into a fatal
// UnhandledPromiseRejection even though every test PASSED.
//
// This file is only the FIRST line of defense: awaiting `.ready` before tests run
// forces most continuations to fire during the test lifecycle, so short unit
// suites never hit the race. It is NOT sufficient on its own — a process-level
// `unhandledRejection` handler can't help because it's registered inside the Jest
// environment sandbox and is destroyed on teardown, before the late rejection
// fires. The actual guarantee comes from `--unhandled-rejections=warn` in the
// test scripts' NODE_OPTIONS (a process-mode flag the workers inherit), which
// keeps a residual late rejection non-fatal. See package.json `test*` scripts.
//
// Typed via the ambient declaration in src/libsodium-wrappers-sumo.d.ts.
import sodium from 'libsodium-wrappers-sumo';

beforeAll(async () => {
	await sodium.ready;
});
