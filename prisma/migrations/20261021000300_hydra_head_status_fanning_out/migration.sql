-- hydra-node 2.4.1 reports a head whose UTxO is distributed over several
-- partial fanout transactions as FanningOut. It ranks between FanoutPossible
-- and Final. ADD VALUE cannot run in a transaction that then uses the value,
-- so this migration holds nothing else.
ALTER TYPE "HydraHeadStatus" ADD VALUE 'FanningOut' BEFORE 'Final';
