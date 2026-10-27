# Hydra Init dispatch admission and reconciliation

## What the marker means

- VERIFIED (source): `prisma/models/hydra-head.prisma:19-22` stores one `initDispatchToken` per head. The conditional update in `src/routes/api/hydra/head/init-guard.ts:20-35` allows one Idle, enabled head to acquire it.
- VERIFIED (source): `src/routes/api/hydra/head/lifecycle.ts:179-194` acquires the token before sending Init through the Host. The route retains it after a timeout or uncertain transport result. It clears the token only for a Host refusal before dispatch, an unsynced command refusal, or a failed InitTx post (`lifecycle.ts:195-223`).
- INFERRED: A retained token means an Init may still reach L1. It does not prove that an InitTx was submitted or confirmed. An Idle node, a 504 response, or elapsed time does not prove that retrying is safe.
- VERIFIED (source): The Host admin route writes `NodeRecord.initDispatchAttemptedAt` through `NodeRegistryStore.update` before sending Init (`packages/hydra-host/src/api/privileged-init.ts:17-36`). Both direct Host admin requests and payment service requests use this Host guard (`src/services/hydra-host/client.ts:451-457`). The Host registry serializes updates per node (`packages/hydra-host/src/registry/store.ts:100-110,166-179`). The atomic writer syncs the file and requires directory sync when the Init marker is present. A sync error prevents dispatch (`packages/hydra-host/src/registry/atomic-write.ts:14-27,31-53`, `packages/hydra-host/src/registry/store.ts:135-142`).
- INFERRED: The Host marker records attempted dispatch, not confirmed submission. The Host keeps it after a dispatch error, even when the connection failed before sending. This may require manual recovery for an Init that never reached the node.

## Deployment

1. VERIFIED (source): The migration `prisma/migrations/20261027000200_hydra_init_dispatch_admission/migration.sql:1` adds a nullable column. Existing heads start with a null token.
2. INFERRED: Pause new Hydra Init requests and let current requests settle. Deploy the Host with the durable guard, apply the migration, then deploy the payment service before resuming Init. Old Host records have no Host marker. Inspect every existing Idle head with an uncertain Init result before allowing either Init route. A request started by an old service or Host cannot acquire these markers.

## Resolve a held head

1. VERIFIED (source): An Init already observed by the node moves the head from Idle. The route refuses another Init when the stored status is not Idle (`src/routes/api/hydra/head/lifecycle.ts:108-110`). If L1 confirms the Init, use the existing head verification and node synchronization path. Keep the token.
2. INFERRED: For an Idle head with a token, check the Host and hydra-node command records and identify the first InitTx if it was built. Check its L1 status with an independent chain observer. A missing result from a search is not proof that the transaction cannot confirm.
3. INFERRED: Clear either marker only after positive evidence that the first Init was never sent, that posting failed, or that its identified transaction can no longer confirm. For example, a different confirmed transaction spending the same seed input makes the first InitTx invalid. Stop the affected node and disable the head while checking this evidence. If the outcome remains uncertain, keep the head disabled and both markers set.
4. INFERRED: After proof, stop the node and then the Host. Back up the affected `node.json`, then remove only `initDispatchAttemptedAt` using an atomic file replacement. Confirm the node identity and marker before changing the record. A payment service retry after a confirmed node rejection may have cleared its database token, but the Host marker still needs this operator reset. Do not edit the Host record while its process is running.
5. VERIFIED (source): Once the head is disabled and the first attempt is proven dead, an operator can compare the saved payment service token and clear only that attempt. The following SQL also requires Idle status and no observed head or InitTx. Replace both placeholders after reviewing the row. A zero-row result means the state changed; stop and investigate. Restart the Host and node, then re-enable through the existing Hydra head control after the reset.

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

1. INFERRED: Automatic marker expiry is unsafe. Neither service stores the original InitTx hash or seed input before dispatch, so neither can prove that an uncertain attempt has expired or become invalid. Manual recovery may be needed for a head that remains Idle.
