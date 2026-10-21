# Hydra 2.4.1: largest single output a fanout can move

Date: 2026-10-21. Network: local devnet with preprod L1 limits. hydra-node
`2.4.1-099f5dd7` (sha256 matches the pin in `hydra-l2-flow/hydra-native.sh`).
Three nodes, contestation period 5 s. Every figure here was measured in that
run unless it is tagged INFERRED. ADR 0013 uses these figures.

## Result

| What                                          | Value                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------- |
| Largest output that fans out                  | inline datum 15,421 bytes, serialized TxOut 15,468 bytes              |
| Smallest output that fails                    | inline datum 15,422 bytes, serialized TxOut 15,469 bytes              |
| Limit that fails                              | L1 `maxTxSize`                                                        |
| Fanout tx size for one output                 | serialized TxOut + 917 bytes, constant from 8,000 to 15,421 bytes     |
| Ex-units at the limit (head validator)        | steps 5,042,004,816 (50.4 %), memory 2,758,928 (16.7 %)               |
| Largest datum a deposit can bring into a head | between 15,260 and 15,279 bytes (deposit tx is about datum + 1,118 B) |
| Largest datum an L2 tx can create             | L2 `maxTxSize` minus about 280 bytes                                  |

The boundary transactions:

- 15,421 bytes: L1 tx
  `3dd87b5bf6a9c64ddee1c38619787f958f9c1d7d1a7a347b22754e7add080dec`, 16,384
  bytes as the ledger counts it.
- 15,422 bytes: the node built, balanced and submitted the tx. L1 rejected it
  with `MaxTxSizeUTxO Mismatch (RelLTEQ) {supplied: 16385, expected: 16384}`.
- From 15,422 to at least 15,500 bytes, the unbalanced tx passes the node's
  fit check and the balanced tx then fails on L1. At 15,800 bytes and above,
  the fit check refuses first with `FailedToConstructPartialFanoutTx`.

## What it means

- An output that comes to rest above the limit can never leave the head. A
  `FinalPartialFanoutTx` must carry every remaining output in one tx, so the
  head can drain everything else and still never reach `Final`. Two heads in
  the run stayed in `FanningOut` for this reason.
- CPU and memory are far from their limits for one large output. Size is the
  only binding limit.
- A deposit cannot bring in an output that fanout cannot move out, because the
  deposit tx carries the output twice (INFERRED from the two slopes above).
- With L2 `maxTxSize` at 16,384, an L2 tx can create an output with a datum up
  to about 16,104 bytes (INFERRED from the 280-byte L2 overhead). The band
  from 15,422 to 16,104 bytes is what a hostile peer could use.

## The policy this sets

The shipped L2 ledger (`packages/hydra-host/params/base/preprod.json`) uses
`maxTxSize` 15,000. Any output an L2 tx can then create is smaller than
15,000 bytes, so its fanout tx is smaller than 15,917 bytes. That is at least
467 bytes under L1's 16,384. The margin covers:

- a node wallet with a base address instead of an enterprise address (28
  bytes more change output, INFERRED);
- extra fee inputs when the node wallet is fragmented.

15,000 also stays above what this service builds in a head. The V2 escrow
validator is 9,892 bytes and goes inline into every escrow spend, and the V2
builders cap an unsigned tx at 14,000 bytes (`MAX_SAFE_TX_BYTES` in
`packages/payment-source-v2/src/builders/batch-helpers.ts`).

`packages/hydra-host/src/ledger-params.spec.ts` fails if the shipped value
plus the measured 917-byte envelope reaches L1's limit.

## Blind spots

- Measured on devnet only, not on preprod. The devnet ran three participants,
  so the head output carried one more participant token than a two-party head
  does. A two-party envelope is therefore a few bytes smaller (INFERRED).
- The devnet's default `maxTxExUnits` memory is 14,000,000. It was raised to
  16,500,000 to match preprod.
- The envelope depends on the hydra-node version. A version change needs this
  measurement again.
- The output count per step is bound by CPU, not by size. One step with 12
  small outputs used 7,192,239,309 steps. That is the separate chunking limit
  in ADR 0013, and it is not covered here.

## Method

1. Open a head and park outputs with one Plutus bytestring datum of a known
   size at a plain key address. The serialized TxOut is the datum plus 47
   bytes.
2. Close the head and wait for `ReadyToFanout`.
3. Send `PartialFanout` with one oversized output per step, from smallest to
   largest. A failed selection can be retried with another output.
4. Read each posted L1 tx back from the node for its size, fee and ex-units.
