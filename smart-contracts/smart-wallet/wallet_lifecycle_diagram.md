# Smart Wallet Lifecycle

The wallet is not a state machine like the payment contract. Each wallet is
one long-lived UTxO, identified by its state token. The datum carries the
budget counters. A transaction changes who may spend and how much budget
remains. It does not change a state tag.

Several wallets can share one address. Each token is one wallet. No two
wallets can settle in the same transaction.

## Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Live: owner mints the state token<br/>(one-shot seed, destination pinned, datum must parse)

    Live --> Live: AgentSpend<br/>agent + co-signers, inside the ceiling
    Live --> Live: Deposit<br/>agent or owner, value in only
    Live --> Live: UpdatePolicy<br/>owner replaces the agent key / changes the budget
    Live --> [*]: OwnerSpend + burn<br/>sweeps the funds and retires the wallet

    note right of Live
        Rules on every AgentSpend:
        - exactly one input of this script, foreign scripts allowed
        - one continuing output, same full address, same token
        - assets without a limit entry are frozen in both directions
        - remaining lovelace >= min_balance_lovelace
        - only period_start and spent_in_period change
    end note
```

## Budget window

Each wallet has one window and one set of counters. A spend adds to the open
window, or it opens a fresh window. It never does both, and no backlog of
windows accrues.

```mermaid
sequenceDiagram
    autonumber
    participant A as Agent
    participant W as Wallet UTxO
    participant R as Recipient

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

On a roll-over, the validator sets `period_start` to the lower bound of the
validity range. It also requires `upper <= lower + period_length`. The ledger
keeps the current time inside the validity range. Therefore the new window
must contain the present. An agent that was idle for a week gets one window of
budget, not seven.

## Shape of an agent spend

```mermaid
flowchart LR
    subgraph Inputs
        W["Wallet UTxO<br/>100 ADA + state token<br/>spent_in_period = 0"]
        F["Agent key UTxO<br/>fees + collateral"]
    end
    subgraph Outputs
        C["Continuing output<br/>same address<br/>95 ADA + state token<br/>spent_in_period = 5 ADA"]
        P["Recipient<br/>5 ADA"]
        X["Agent change"]
    end
    W --> C
    W --> P
    F --> X

    style W fill:#1f2937,stroke:#4b5563,color:#e5e7eb
    style C fill:#1f2937,stroke:#4b5563,color:#e5e7eb
```

The outflow is 100 − 95 = 5 ADA. The validator charges this amount to the
budget. The state token stays in place: it has no limit entry, and assets
without a limit entry cannot move in either direction. The same rule stops an
NFT from leaving the wallet.

Foreign script inputs may appear in the transaction. The primary case is a
lock into the payment escrow. A second input of the wallet script may not
appear. Two wallets cannot settle together, so each ceiling stays independent.

## Owner paths

```mermaid
flowchart TD
    O{Owner action}
    O -->|OwnerSpend| S["Reads no datum, needs no continuing output.<br/>Also recovers UTxOs that hold a missing<br/>or malformed datum."]
    O -->|UpdatePolicy| U["Exactly one continuing output<br/>with a datum that parses.<br/>The new values are not constrained."]
```
