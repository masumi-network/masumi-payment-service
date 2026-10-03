import { describe, expect, it } from '@jest/globals';
import { ApiKeyStatus } from '@/generated/prisma/client';
import { addAPIKeySchemaInput, updateAPIKeySchemaInput } from './schemas';

describe('updateAPIKeySchemaInput', () => {
	it('leaves usageLimited undefined when the field is absent', () => {
		// A PATCH is partial: an omitted field must reach Prisma as `undefined` so the
		// column keeps its stored value. `.default(true).optional()` did the opposite,
		// because zod applies a default whenever the key is ABSENT. The update dialog
		// never sends this field, so every save silently capped the key. With no
		// RemainingUsageCredits rows the credit gate in runPurchaseCreditInitTransaction
		// then threw `Credit unit not found` on every purchase, which the route maps to
		// a bare 400 'Insufficient funds' with no purchase row written.
		const parsed = updateAPIKeySchemaInput.parse({ id: 'key-id' });
		expect(parsed.usageLimited).toBeUndefined();
		expect('usageLimited' in parsed).toBe(false);
	});

	it('leaves status undefined when the field is absent', () => {
		// Same defect on status: the defaulted `Active` re-activated a Revoked key on
		// any unrelated edit, because the route writes `status: input.status` outright.
		const parsed = updateAPIKeySchemaInput.parse({ id: 'key-id' });
		expect(parsed.status).toBeUndefined();
		expect('status' in parsed).toBe(false);
	});

	it('keeps an explicit usageLimited value in both directions', () => {
		expect(updateAPIKeySchemaInput.parse({ id: 'key-id', usageLimited: true }).usageLimited).toBe(true);
		expect(updateAPIKeySchemaInput.parse({ id: 'key-id', usageLimited: false }).usageLimited).toBe(false);
	});

	it('keeps an explicit status value', () => {
		expect(updateAPIKeySchemaInput.parse({ id: 'key-id', status: ApiKeyStatus.Revoked }).status).toBe(
			ApiKeyStatus.Revoked,
		);
	});

	it('does not force usageLimited on a plain admin promotion', () => {
		// The route rejects `newCanAdmin && input.usageLimited` with 400 'Admin API keys
		// cannot have usage limits'. While the default filled `true`, the documented
		// promotion call was impossible: every PATCH {id, canAdmin: true} was rejected
		// for a flag the caller never set.
		const parsed = updateAPIKeySchemaInput.parse({ id: 'key-id', canAdmin: true });
		expect(parsed.canAdmin).toBe(true);
		expect(parsed.usageLimited).toBeUndefined();
	});
});

describe('addAPIKeySchemaInput', () => {
	it('leaves usageLimited undefined when the field is absent', () => {
		// This test previously pinned the schema default, on the reasoning that create
		// writes a whole row so a default is harmless there. That was wrong: the route
		// rejects `isAdmin && usageLimited`, so the default made the documented admin
		// create call (POST /api-key {permission: 'Admin'}) fail with 400 'Admin API
		// keys cannot have usage limits' for a flag the caller never sent. The default
		// now lives in `resolveCreateUsageLimited`, which can still tell an omitted
		// field from an explicit one.
		const parsed = addAPIKeySchemaInput.parse({ UsageCredits: [] });
		expect(parsed.usageLimited).toBeUndefined();
	});

	it('keeps an explicit usageLimited value in both directions', () => {
		expect(addAPIKeySchemaInput.parse({ UsageCredits: [], usageLimited: 'true' }).usageLimited).toBe(true);
		expect(addAPIKeySchemaInput.parse({ UsageCredits: [], usageLimited: 'false' }).usageLimited).toBe(false);
	});
});
