# Configuration

Configure the environment variables by copying the `.env.example` file to `.env`or `.env.local` and setup the
variables

**TLDR;** Most of the variables can be left as the example values, if you want to just test the service. However you will need to set the following:

- **DATABASE_URL**: The endpoint for a PostgreSQL database to be used
- **ENCRYPTION_KEY**: The key for encrypting the wallets in the database (Please see the [Security](#security)

## Advanced Configuration

- If you need to seed a new database, you will also need to set the following:
  - **BLOCKFROST_API_KEY**: An API Key from [https://blockfrost.io/](https://blockfrost.io/) for the correct blockchain

- **DATABASE_URL**: The endpoint for a PostgreSQL database to be used
- **PORT**: The port to run the server on (default is 3001)
- **ENCRYPTION_KEY**: The key for encrypting the wallets in the database (Please see the [Security](#security)
  section for more details and security considerations)
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
  - **REGISTER_AGENT_INTERVAL**: check interval in seconds for registering agent
  - **DEREGISTER_AGENT_INTERVAL**: check interval in seconds for deregistering agent

1. If you're setting up the database for the first time (or want to provide some initial data) you also need the
   following variables:
   - **BLOCKFROST_API_KEY_PREPROD**: An API Key from [https://blockfrost.io/](https://blockfrost.io/) for the correct blockchain
     network, you can create this for free
   - **BLOCKFROST_API_KEY_MAINNET**: An API Key from [https://blockfrost.io/](https://blockfrost.io/) for the correct blockchain
     network, you can create this for free
   - **ADMIN_KEY**: The key of the admin user, this key will have all permissions and can create new api_keys
   - OPTIONAL Wallet data: Used to configure payment and purchase wallets, if you want to use existing wallets
     - **PURCHASE_WALLET_PREPROD_MNEMONIC** and **PURCHASE_WALLET_MAINNET_MNEMONIC**: The mnemonic of the wallet used to purchase any agent requests. This needs to have
       sufficient funds to pay, or be topped up. If you do not provide a mnemonic, a new one will be generated. Please
       ensure you export them immediately after creation and store them securely.
     - **SELLING_WALLET_PREPROD_MNEMONIC** and **SELLING_WALLET_MAINNET_MNEMONIC**: The mnemonic of the wallet used to interact with the smart contract. This only needs
       minimal funds, to cover the CARDANO Network fees. If you do not provide a mnemonic, a new one will be
       generated. Please ensure you export them immediately after creation and store them securely.
     - **COLLECTION_WALLET_PREPROD_ADDRESS** and **COLLECTION_WALLET_MAINNET_ADDRESS**: The wallet address of the collection wallet. It will receive all payments after
       a successful and completed purchase (not refund). It does not need any funds, however it is strongly recommended
       to create it via a hardware wallet or ensure its secret is stored securely. If you do not provide an address,
       the SELLING_WALLET will be used.
