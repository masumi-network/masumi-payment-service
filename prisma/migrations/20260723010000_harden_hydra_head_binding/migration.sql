-- A relation represents one sequential two-party Hydra channel. A second head
-- may be created only after the prior one reaches Final. The API performs the
-- same check for a clear 409; this migration supplies the cross-replica race
-- backstops for both head creation and remote-participant assignment.
--
-- Keep the preflight and trigger installation atomic. The table locks prevent
-- a surviving writer from adding a conflicting participant between the legacy
-- data check and trigger creation.
BEGIN;

SELECT pg_advisory_xact_lock(hashtextextended('masumi:harden-hydra-head-binding', 0));

LOCK TABLE
  "HydraHead",
  "HydraRemoteParticipant"
IN SHARE ROW EXCLUSIVE MODE;

-- Index creation intentionally fails closed if legacy non-Final heads violate
-- the one-active-head-per-relation model.
CREATE UNIQUE INDEX "HydraHead_one_non_final_per_relation_key"
ON "HydraHead"("hydraRelationId")
WHERE "status" <> 'Final';

-- Final heads may contain historical multi-party associations imported from
-- older deployments. Only active (non-Final) two-party heads must have at most
-- one remote participant. Fail with a repairable row id instead of making the
-- entire migration undeployable because a Final legacy head has multiple rows.
DO $$
DECLARE
  duplicate_head_id TEXT;
BEGIN
  SELECT head."id"
  INTO duplicate_head_id
  FROM "HydraHead" head
  JOIN "HydraRemoteParticipant" participant
    ON participant."hydraHeadId" = head."id"
  WHERE head."status" <> 'Final'
  GROUP BY head."id"
  HAVING COUNT(*) > 1
  ORDER BY head."id"
  LIMIT 1;

  IF duplicate_head_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce one remote participant per non-Final Hydra head: head % has multiple participants',
      duplicate_head_id
      USING
        ERRCODE = '23505',
        CONSTRAINT = 'HydraRemoteParticipant_one_per_non_final_head',
        HINT = 'Finalize the head or remove duplicate remote-participant assignments before rerunning the migration.';
  END IF;
END $$;

-- Locking the referenced head before checking serializes assignments across
-- replicas. A BEFORE trigger is important: the second writer waits before its
-- participant row is inserted, then observes the first committed assignment.
CREATE FUNCTION enforce_hydra_remote_participant_assignment()
RETURNS TRIGGER AS $$
DECLARE
  head_status "HydraHeadStatus";
BEGIN
  SELECT head."status"
  INTO head_status
  FROM "HydraHead" head
  WHERE head."id" = NEW."hydraHeadId"
  FOR UPDATE;

  -- Let the foreign-key constraint report a missing head.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF head_status <> 'Final' AND EXISTS (
    SELECT 1
    FROM "HydraRemoteParticipant" participant
    WHERE participant."hydraHeadId" = NEW."hydraHeadId"
      AND participant."id" IS DISTINCT FROM NEW."id"
  ) THEN
    RAISE EXCEPTION
      'Hydra head % already has a remote participant',
      NEW."hydraHeadId"
      USING
        ERRCODE = '23505',
        CONSTRAINT = 'HydraRemoteParticipant_one_per_non_final_head';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_hydra_remote_participant_assignment_on_insert
BEFORE INSERT ON "HydraRemoteParticipant"
FOR EACH ROW
WHEN (NEW."hydraHeadId" IS NOT NULL)
EXECUTE FUNCTION enforce_hydra_remote_participant_assignment();

CREATE TRIGGER enforce_hydra_remote_participant_assignment_on_update
BEFORE UPDATE OF "hydraHeadId" ON "HydraRemoteParticipant"
FOR EACH ROW
WHEN (
  NEW."hydraHeadId" IS NOT NULL
  AND NEW."hydraHeadId" IS DISTINCT FROM OLD."hydraHeadId"
)
EXECUTE FUNCTION enforce_hydra_remote_participant_assignment();

-- A Final legacy head with multiple remote rows cannot be reopened without
-- violating the active two-party model. Updating the head already holds its row
-- lock, which also serializes this check with the assignment trigger above.
CREATE FUNCTION enforce_hydra_head_remote_participant_count()
RETURNS TRIGGER AS $$
DECLARE
  participant_count BIGINT;
BEGIN
  SELECT COUNT(*)
  INTO participant_count
  FROM "HydraRemoteParticipant" participant
  WHERE participant."hydraHeadId" = NEW."id";

  IF participant_count > 1 THEN
    RAISE EXCEPTION
      'Cannot transition Hydra head % from Final with % remote participants',
      NEW."id",
      participant_count
      USING
        ERRCODE = '23505',
        CONSTRAINT = 'HydraRemoteParticipant_one_per_non_final_head';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_hydra_head_remote_participant_count_on_reopen
BEFORE UPDATE OF "status" ON "HydraHead"
FOR EACH ROW
WHEN (OLD."status" = 'Final' AND NEW."status" <> 'Final')
EXECUTE FUNCTION enforce_hydra_head_remote_participant_count();

COMMIT;
