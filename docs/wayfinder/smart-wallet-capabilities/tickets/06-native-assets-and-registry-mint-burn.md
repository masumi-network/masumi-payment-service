---
id: '06'
title: Native assets and registry mint/burn
type: grilling
status: closed
assignee: sandro
blocked_by: ['11']
---

# Native assets and registry mint/burn

## Question

The prototype freezes native assets: an agent spend must leave the wallet's
non-ADA value byte-identical, so an agent budgeted in lovelace cannot walk off
with an NFT. Registry operations contradict that — registering mints an agent
NFT, deregistering burns one, and the wallet would be holding it in between.

What is the asset policy?

- A **per-policy allow-list** in the datum, letting the agent move only tokens
  of named policies, with the freeze still applying to everything else?
- A **mint-aware exemption**, where value that the transaction itself mints or
  burns is excluded from the equality check?
- Or do **registry NFTs stay outside the wallet** entirely, held by a plain key,
  leaving the wallet a pure lovelace treasury?

Whichever wins, decide what stops the exemption from becoming a hole: a burn
that is really a transfer, or a mint that smuggles value out.

## What a resolution looks like

The rule governing non-ADA value on an agent spend, and how registry
register/deregister satisfies it without giving the agent general authority
over tokens.

## Update from the transaction inventory

Registry NFTs are **key-bound today, structurally**. `findRegistryTokenUtxo`
searches only the signing wallet's own UTxOs and throws otherwise
(`src/services/registry/shared.ts:191-208`); the NFT UTxO is force-added as a
bare `txIn` with no redeemer (`builders/batch-registry.ts:420-426, 593-599`);
mint asset names derive from a spent input's reference
(`:34-38`); and the mint paths rely on `firstUtxo == collateralUtxo` overlap,
legal only for key-locked UTxOs (`:100-128, 184-189`).

That pushes the question toward the third option: the wallet **funds** registry
deposits but never holds the NFT. Confirm that reading of the operator's "mint
and burn in scope" — funding the deposit, not custody of the token — before
designing any asset rule.

## Update from the control-surface decision

[Control surface — does a budget still earn its place](09-control-surface-does-a-budget-still-earn-its-place.md)
dropped the recipient allow-list, which removes one obstacle here: registry
funding pays to the signing wallet's own key address, and there is no longer a
destination rule for that to violate.

It also **raised the stakes on this ticket**. The ceiling is now denominated in
assets, not lovelace, so a blanket freeze on non-ADA value is off the table —
budgeted stablecoins have to be able to move. The working assumption recorded
there is:

> assets with a limit entry are spendable up to that limit; assets with no
> limit entry are frozen.

This ticket has to confirm or replace that rule, and settle the two cases it
does not cover:

- **Minting and burning.** A transaction that mints or burns changes the
  wallet's asset set without anything "leaving". Does minted value count as
  inflow, does burned value count as outflow, and can an agent burn a token it
  could not otherwise move?
- **Assets arriving.** Whether an agent spend may *add* an unlisted asset to
  the continuing output, or whether unlisted assets are frozen in both
  directions.

  Note: a third party cannot contaminate the live wallet UTxO. Changing a UTxO
  means spending it, which means satisfying the validator — so an outsider can
  only create a separate junk UTxO at the address, which `OwnerSpend` clears
  and which datum-aware UTxO selection already skips.

## Resolution

**Unlisted assets are frozen in both directions**, and this needs no special
case — it falls out of the general rule already adopted for the ceiling:

> For every asset, `outflow >= 0`. For every asset with `outflow > 0`, a limit
> entry must exist and `spent_in_period + outflow <= limit`.

Removing an unlisted asset gives a positive outflow with no limit entry to
charge, so it fails. Adding one gives a negative outflow, so it fails on the
first clause — the same clause that stops an agent shrinking its own counters
by depositing. One rule, both directions, no branch for the unlisted case.

**The wallet never holds registry NFTs.** It supplies the funding lovelace for
a mint or an update; the minted token is paid to the signing key's address,
exactly as the builders do today. The NFT never enters the wallet UTxO.

### What this spares the validator

- **No mint-aware exemption**, and no rule distinguishing a genuine burn from a
  transfer. The validator can stay entirely ignorant of the mint field.
- **No registry policy ids** in the datum or parameters. The wallet does not
  know what a registry NFT is.
- **Minting into the continuing output is already blocked** by the general
  rule — a minted asset landing there is a negative outflow for an unlisted
  asset. The single rule covers an attack it was not written for.
- The wallet's value delta in a registry transaction is therefore
  **lovelace-only**, charged to the lovelace budget like any other spend.

### Which registry transactions carry a wallet input

Register and update do — they spend wallet principal as funding lovelace.
**Deregister does not.** It spends no wallet principal: the burn consumes an
NFT UTxO held by the key, and that UTxO's min-ADA recycles into change. By the
same principle that keeps the wallet out of the escrow-spending transactions
([Treasury behind a key buyer, or a script buyer in escrow](11-treasury-behind-a-key-buyer-or-a-script-buyer.md)),
the wallet stays out of deregister entirely.

This also keeps `findRegistryTokenUtxo`
(`src/services/registry/shared.ts:191-208`), the asset-name derivation from a
spent input (`builders/batch-registry.ts:34-38`), and the deliberate
`firstUtxo == collateralUtxo` overlap (`:100-128`) working unchanged — all
three depend on the NFT and the deriving input being key-locked.
