-- Chain-replay anchor for hydra-node persistence-loss recovery: the block
-- point immediately BEFORE the block carrying the head's InitTx. A wiped
-- hydra-node restarted with `--start-chain-from <slot>.<hash>` re-observes the
-- whole head from L1 (verified live on preprod; see
-- docs/hydra-persistence-recovery-verification.md). Written alongside
-- initTxHash by on-chain verification; the init backfill service heals rows
-- that were verified before these columns existed.
ALTER TABLE "HydraHead" ADD COLUMN "initChainSlot" BIGINT,
ADD COLUMN "initChainHash" TEXT;
