# Configuration

Configure the environment variables by copying the `.env.example` file to `.env`or `.env.local` and setup the
variables

If you run the service directly on your machine, the process reads `.env` through `dotenv`.

If you run the service with Docker:

- pass backend secrets at runtime with `docker run --env-file .env ...` or Compose `env_file`
- do not bake `.env` into the image
- pass only explicit `NEXT_PUBLIC_*` frontend values as Docker `--build-arg`
- treat every `NEXT_PUBLIC_*` variable as public client-side data

**TLDR;** Most of the variables can be left as the example values, if you want to just test the service. However you will need to set the following:

- **DATABASE_URL**: The endpoint for a PostgreSQL database to be used
- **ENCRYPTION_KEY**: The key for encrypting the wallets in the database (Please see the [Security](#security)
  section for more details and security considerations)

## Advanced Configuration

- **DATABASE_URL**: The endpoint for a PostgreSQL database to be used
- **PORT**: The port to run the server on (default is 3001)
- **ENCRYPTION_KEY**: The key for encrypting the wallets in the database (Please see the [Security](#security)
  section for more details and security considerations)
- **DATABASE_CA_CERT** _(optional)_: PEM-encoded CA certificate for database SSL connections (e.g. when using
  self-signed certificates). Use literal `\n` for newlines in the env var value. When set, the service
  automatically writes the certificate to `certs/ca-certificate.crt` at startup and appends
  `sslrootcert=<path>` to the database connection string.
- OPTIONAL: The services will run the following jobs whenever previous ones completed or after the provided
  time. (Defaults apply if not set)
  - **CHECK_WALLET_TRANSACTION_HASH_INTERVAL**: delay in seconds for checking wallet transaction hash. This also
    reruns potentially effected services by unlocking the wallet
  - **BATCH_PAYMENT_INTERVAL**: check interval in seconds for batching requests
  - **CHECK_COLLECTION_INTERVAL**: check interval in seconds for checking collection
  - **CHECK_TX_INTERVAL**: check interval in seconds for checking payment
  - **CHECK_COLLECT_REFUND_INTERVAL**: check interval in seconds for checking collection and refund
  - **CHECK_SET_REFUND_INTERVAL**: check interval in seconds for checking set refund
  - **CHECK_UNSET_REFUND_INTERVAL**: check interval in seconds for checking unset refund
  - **CHECK_AUTHORIZE_REFUND_INTERVAL**: check interval in seconds for checking authorize refund
  - **CHECK_SUBMIT_RESULT_INTERVAL**: check interval in seconds for checking submit result
  - **CHECK_REGISTRY_TRANSACTIONS_INTERVAL**: check interval in seconds for syncing registry transactions
  - **REGISTER_AGENT_INTERVAL**: check interval in seconds for registering agent
  - **DEREGISTER_AGENT_INTERVAL**: check interval in seconds for deregistering agent
  - **AUTO_DECISION_INTERVAL**: interval in seconds for automatic decision handling
  - **WEBHOOK_DELIVERY_INTERVAL**: interval in seconds for processing queued webhook deliveries
  - **WEBHOOK_CLEANUP_INTERVAL**: interval in seconds for deleting old webhook deliveries
  - **LOW_BALANCE_CHECK_INTERVAL**: interval in seconds for monitored wallet low-balance checks
  - **CHECK_HYDRA_TX_INTERVAL**: interval in seconds for the Hydra L2 passes and deposit reconciliation (minimum 5, default 10)

### Seeding a new database

The seed script reads **network-specific** Blockfrost keys — there is no generic `BLOCKFROST_API_KEY` variable.

| Network | Required for seed | Variable |
| ------- | ----------------- | -------- |
| Preprod | Yes (default install path) | **BLOCKFROST_API_KEY_PREPROD** |
| Mainnet | Only when mainnet payment sources are configured | **BLOCKFROST_API_KEY_MAINNET** |

Obtain free API keys at [https://blockfrost.io/](https://blockfrost.io/) for the network you are using.

When seeding, you also need:

- **ADMIN_KEY**: The key of the admin user. This key has all permissions and can create new api_keys.
- OPTIONAL wallet data — used to configure payment and purchase hot wallets, or leave blank to generate new mnemonics during seed (see `prisma/seed.ts`):
  - **PURCHASE_WALLET_PREPROD_MNEMONIC** / **PURCHASE_WALLET_MAINNET_MNEMONIC**: Purchasing hot wallet mnemonics
  - **SELLING_WALLET_PREPROD_MNEMONIC** / **SELLING_WALLET_MAINNET_MNEMONIC**: Selling hot wallet mnemonics
  - **COLLECTION_WALLET_PREPROD_ADDRESS** / **COLLECTION_WALLET_MAINNET_ADDRESS**: Collection wallet addresses (strongly recommended via hardware wallet). If omitted, the selling wallet address is used.

## Frontend Build Variables

The admin frontend is statically built and any `NEXT_PUBLIC_*` value is embedded into the generated assets. Only pass
values that are safe to expose to the browser.

The Docker image supports these explicit frontend build arguments. If you do not pass
`NEXT_PUBLIC_PAYMENT_API_BASE_URL`, it defaults to `/api/v1`.

- **NEXT_PUBLIC_PAYMENT_API_BASE_URL**: Public base URL used by the admin UI to call the backend API
