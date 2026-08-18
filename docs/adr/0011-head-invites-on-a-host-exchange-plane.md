# ADR 0011 — Head Invites on a Host Exchange Plane

## Status

Proposed. Revises ADR 0015 §4b, which put the cross-org handshake on the
payment service.

## Context

ADR 0015 §4b made a per-Head exchange of public material mandatory, and put it
on the payment service: a counterparty POSTs a signed Head Offer to
`/api/v1/hydra/handshake/offer`, which is unauthenticated and authorised by a
signature bound to `HydraRelation.RemoteWallet`.

That works, but it requires the payment service to be reachable from a
counterparty's network. Many deployments cannot expose it — it carries wallet
operations, the admin API and the operator UI, and its reachability is not a
property an operator wants to depend on. Meanwhile a [[Hydra Host]] is already
public by necessity: the [[Peer Plane]] publishes a port per Head.

The obvious moves both fail. **Relaying** through the Host keeps the payment
service as the decision-maker but still needs a live internal path to it at the
moment a counterparty calls. **Terminating** on the Host means the Host answers
for the operator — and answering requires the Relation, the offer state and the
hot wallet mnemonic, so the Host would end up holding the payment wallet keys.
That is a worse outcome than the exposure it was meant to avoid.

Two facts about `hydra-node` 2.3.0 constrain any alternative:

- `--peer`, `--hydra-verification-key` and `--initial-cluster` are startup
  configuration, and the etcd data dir is content-addressed by them. Neither
  node can boot before both know the full cluster config, and neither can
  change its peer afterwards.
- Peer messages are signed but **not encrypted**, and they are signed with the
  very Hydra keys the exchange distributes. The peer link's integrity is
  derived from the exchange, so the exchange cannot inherit security from it.
  The exchange is the trust root and has nothing beneath it.

## Decision

Replace the wire Head Offer with a **[[Head Invite]]**: a signed, single-use
capability carrying the issuer's _complete_ public head material, redeemed at a
new unauthenticated **[[Exchange Plane]]** on the Host.

**1. Issuing pre-allocates; redeeming starts.** The payment service provisions
a node and peer port, signs the full material with the Relation wallet, and
emits the invite. The node cannot boot yet — it has no peer — so redemption is
what supplies the counterparty's material and starts it.

**2. Nothing security-critical flows back, so the Host needs no key.** Because
the invite already carries everything the recipient must trust, redemption is
answered with an acknowledgement. The Host never speaks for the operator's
wallet, and no signing key beyond the node's own reaches it. This is what makes
the whole design work: it was arrived at by asking why a reply needed
authenticating, and finding that it did not.

We rejected a delegated per-invite signing key on the Host, which would have
been necessary had the reply carried material. We rejected trusting the
transport — TLS plus a signed URL — because ADR 0015 §7 has the Host serving
plain HTTP behind a load balancer, so the Host cannot guarantee the property
the security would then rest on.

Transport still provides defence in depth. Host control and exchange URLs use
HTTPS by default. HTTP remains available for loopback and separately secured
private networks, but only through explicit operator consent: a persisted
`allowInsecureHttp` flag for Host bearer-token traffic and a separate
`allowInsecureExchangeHttp` confirmation for each redemption. The frontend
warns before either opt-in.

**3. Bearer, single-use, auto-start, reviewable after.** Anyone holding an
invite may redeem it once, and the node starts immediately. Binding the invite
to a named wallet was rejected because knowing the counterparty's address up
front is exactly the manual exchange this removes. The risk is bounded by what
a redemption actually costs: `initHeadPost` is admin-triggered, so no
redemption reaches L1 on its own. An unwanted counterparty is undone by
deleting a node, not by an on-chain Abort. It is not free, though — the peer is
startup configuration, so the node cannot be re-pointed and its port and keys
are spent.

**4. Invites own their pre-allocation.** A `HydraHeadInvite` row holds the node,
port and signed material until redemption, which then resolves the redeemer to
a `WalletBase`, finds or creates the Relation, and creates the Head. Making
`HydraRelation.remoteWalletId` nullable was rejected: that column is what
authenticates every inbound message, and a nullable trust anchor puts a null
branch in front of every security check.

**5. Every arrow points payment service → Host.** The Host never learns a
payment-service URL and holds no credential for one. Redemptions are discovered
by a watermark poll (`GET /v1/invites?redeemedSince=`) from a scheduler job, so
a missed tick replays rather than loses. Notice is not urgent: under auto-start
the node is already running, and the poll exists for visibility and the kill
switch.

**6. Delivery is manual until authenticated delivery exists.** Invites are
pasted through a channel the operator trusts. The rejected automatic-delivery
design accepted arbitrary payloads into an unauthenticated Host inbox before
verifying their signatures, which made the listener a spoofing and storage
exhaustion surface. A future automatic path must authenticate and verify before
it persists anything. The payment service's `receiveHydraOfferPost` and
`declineHydraOfferPost` are deleted.

**7. The Exchange Plane is not an inbox.** Its only public operation redeems a
nonce this Host issued, while it is unspent and unexpired. It validates every
redeemer value before persistence. Unknown public paths return 404, request
bodies are bounded, and connection timeouts are short.

**8. Approval names the counterparty.** Before redeeming, the operator is shown
the issuer's registry entries — assets at that address under the network's V2
registry policy, resolved to their on-chain metadata names. A hex address is a
check people click past; an agent name is one they perform.

## Consequences

- The Host gains a second listening surface with a security model opposite to
  the Control Plane's. The route table must keep them disjoint: no fleet
  operation and no proxied node API is reachable from the Exchange Plane.
- Unredeemed invites strand a node and a peer port. They need an expiry on
  human timescales — an invite is read by a person, not a process — plus a
  reaper that releases the allocation. Implemented as `INVITE_TTL_MS`, seven
  days by default and overridable per invite.
- An operator can be in a Head with a party they have not yet reviewed, for as
  long as one poll interval. Acceptable only because reaching L1 stays a
  deliberate admin action.
- Automatic delivery is deferred. Operators must transfer each invite through
  a trusted channel until a design can authenticate the sender before writing
  to Host storage.
