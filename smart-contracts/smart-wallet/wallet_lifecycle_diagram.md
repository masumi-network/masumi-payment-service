# Smart Wallet Lifecycle

The wallet is not a state machine in the sense the payment contract is: each
wallet is one long-lived UTxO — identified by its state token — whose datum
carries mutable budget accounting. What changes across transactions is *who*
may spend and *how much is left in the window*, not a discrete state tag.
Several wallets can share the address; each token is one wallet, and no two
ever settle in the same transaction.

## Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Live: owner mints the state token<br/>(one-shot seed, destination pinned, datum unvalidated)

    Live --> Live: AgentSpend<br/>agent + quorum, within the ceiling
    Live --> Live: Deposit<br/>agent or owner, value in only
    Live --> Live: UpdatePolicy<br/>owner rotates agent / re-budgets
    Live --> [*]: OwnerSpend + burn<br/>sweeps and retires the wallet

    note right of Live
        Invariants on every AgentSpend:
        - exactly one input of OUR script, foreign scripts allowed
        - one continuing output, same full address, same token
        - unlisted assets frozen both directions
        - remaining lovelace >= min_balance_lovelace
        - only period_start / spent_in_period change
    end note
```

## Budget window

`period_start` and `spent_in_period` are per wallet. A spend either accumulates
inside the open window or opens a fresh one — never both, and never a backlog.

```mermaid
sequenceDiagram
    autonumber
    participant A as Agent
    participant W as Wallet UTxO
    participant R as Allow-listed recipient

    Note over W: period_start = T0, limit = 10 ADA, spent = 0
    A->>W: AgentSpend, outflow 4 ADA (lower < T0 + period)
    W->>R: 4 ADA
    Note over W: same window, spent = 4 ADA

    A->>W: AgentSpend, outflow 7 ADA
    Note over W: rejected: 4 + 7 > 10 ADA

    Note over W: ... window elapses ...
    A->>W: AgentSpend, outflow 7 ADA (lower >= T0 + period)
    W->>R: 7 ADA
    Note over W: rolled over, period_start = lower, spent = 7 ADA
```

Roll-over sets `period_start` to the transaction's lower bound and requires
`upper <= lower + period_length`. The ledger guarantees `lower <= now <= upper`,
so the new window must contain the present. An agent that has been idle for a
week therefore gets one window's budget, not seven.

## Agent spend transaction shape

```mermaid
flowchart LR
    subgraph Inputs
        W["Wallet UTxO<br/>100 ADA + NFT<br/>spent_in_period = 0"]
        F["Agent key UTxO<br/>fees + collateral"]
    end
    subgraph Outputs
        C["Continuing output<br/>same address<br/>95 ADA + NFT<br/>spent_in_period = 5 ADA"]
        P["Recipient<br/>5 ADA"]
        X["Agent change"]
    end
    W --> C
    W --> P
    F --> X

    style W fill:#1f2937,stroke:#4b5563,color:#e5e7eb
    style C fill:#1f2937,stroke:#4b5563,color:#e5e7eb
```

`outflow = 100 − 95 = 5 ADA`, which is what the budget is charged. The state
token rides through untouched: it is unlisted in `limit`, and unlisted assets
are frozen in both directions — the same rule that stops an NFT walking out.

Foreign script inputs may appear — locking into the payment escrow is the
primary case — but never a second input of the wallet's own script: two shards
cannot settle together, which keeps each wallet's ceiling independent.

## Owner paths

```mermaid
flowchart TD
    O{Owner action}
    O -->|OwnerSpend| S["No datum read, no continuing output.<br/>Also recovers UTxOs with a missing<br/>or malformed datum."]
    O -->|UpdatePolicy| U["Exactly one continuing output<br/>with a well-formed datum.<br/>New policy otherwise unconstrained."]
```
