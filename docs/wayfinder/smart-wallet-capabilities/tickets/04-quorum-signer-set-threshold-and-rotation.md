---
id: '04'
title: Quorum signer set, threshold and rotation
type: grilling
status: closed
assignee: sandro
blocked_by: ['03']
---

# Quorum signer set, threshold and rotation

## Question

Who is in the quorum, how many of them must approve, and how does that change
over time?

- Does the signer set and threshold live in the **script parameters** — fixed
  at deployment, part of the address — or in the **datum**, rotatable by the
  owner without moving funds?
- Is the threshold a plain M-of-N, or weighted? The payment V2 contract gives
  an admin extra weight by listing its key twice; that is a deliberate pattern
  in this codebase.
- Does the **owner** path also require quorum, or does the cold key stand
  alone? If the owner alone can rotate the quorum, the quorum's protection is
  only as strong as the owner key it was meant to backstop.
- What happens when a co-signer is lost, compromised, or simply offline — and
  what is the smallest workable N given the answer?

## What a resolution looks like

The storage location, the threshold semantics, the owner path's relationship to
the quorum, and the rotation procedure — including who can execute it and what
it costs.

## Resolution

**Script parameters, immutable.** The signer set and the threshold are baked
into the script hash alongside the owner, so the wallet address itself commits
to its quorum. Nothing on-chain can weaken it — not a compromised hot key, not
a compromised co-signer, not the cold owner. Reading the address is enough to
know the quorum.

**Weighted by repetition**, matching `admin_vks` in `vested_pay.ak`: a key
listed twice carries two votes. The count is over the parameter list, not the
witness set — for each entry in the quorum list that appears in
`extra_signatories`, add one.

**The agent's key never counts — and, amended during implementation, neither
does the owner's.** The hot key signs as the spender and is skipped when
tallying; the cold key is skipped too, so a deployment that lists the owner in
`quorum_vks` cannot quietly turn it into a warm co-signer. Otherwise a
compromised hot key contributes a vote toward approving its own spend, and the
quorum is weaker than it reads in exactly the scenario it exists for.

**No on-chain guard on the configuration.** The validator does not check that
the threshold is reachable, non-zero, or consistent with the list. Deployment
review is the control, as it already is for the payment contract's
`required_admins_multi_sig` and `admin_vks`.

### Consequences

- **Rotation means moving the wallet.** Adding, removing or replacing a
  co-signer changes the script hash and therefore the address. Funds must be
  swept with the cold key and re-deposited at the new address. Losing a
  co-signer key is not a config change, it is a migration. See
  [Migrating a wallet when the quorum changes](12-migrating-a-wallet-when-the-quorum-changes.md).
- **A threshold above the achievable weight bricks the agent path** from the
  moment the wallet is funded, and no on-chain check will catch it. Funds are
  never lost — `OwnerSpend` always works, so a misconfigured wallet is
  recoverable by sweeping to a correctly parameterized address — but automation
  at that address is dead on arrival.
- **A threshold of zero silently disables the quorum forever** at that address,
  leaving the hot key governed only by the ceiling and the allow-list. This is
  the failure mode with no recovery short of migration, and the one deployment
  review must catch.
- **Duplicate keys are load-bearing, not a typo.** An accidental repeat raises
  one co-signer's weight and lowers the effective N. The payment contract's
  README already warns deployment tooling about exactly this; the same warning
  applies here.
- The address now varies with `(owner, quorum set, threshold, wallet_id)`. The
  `wallet_id` salt still earns its place for running several wallets under one
  identical configuration, but much of the address variety now comes from the
  quorum itself.
- Agents remain in the datum and stay owner-rotatable. One address serves a
  changing cast of agents under a fixed quorum — the cheap rotation is the hot
  key, the expensive one is the quorum.
