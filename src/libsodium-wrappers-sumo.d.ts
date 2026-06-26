// `libsodium-wrappers-sumo` ships no type declarations. We only consume it in
// `jest.setup.libsodium.ts` to await the async WASM init, so declare just the
// `ready` promise on the default export rather than pulling in @types.
declare module 'libsodium-wrappers-sumo' {
	const sodium: { ready: Promise<void> };
	export default sodium;
}
