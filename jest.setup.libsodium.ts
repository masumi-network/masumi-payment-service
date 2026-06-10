// Mesh SDK (`@meshsdk/core` / `@meshsdk/core-cst`) loads `libsodium-wrappers-sumo`,
// whose WASM backend initializes ASYNCHRONOUSLY via a `.ready` promise. When a
// test file finishes before that init settles, Jest tears the module registry
// down; libsodium's late `require('libsodium-sumo')` (its `useBackupModule`
// fallback inside the `.ready` continuation) then throws:
//
//   ReferenceError: You are trying to `require` a file after the Jest
//   environment has been torn down.
//
// That rejection is unhandled and crashes the worker (`UnhandledPromiseRejection`,
// non-zero exit) even though every test PASSED.
//
// Forcing the init to complete BEFORE any test runs makes those continuations
// fire during the test lifecycle instead of after teardown. libsodium is a
// singleton (pinned to a single 0.7.15 copy via the root `overrides`), so the
// instance we await here is the same one Mesh later uses — awaiting it once is
// enough and adds no measurable time to suites that don't touch crypto.
// The package ships no type declarations, so the default import is untyped.
// Assert the single member we depend on rather than pulling in @types.
import sodium from 'libsodium-wrappers-sumo';

const sodiumReady = (sodium as { ready: Promise<void> }).ready;

beforeAll(async () => {
	await sodiumReady;
});
