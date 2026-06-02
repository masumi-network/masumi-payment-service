// Mesh SDK pinning: this file lives in the V2 package and the
// `MeshV2BlockfrostProvider` type below MUST resolve to the V2 mesh line
// (`@meshsdk/core@1.9.0-beta.102`). The cast in `asV2Provider` bridges the
// V1-pinned provider (`@/services/shared` -> V1 mesh) into the V2-typed
// surface used by the V2 batch builders. Their runtime shapes are identical
// for the methods we touch (`evaluateTx`, `fetchProtocolParameters`,
// `fetchUTxOs`); the type mismatch is purely nominal from TypeScript's
// private-property check. See docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
import type { BlockfrostProvider as MeshV2BlockfrostProvider } from '@meshsdk/core';

/**
 * Cast a V1 MeshSDK provider to the V2-compatible type. Documented in ADR-0005:
 * the V1/V2 Mesh lines coexist intentionally; this cast bridges the type seam.
 *
 * Centralizing the cast makes it greppable when we audit which call sites
 * cross the V1/V2 boundary.
 */
export function asV2Provider(provider: unknown): MeshV2BlockfrostProvider {
	return provider as MeshV2BlockfrostProvider;
}
