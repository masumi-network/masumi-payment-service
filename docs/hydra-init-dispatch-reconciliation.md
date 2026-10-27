# Hydra Init dispatch admission and reconciliation

## What the marker means

- VERIFIED (source): `prisma/models/hydra-head.prisma:19-22` stores one `initDispatchToken` per head. The conditional update in `src/routes/api/hydra/head/init-guard.ts:20-35` allows one Idle, enabled head to acquire it.
- VERIFIED (source): `src/routes/api/hydra/head/lifecycle.ts:179-194` acquires the token before sending Init through the Host. The route retains it after a timeout or uncertain transport result. It clears the token only for a Host refusal before dispatch, an unsynced command refusal, or a failed InitTx post (`lifecycle.ts:195-223`).
- INFERRED: A retained token means an Init may still reach L1. It does not prove that an InitTx was submitted or confirmed. An Idle node, a 504 response, or elapsed time does not prove that retrying is safe.
- VERIFIED (source): The separate Host admin route dispatches Init without reading the payment database (`packages/hydra-host/src/api/server.ts:392-395`, `packages/hydra-host/src/api/privileged-init.ts:17-25`). This marker guards the payment service route. Restrict direct Host admin Init to the same operator reconciliation procedure.

## Deployment

1. VERIFIED (source): The migration `prisma/migrations/20261027000200_hydra_init_dispatch_admission/migration.sql:1` adds a nullable column. Existing heads start with a null token.
2. INFERRED: Pause new Hydra Init requests and let current requests settle before applying the migration and deploying the new service. A request started by the old service cannot acquire this marker. Inspect any Idle head with an uncertain Init result before resuming Init requests.

## Resolve a held head

1. VERIFIED (source): An Init already observed by the node moves the head from Idle. The route refuses another Init when the stored status is not Idle (`src/routes/api/hydra/head/lifecycle.ts:102-104`). If L1 confirms the Init, use the existing head verification and node synchronization path. Keep the token.
2. INFERRED: For an Idle head with a token, check the Host and hydra-node command records and identify the first InitTx if it was built. Check its L1 status with an independent chain observer. A missing result from a search is not proof that the transaction cannot confirm.
3. INFERRED: Clear the token only after positive evidence that the first Init was never sent, that posting failed, or that its identified transaction can no longer confirm. For example, a different confirmed transaction spending the same seed input makes the first InitTx invalid. Stop the affected node and disable the head while checking this evidence. If the outcome remains uncertain, keep the head disabled and the token set.
4. VERIFIED (source): Once the head is disabled and the first attempt is proven dead, an operator can compare the saved token and clear only that attempt. The following SQL also requires Idle status and no observed head or InitTx. Replace both placeholders after reviewing the row. A zero-row result means the state changed; stop and investigate. Re-enable through the existing Hydra head control after the reset.

```sql
UPDATE "HydraHead"
SET "initDispatchToken" = NULL, "updatedAt" = NOW()
WHERE "id" = '<reviewed head id>'
  AND "initDispatchToken" = '<reviewed token>'
  AND "status" = 'Idle'
  AND "isEnabled" = false
  AND "headIdentifier" IS NULL
  AND "initTxHash" IS NULL
RETURNING "id";
```

## Least confident decisions

1. INFERRED: Automatic marker expiry is unsafe. The service does not store the original InitTx hash or seed input before dispatch, so it cannot prove that an uncertain attempt has expired or become invalid. Manual recovery may be needed for a head that remains Idle.
