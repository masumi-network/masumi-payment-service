# Read-only API key usage credits

## Decision

Read-only keys (`canRead` true, `canPay` and `canAdmin` false) **do not receive implicit ADA credits**. Callers may omit `UsageCredits` or send an empty array; the create schema defaults to `[]`.

Pay-enabled keys with `usageLimited: true` must supply at least one credit entry at create time.

## Later permission changes

Credits are stored on the key row. If a read-only key is later updated to grant `canPay` while remaining usage-limited, operators must add credits through the update API (`UsageCreditsToAddOrRemove`) before payment endpoints will succeed. The server does not backfill a default on permission promotion.

## Frontend

The dashboard no longer injects a hidden 1000 ADA grant for read-only keys (MAS-531 coordination).
