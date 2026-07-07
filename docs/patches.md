# Dependency patches

Patches in [`patches/`](../patches/) are applied automatically by pnpm on install
(via `patchedDependencies` resolution). This file documents why each patch exists
and what to check when bumping the patched dependency.

## `@sundaeswap__core.patch`

**What it does:** Removes the Blaze `V1Types` re-export from the
`@sundaeswap/core` dist files (`dist/cjs/...` and `dist/esm/...`).

**Why:** Importing `V1Types` transitively loads `@blaze-cardano/sdk` at module
init. This repo only uses the Lucid code path of `@sundaeswap/core`, so loading
Blaze is pure startup cost and drags in an extra Cardano serialization stack.

**When it breaks:** The patch pins exact dist file contents. Any version bump of
`@sundaeswap/core` will likely fail to apply (pnpm errors during install) or —
worse — apply against a restructured dist and silently miss the new Blaze import
site.

**On bump, do this:**

1. Check whether upstream now ships the Lucid/Blaze split as separate entry
   points; if so, drop the patch and import the Lucid entry point directly.
2. Otherwise regenerate: `pnpm patch @sundaeswap/core`, re-apply the `V1Types`
   removal in the new dist layout, `pnpm patch-commit`.
3. Verify startup does not load Blaze:
   `node -e "require('./dist/index.js')"` and confirm no `@blaze-cardano/*`
   modules appear in the module cache / startup logs.
