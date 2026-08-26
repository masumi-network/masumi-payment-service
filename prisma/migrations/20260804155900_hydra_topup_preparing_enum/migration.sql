-- Hydra: the Preparing state, alone in its own migration.
--
-- `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block on
-- PostgreSQL before 12, and Prisma wraps each migration in one. Splitting the
-- enum change out means a deploy against an older server fails on nothing else,
-- and the columns it enables move separately.

ALTER TYPE "HydraTopupStatus" ADD VALUE IF NOT EXISTS 'Preparing' BEFORE 'Pending';
