---
id: '16'
title: Reference script or inline attachment
type: grilling
status: open
assignee:
blocked_by: []
---

# Reference script or inline attachment

## Question

The wallet validator is parameterized per wallet, so **no reference script can
be shared between wallets** — each wallet's script is a distinct program with a
distinct hash. Epora's trick of deploying one script at an always-fail store
and referencing it from every spend is unavailable here; the equivalent would be
one store UTxO per wallet.

So every wallet spend either:

- **Attaches the script inline**, paying its bytes on every transaction. That
  lands on paths already checked against `MAX_SAFE_TX_BYTES = 14_000`
  (`builders/batch-helpers.ts:425`), and `batch-payments` is about to gain a
  script input it never had. Registry register already shrinks batches purely
  for size.
- **Reads it from a per-wallet reference UTxO**, paying min-ADA once — scaled by
  the script's size, since reference scripts are charged per byte — and needing
  somewhere safe to park it that nobody can spend.

The trade turns on the compiled size, which will not exist until the validator
is written. What *is* decidable now is the policy: the threshold above which a
reference script is worth its locked ADA, where the store lives, who funds it,
and whether losing it should be recoverable.

Worth noting the design already forbids reference scripts on the continuing
output — the prototype requires `continuing.reference_script` to equal the
input's — so the wallet UTxO itself is not the place to park one.

## What a resolution looks like

A rule for choosing between the two given a measured script size, the location
and funding of the store if reference scripts win, and an explicit note of what
it costs per wallet.
