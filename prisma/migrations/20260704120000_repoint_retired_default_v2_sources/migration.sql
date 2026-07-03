-- Migrate stale-DEFAULT Web3CardanoV2 payment sources off the retired contract
-- version (Aiken/CIP-30 upgrade: registry policyId 7890b485… -> 67ab0c92…, payment
-- address …qsztux…/older -> …zs4e6wc…) to the current default contract.
--
-- STRATEGY: instead of repointing the retired source in place (which would strand
-- its PaymentRequest / PurchaseRequest history against a contract identity that no
-- longer matches where their on-chain UTxOs live), we CREATE A NEW V2 source at the
-- current contract identity and REUSE the operator's wallets on it:
--   * the managed HotWallets are MOVED to the new source (walletVkey is globally
--     unique, so they cannot be duplicated — a repoint is the only option, and is
--     exactly what "reuse the wallets" means operationally),
--   * the AdminWallet set is CLONED onto the new source (same addresses + signing
--     order, so the new default address re-derives identically),
--   * the PaymentSourceConfig (RPC provider + key) is cloned,
--   * the retired source is SOFT-DELETED, keeping ALL of its history
--     (PaymentRequest / PurchaseRequest / RegistryRequest /
--     InboxAgentRegistrationRequest / PaymentSourceIdentifiers / WebhookEndpoints)
--     dated to it.
-- New registrations/payments happen on the new active source; deregistered agents
-- can be re-registered there (a fresh identifier is minted).
--
-- Why CLONE (not move) admins: the deferred `enforce_v2_admin_quorum` trigger
-- (migrations 20260526001000 / 20260530000000) enforces
-- count(AdminWallets) >= requiredAdminSignatures for EVERY existing V2 row — a
-- soft-deleted row still exists, so draining its admins to 0 would abort the
-- migration at commit. Cloning leaves the old source at quorum while giving the new
-- source its own admin rows. HotWallets are unaffected by that trigger, so they are
-- moved.
--
-- SCOPE: only sources whose registry policyId is the retired one AND whose admin
-- wallets are EXACTLY the 3 seed DEFAULTS (all present, none extra) — an
-- exact-default admin set derives the hardcoded default address, so the new source's
-- default address is correct. Genuinely-CUSTOM sources (any admin != a default, or a
-- subset with a different derived address) are intentionally NOT migrated here — they
-- are surfaced by warnOutOfSyncV2PaymentSources / the frontend "Outdated contract"
-- badge for manual handling (their new address derives from their own admin wallets
-- and cannot be a hardcoded default).
--
-- SAFETY: guarded to at most ONE such source per network, and only when the current
-- default identity is not already occupied — the address is unique across ALL rows
-- (@@unique([network, smartContractAddress]), NOT partial) and the policyId is unique
-- across ACTIVE rows (PaymentSource_network_policyId_active_key). Either collision, or
-- >1 stale-default source, is skipped (RAISE NOTICE) rather than aborting. Because the
-- new identity is occupied after a successful run, a re-run is a no-op (idempotent).
-- NOTE: on-chain funds locked at the OLD address are NOT moved by this (they need the
-- OLD validator) — drain/settle them first per
-- docs/migrations/v2-contract-cip30-upgrade.md.

-- Action helper: clone config + admins, move hot wallets, soft-delete the retired
-- source. Temporary (pg_temp) so it is dropped automatically when the migration
-- session ends. Returns the new source id for the NOTICE.
CREATE FUNCTION pg_temp.migrate_retired_v2_source(
  p_old_id text,
  p_new_address text,
  p_new_policy text
) RETURNS text AS $fn$
DECLARE
  new_cfg_id text := md5(random()::text || clock_timestamp()::text || 'cfg');
  new_ps_id  text := md5(random()::text || clock_timestamp()::text || 'ps');
BEGIN
  -- 1. Clone the RPC config (1:1 with PaymentSource via a unique FK).
  INSERT INTO "PaymentSourceConfig" (id, "createdAt", "updatedAt", "rpcProviderApiKey", "rpcProvider")
  SELECT new_cfg_id, now(), now(), cfg."rpcProviderApiKey", cfg."rpcProvider"
  FROM "PaymentSource" ps
  JOIN "PaymentSourceConfig" cfg ON cfg.id = ps."paymentSourceConfigId"
  WHERE ps.id = p_old_id;

  -- 2. Create the new active V2 source at the current contract identity, copying
  --    the operational config (quorum, fee rate, cooldown) from the retired one.
  --    adminWalletId stays NULL (V2 uses the AdminWallets[] relation).
  INSERT INTO "PaymentSource" (
    id, "createdAt", "updatedAt", network, "syncInProgress", "paymentSourceType",
    "requiredAdminSignatures", "smartContractAddress", "adminWalletId",
    "feeRatePermille", "cooldownTime", "paymentSourceConfigId", "policyId"
  )
  SELECT
    new_ps_id, now(), now(), ps.network, false, 'Web3CardanoV2',
    ps."requiredAdminSignatures", p_new_address, NULL,
    ps."feeRatePermille", ps."cooldownTime", new_cfg_id, p_new_policy
  FROM "PaymentSource" ps
  WHERE ps.id = p_old_id;

  -- 3. Clone the admin set onto the new source (same addresses + order -> same
  --    derived default address). The old rows are left in place so the
  --    soft-deleted source still satisfies its own deferred quorum trigger.
  INSERT INTO "AdminWallet" (id, "createdAt", "updatedAt", "walletAddress", "paymentSourceAdminId", "order")
  SELECT
    md5(random()::text || clock_timestamp()::text || aw."order"::text),
    now(), now(), aw."walletAddress", new_ps_id, aw."order"
  FROM "AdminWallet" aw
  WHERE aw."paymentSourceAdminId" = p_old_id;

  -- 4. Reuse the managed hot wallets: move them to the new source.
  UPDATE "HotWallet"
    SET "paymentSourceId" = new_ps_id, "updatedAt" = now()
    WHERE "paymentSourceId" = p_old_id;

  -- 5. Retire the old source: soft-delete it and stop its sync, keeping ALL of its
  --    history (payments, purchases, registrations, identifiers, webhooks) dated to
  --    it. Not an UPDATE OF requiredAdminSignatures/paymentSourceType, so the
  --    quorum trigger does not fire; its admin rows are untouched anyway.
  UPDATE "PaymentSource"
    SET "deletedAt" = now(), "syncInProgress" = false, "updatedAt" = now()
    WHERE id = p_old_id;

  RETURN new_ps_id;
END;
$fn$ LANGUAGE plpgsql;

DO $$
DECLARE
  target_id text;
  new_id text;
  match_count int;
BEGIN
  -- ---------------------------------------------------------------- PREPROD ----
  SELECT count(*) INTO match_count
  FROM "PaymentSource" ps
  WHERE ps."paymentSourceType" = 'Web3CardanoV2'
    AND ps."network" = 'Preprod'
    AND ps."policyId" = '7890b485b808043ef80136a447a3a43c18893a309dc323d1f8b0a13d'
    AND ps."deletedAt" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "AdminWallet" aw
      WHERE aw."paymentSourceAdminId" = ps.id
        AND aw."walletAddress" NOT IN (
          'addr_test1qr7pdg0u7vy6a5p7cx9my9m0t63f4n48pwmez30t4laguawge7xugp6m5qgr6nnp6wazurtagjva8l9fc3a5a4scx0rq2ymhl3',
          'addr_test1qplhs9snd92fmr3tzw87uujvn7nqd4ss0fn8yz7mf3y2mf3a3806uqngr7hvksqvtkmetcjcluu6xeguagwyaxevdhmsuycl5a',
          'addr_test1qzy7a702snswullyjg06j04jsulldc6yw0m4r4w49jm44f30pgqg0ez34lrdj7dy7ndp2lgv8e35e6jzazun8gekdlsq99mm6w'
        )
    )
    AND (SELECT count(*) FROM "AdminWallet" aw2 WHERE aw2."paymentSourceAdminId" = ps.id) = 3;

  IF match_count > 1 THEN
    RAISE NOTICE 'Skipped Preprod: % retired default V2 sources need manual dedup', match_count;
  ELSIF match_count = 1 THEN
    -- Skip (no abort) if the current default identity is already occupied.
    IF NOT EXISTS (
         SELECT 1 FROM "PaymentSource" p2
         WHERE p2."network" = 'Preprod'
           AND p2."smartContractAddress" = 'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g'
       )
       AND NOT EXISTS (
         SELECT 1 FROM "PaymentSource" p3
         WHERE p3."network" = 'Preprod'
           AND p3."policyId" = '67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b'
           AND p3."deletedAt" IS NULL
       )
    THEN
      SELECT ps.id INTO target_id
      FROM "PaymentSource" ps
      WHERE ps."paymentSourceType" = 'Web3CardanoV2'
        AND ps."network" = 'Preprod'
        AND ps."policyId" = '7890b485b808043ef80136a447a3a43c18893a309dc323d1f8b0a13d'
        AND ps."deletedAt" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "AdminWallet" aw
          WHERE aw."paymentSourceAdminId" = ps.id
            AND aw."walletAddress" NOT IN (
              'addr_test1qr7pdg0u7vy6a5p7cx9my9m0t63f4n48pwmez30t4laguawge7xugp6m5qgr6nnp6wazurtagjva8l9fc3a5a4scx0rq2ymhl3',
              'addr_test1qplhs9snd92fmr3tzw87uujvn7nqd4ss0fn8yz7mf3y2mf3a3806uqngr7hvksqvtkmetcjcluu6xeguagwyaxevdhmsuycl5a',
              'addr_test1qzy7a702snswullyjg06j04jsulldc6yw0m4r4w49jm44f30pgqg0ez34lrdj7dy7ndp2lgv8e35e6jzazun8gekdlsq99mm6w'
            )
        )
        AND (SELECT count(*) FROM "AdminWallet" aw2 WHERE aw2."paymentSourceAdminId" = ps.id) = 3;
      new_id := pg_temp.migrate_retired_v2_source(
        target_id,
        'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g',
        '67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b'
      );
      RAISE NOTICE 'Migrated retired default V2 Preprod source % -> new source % (wallets reused, old source soft-deleted with history)', target_id, new_id;
    ELSE
      RAISE NOTICE 'Skipped Preprod: a retired default V2 source exists but the current default identity is already occupied (active or soft-deleted) — manual handling needed';
    END IF;
  END IF;

  -- ---------------------------------------------------------------- MAINNET ----
  SELECT count(*) INTO match_count
  FROM "PaymentSource" ps
  WHERE ps."paymentSourceType" = 'Web3CardanoV2'
    AND ps."network" = 'Mainnet'
    AND ps."policyId" = '7890b485b808043ef80136a447a3a43c18893a309dc323d1f8b0a13d'
    AND ps."deletedAt" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "AdminWallet" aw
      WHERE aw."paymentSourceAdminId" = ps.id
        AND aw."walletAddress" NOT IN (
          'addr1q87pdg0u7vy6a5p7cx9my9m0t63f4n48pwmez30t4laguawge7xugp6m5qgr6nnp6wazurtagjva8l9fc3a5a4scx0rqfjxhnw',
          'addr1q9lhs9snd92fmr3tzw87uujvn7nqd4ss0fn8yz7mf3y2mf3a3806uqngr7hvksqvtkmetcjcluu6xeguagwyaxevdhmslj9lcz',
          'addr1qxy7a702snswullyjg06j04jsulldc6yw0m4r4w49jm44f30pgqg0ez34lrdj7dy7ndp2lgv8e35e6jzazun8gekdlsqxnxmk3'
        )
    )
    AND (SELECT count(*) FROM "AdminWallet" aw2 WHERE aw2."paymentSourceAdminId" = ps.id) = 3;

  IF match_count > 1 THEN
    RAISE NOTICE 'Skipped Mainnet: % retired default V2 sources need manual dedup', match_count;
  ELSIF match_count = 1 THEN
    IF NOT EXISTS (
         SELECT 1 FROM "PaymentSource" p2
         WHERE p2."network" = 'Mainnet'
           AND p2."smartContractAddress" = 'addr1wxs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgge2j6d'
       )
       AND NOT EXISTS (
         SELECT 1 FROM "PaymentSource" p3
         WHERE p3."network" = 'Mainnet'
           AND p3."policyId" = '67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b'
           AND p3."deletedAt" IS NULL
       )
    THEN
      SELECT ps.id INTO target_id
      FROM "PaymentSource" ps
      WHERE ps."paymentSourceType" = 'Web3CardanoV2'
        AND ps."network" = 'Mainnet'
        AND ps."policyId" = '7890b485b808043ef80136a447a3a43c18893a309dc323d1f8b0a13d'
        AND ps."deletedAt" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "AdminWallet" aw
          WHERE aw."paymentSourceAdminId" = ps.id
            AND aw."walletAddress" NOT IN (
              'addr1q87pdg0u7vy6a5p7cx9my9m0t63f4n48pwmez30t4laguawge7xugp6m5qgr6nnp6wazurtagjva8l9fc3a5a4scx0rqfjxhnw',
              'addr1q9lhs9snd92fmr3tzw87uujvn7nqd4ss0fn8yz7mf3y2mf3a3806uqngr7hvksqvtkmetcjcluu6xeguagwyaxevdhmslj9lcz',
              'addr1qxy7a702snswullyjg06j04jsulldc6yw0m4r4w49jm44f30pgqg0ez34lrdj7dy7ndp2lgv8e35e6jzazun8gekdlsqxnxmk3'
            )
        )
        AND (SELECT count(*) FROM "AdminWallet" aw2 WHERE aw2."paymentSourceAdminId" = ps.id) = 3;
      new_id := pg_temp.migrate_retired_v2_source(
        target_id,
        'addr1wxs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgge2j6d',
        '67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b'
      );
      RAISE NOTICE 'Migrated retired default V2 Mainnet source % -> new source % (wallets reused, old source soft-deleted with history)', target_id, new_id;
    ELSE
      RAISE NOTICE 'Skipped Mainnet: a retired default V2 source exists but the current default identity is already occupied (active or soft-deleted) — manual handling needed';
    END IF;
  END IF;
END $$;
