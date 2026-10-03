# x402 Admin Experience Design

Date: 2026-08-24
Owner: coordinator
Status: Approved

## Scope

VERIFIED: PR head `54b880c188b5c567d7e0c537d5bf6f145633e16c` has separate x402 pages for wallets, payments, budgets, chains, and alerts.

The approved change makes the x402 rail follow the Cardano admin model. It adds a real dashboard, moves wallet policy into wallet details, keeps chain configuration under Payment Sources, and uses a focused setup wizard.

## Navigation

The x402 sidebar order is:

1. Dashboard
2. AI Agents
3. Wallets
4. Transactions
5. Webhooks
6. API Keys, for administrators
7. Developers

`/x402/payments` remains the stable route. The UI labels it Transactions.

Transactions follow the active x402 payment source. The page has no second chain filter, but keeps
the chain column and detail field for audit context.

Compatibility routes remain available:

- `/x402/chains` redirects to `/payment-sources`.
- `/x402/budgets` redirects to `/x402/wallets`.
- `/x402/alerts` redirects to `/x402/wallets`.
- `/x402` redirects to `/x402/dashboard`.

Legacy `?tab=` links preserve unrelated query fields. Direct x402 loads and browser history restore the x402 rail.

## Dashboard

VERIFIED: existing read-authenticated x402 endpoints provide wallet, payment, settlement, recent-payment, and wallet-balance data. No backend endpoint change is required.

The dashboard shows:

- managed wallet count;
- transaction count and status;
- successful settlement count;
- active low-balance count for administrators;
- balances grouped by chain and asset identity;
- recent transactions.

The dashboard uses the active x402 chain. It never merges balances from different token contracts.

## Wallet details

Budgets are spend policy for one Purchasing wallet and API key. Low-balance rules monitor one wallet, chain, and asset. Both belong inside wallet details.

The wallet dialog contains:

- Overview and balances for every visible wallet.
- Spend budgets for Purchasing wallets when the key can pay.
- Low-balance rules for administrators.

Active low-balance rules also appear as wallet status and dashboard attention state.

## Payment Sources

Payment Sources is the only persistent chain-management surface. Its x402 Manage action opens chain configuration without leaving the page. The setup wizard reuses the same chain form inline.

## Setup

The x402 setup uses a focused Cardano-style shell.

1. Select an x402 chain for the active environment.
2. Configure receiving through a managed Selling wallet or remote facilitator.
3. Optionally create a Purchasing wallet and spend budget.
4. Show Ready only when backend readiness confirms receiving.

The wizard preselects the active chain. A network change asks for confirmation and resets the wizard. Reopening setup resumes from current backend readiness. Completion selects the x402 rail and opens the dashboard.

Add Source opens normal x402 setup when no EVM source works. When the rail already works, it starts
at chain selection and skips outbound setup. The chain selector lists configured chains and an
inline custom-chain form. Setup locks new and edited chains to the active environment.

## Verification

Add focused tests for route mapping, rail restoration, role-based navigation, dashboard aggregation, and setup state. Build the static frontend. Serve it only through the backend. Test admin, pay, and read roles where local fixtures allow it. Capture screenshots without private keys or open API-key selectors.

## Least confident decisions

1. The common dashboard omits spend-budget totals because budget visibility differs by role.
2. Old budget and alert links open Wallets without selecting a wallet because the old URL contains no wallet identity.
