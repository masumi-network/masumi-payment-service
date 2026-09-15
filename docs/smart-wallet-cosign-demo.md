# Smart wallet co-sign demo

VERIFIED by source inspection: this runner uses Cardano preprod and synthetic purchases with lovelace amounts.
It creates escrow locks through a demo command, outside the production purchase queue.
Sources: [network](../packages/payment-source-v2/scripts/smart-wallet-demo/demo-context.mts#L20), [purchase creation](../packages/payment-source-v2/scripts/smart-wallet-demo/run.mts#L122), [lock flow](../packages/payment-source-v2/scripts/smart-wallet-demo/run.mts#L272).
This guide records source behavior. It does not attest to a successful chain run or compatibility with Exchain's final API.

## Prepare the environment

VERIFIED prerequisites: follow the [repository setup](../README.md#getting-started) for Node, pnpm, and the database.
Use `sfw pnpm install` if dependencies need installation.
Run the commands below from the repository root so `dotenv` reads the root `.env`.
The shared configuration requires `DATABASE_URL` and `ENCRYPTION_KEY` even for runner commands.
The runner also requires `BLOCKFROST_API_KEY_PREPROD`.
Sources: [shared checks](../packages/payment-core/src/config.ts#L11), [dotenv import](../packages/payment-source-v2/scripts/smart-wallet-demo/demo-config.ts#L1), [Blockfrost key](../packages/payment-source-v2/scripts/smart-wallet-demo/demo-context.mts#L33).

Set these values in your root `.env`:

```dotenv
DATABASE_URL="your local PostgreSQL connection URL"
ENCRYPTION_KEY="your own secret of at least 32 characters"
BLOCKFROST_API_KEY_PREPROD="your preprod project key"
SMART_WALLET_DEMO_PERIOD_LIMIT_LOVELACE="your chosen positive integer"
```

Replace each placeholder before use. Keep an existing encryption key unchanged.
VERIFIED: the period limit has no default. Mint stores this limit for a 24-hour validator period.
Changing the environment afterward does not update an existing wallet's policy.
Sources: [limit validation](../packages/payment-source-v2/scripts/smart-wallet-demo/demo-config.ts#L57), [mint datum and existing-wallet check](../packages/payment-source-v2/scripts/smart-wallet-demo/run.mts#L195).

For the local mock, leave `EXCHAIN_COSIGN_URL` unset.
VERIFIED defaults: 10 purchases, 6 tADA per allowed lock, 8 tADA per denied lock, and a 70 tADA mock transaction cap.
The wallet funding default is 150 tADA. These demo values do not choose the operator's validator limit.
Source: [demo defaults](../packages/payment-source-v2/scripts/smart-wallet-demo/demo-config.ts#L42).

## Initialize and fund

1. Create the local state and print the funding addresses:

   ```sh
   pnpm exec tsx packages/payment-source-v2/scripts/smart-wallet-demo/run.mts init
   ```

2. Fund the printed owner and agent addresses with preprod tADA. Follow the amounts printed by `init`.
3. Choose the period limit before running `mint`. Check the submission table below first.

VERIFIED: `init` generates demo keys and synthetic purchases. It does not submit a transaction.
It prints owner funding plus 15 tADA and agent funding of at least 30 tADA.
Sources: [init](../packages/payment-source-v2/scripts/smart-wallet-demo/run.mts#L99), [funding output](../packages/payment-source-v2/scripts/smart-wallet-demo/run.mts#L157).

## Run commands

Use `pnpm exec tsx packages/payment-source-v2/scripts/smart-wallet-demo/run.mts COMMAND`.
VERIFIED command behavior comes from the [runner](../packages/payment-source-v2/scripts/smart-wallet-demo/run.mts#L545):

| Command         | Submits to preprod?  | Effect                                                                                 |
| --------------- | -------------------- | -------------------------------------------------------------------------------------- |
| `init`          | No                   | Creates local state or prints existing funding addresses.                              |
| `mint`          | **Yes**              | Mints and funds the wallet. It can first submit an agent collateral split.             |
| `deny`          | No                   | Builds a batch and requests a denial. An unexpected approval stops without submission. |
| `allow-batched` | **Yes, on approval** | Locks the purchases in one batch, reduced if the transaction is too large.             |
| `allow-single`  | **Yes, on approval** | Requires the submitted batch. Locks its purchases again, one transaction per purchase. |
| `report`        | No                   | Reads chain evidence and writes a report for completed runs.                           |
| `mock`          | No                   | Starts a local signing service and decision page. It can sign incoming requests.       |
| `sweep`         | **Yes**              | Uses the owner key to recover wallet funds and burn the state token.                   |
| `all`           | **Yes**              | Runs mint, denial, batch, single purchases, and report. Run `init` first.              |

Run individual commands in this order: `mint`, `deny`, `allow-batched`, `allow-single`, `report`.
Use `sweep` only when you intend to retire the wallet. It does not recover earlier escrow locks.
VERIFIED sources: [collateral split](../packages/payment-source-v2/scripts/smart-wallet-demo/run.mts#L171), [single purchases](../packages/payment-source-v2/scripts/smart-wallet-demo/run.mts#L484), [sweep inputs](../packages/payment-source-v2/scripts/smart-wallet-demo/run.mts#L518).

## View the local decision feed

VERIFIED: `mock` serves the decision page on port 4600 by default and binds to `127.0.0.1`.
Sources: [port](../packages/payment-source-v2/scripts/smart-wallet-demo/demo-config.ts#L45), [bind address](../packages/payment-source-v2/scripts/smart-wallet-demo/cosign-mock.ts#L375).

```sh
pnpm exec tsx packages/payment-source-v2/scripts/smart-wallet-demo/run.mts mock
```

Open <http://127.0.0.1:4600/>. To embed it, set the following in both root `.env` and `frontend/.env.local`:

```dotenv
NEXT_PUBLIC_EXCHAIN_DASHBOARD_URL="http://127.0.0.1:4600/"
```

Build the frontend with `pnpm -C frontend run build`. Start the configured backend with `pnpm run dev`.
Sign in at <http://localhost:3001/admin/cosign-demo> when using the default backend port.
VERIFIED: the backend serves the built frontend. The frontend URL is a build-time value. Restart the backend after configuration changes.
Sources: [startup](../README.md#getting-started), [URL configuration](../.env.example#L82), [iframe](../frontend/src/pages/cosign-demo.tsx#L55).

VERIFIED: runner commands start their own temporary mock when `EXCHAIN_COSIGN_URL` is unset.
The standalone mock reads the same decision file. Each process has separate in-memory reservations and cached responses.
The feed therefore does not establish shared reservation state between commands.
Sources: [temporary mock](../packages/payment-source-v2/scripts/smart-wallet-demo/demo-context.mts#L207), [feed reader](../packages/payment-source-v2/scripts/smart-wallet-demo/cosign-mock.ts#L126), [process state](../packages/payment-source-v2/scripts/smart-wallet-demo/cosign-mock.ts#L204).

## State, reports, and external service

VERIFIED: `.state/demo-state.json` contains demo mnemonics and a mock API key.
Keep it private. Keep `.state/` and `evidence/` ignored by Git.
The report writes timestamped evidence beneath the demo's `evidence/` directory.
Sources: [state fields](../packages/payment-source-v2/scripts/smart-wallet-demo/demo-context.mts#L84), [ignore rules](../.gitignore#L85), [report files](../packages/payment-source-v2/scripts/smart-wallet-demo/demo-report.mts#L194).

VERIFIED: external mode requires `EXCHAIN_COSIGN_URL`, `EXCHAIN_COSIGN_API_KEY`, and `EXCHAIN_COSIGN_QUORUM_VKHS`.
Configure quorum hashes before `init`. The runner checks them against the stored quorum before co-signing.
Sources: [initial quorum](../packages/payment-source-v2/scripts/smart-wallet-demo/run.mts#L105), [external configuration](../packages/payment-source-v2/scripts/smart-wallet-demo/demo-context.mts#L190).
Compatibility with Exchain's frozen API and the iframe read-token flow remains unverified here.
