-- Repoint stale-DEFAULT Web3CardanoV2 payment sources from the retired contract
-- version (Aiken/CIP-30 upgrade: registry policyId 7890b485… -> 67ab0c92…, payment
-- address …qsztux…/older -> …zs4e6wc…) to the current default contract, and wipe
-- their orphaned agent registrations.
--
-- SCOPE: only sources whose registry policyId is the retired one AND whose admin
-- wallets are exactly the seed DEFAULTS (i.e. stale DEFAULT sources). A source's
-- admin wallets derive its payment address, and they already match the defaults,
-- so we only need to move the address + policyId — AdminWallet rows are left
-- untouched (avoiding the onDelete: Restrict FK and the deferrable
-- count(AdminWallets) >= requiredAdminSignatures trigger). Genuinely-CUSTOM
-- sources (admins != defaults) are intentionally NOT migrated here — they are
-- surfaced by warnOutOfSyncV2PaymentSources / the frontend "Outdated contract"
-- badge for manual handling (their correct new address derives from their own
-- admin wallets and cannot be a hardcoded default).
--
-- SAFETY: guarded to at most ONE such source per network (the default identity is
-- unique among active rows: @@unique([network, smartContractAddress]) +
-- PaymentSource_network_policyId_active_key), and only when the default identity
-- is not already occupied. If a network has >1 stale-default retired source, it
-- is skipped for manual dedup. NOTE: this runs unconditionally on every
-- `migrate deploy`; on-chain funds locked at the OLD address are NOT moved by
-- this (they need the OLD validator) — drain/settle them first per
-- docs/migrations/v2-contract-cip30-upgrade.md.

DO $$
DECLARE
  target_id text;
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
    );

  IF match_count = 1 AND NOT EXISTS (
    SELECT 1 FROM "PaymentSource" p2
    WHERE p2."paymentSourceType" = 'Web3CardanoV2' AND p2."network" = 'Preprod'
      AND p2."smartContractAddress" = 'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g'
      AND p2."deletedAt" IS NULL
  ) THEN
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
      );
    DELETE FROM "RegistryRequest" WHERE "paymentSourceId" = target_id;
    DELETE FROM "InboxAgentRegistrationRequest" WHERE "paymentSourceId" = target_id;
    UPDATE "PaymentSource"
      SET "smartContractAddress" = 'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g',
          "policyId" = '67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b',
          "syncInProgress" = false,
          "lastIdentifierChecked" = NULL
      WHERE id = target_id;
    RAISE NOTICE 'Repointed retired default V2 Preprod source % to the current contract', target_id;
  ELSIF match_count > 1 THEN
    RAISE NOTICE 'Skipped Preprod: % retired default V2 sources need manual dedup', match_count;
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
    );

  IF match_count = 1 AND NOT EXISTS (
    SELECT 1 FROM "PaymentSource" p2
    WHERE p2."paymentSourceType" = 'Web3CardanoV2' AND p2."network" = 'Mainnet'
      AND p2."smartContractAddress" = 'addr1wxs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgge2j6d'
      AND p2."deletedAt" IS NULL
  ) THEN
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
      );
    DELETE FROM "RegistryRequest" WHERE "paymentSourceId" = target_id;
    DELETE FROM "InboxAgentRegistrationRequest" WHERE "paymentSourceId" = target_id;
    UPDATE "PaymentSource"
      SET "smartContractAddress" = 'addr1wxs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgge2j6d',
          "policyId" = '67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b',
          "syncInProgress" = false,
          "lastIdentifierChecked" = NULL
      WHERE id = target_id;
    RAISE NOTICE 'Repointed retired default V2 Mainnet source % to the current contract', target_id;
  ELSIF match_count > 1 THEN
    RAISE NOTICE 'Skipped Mainnet: % retired default V2 sources need manual dedup', match_count;
  END IF;
END $$;
