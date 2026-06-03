// Minimal env shim so `packages/payment-core/src/config.ts` survives its
// fail-fast checks when running unit tests under `pnpm run test`. The unit
// suite never touches the database or performs encryption — these values
// only need to satisfy `config.ts`'s top-level validation block. CI workflows
// that DO exercise the real DB (e2e in `.github/workflows/e2e.yml`) override
// both variables before jest runs.
//
// We default-set (`??=`) rather than unconditionally overwrite so a developer
// who exports a real DATABASE_URL locally keeps their value.
if (process.env.DATABASE_URL == null || process.env.DATABASE_URL === '') {
	process.env.DATABASE_URL = 'postgres://jest:jest@localhost:5432/jest-fake-db';
}
if (process.env.ENCRYPTION_KEY == null || process.env.ENCRYPTION_KEY.length <= 20) {
	process.env.ENCRYPTION_KEY = 'jest-fake-encryption-key-32chars-min';
}
