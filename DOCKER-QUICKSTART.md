# Docker Quick Start Guide for Masumi Payment Service

This guide will help you quickly deploy Masumi Payment Service using Docker Compose.

## Prerequisites

- Docker and Docker Compose installed on your machine
- [Blockfrost.io](https://blockfrost.io) account for Cardano blockchain API access
- Basic understanding of command line operations

## Quick Start

1. **Configure Environment Variables**

   Copy the included `.env` file and update the required values:

   ```
   # At minimum, update these values
   POSTGRES_PASSWORD=your_secure_postgres_password
   ENCRYPTION_KEY=your_secure_32_character_encryption_key (must be at least 32 chars)
   ADMIN_KEY=your_secure_admin_key
   BLOCKFROST_API_KEY_PREPROD=your_blockfrost_preprod_api_key
   ```

2. **Start the Services**

   Run the following command in the same directory as your `docker-compose.yml`:

   ```bash
   docker-compose up -d
   ```

3. **Access the Service**

   Once running, access:
   - Admin Dashboard: http://localhost:3001/admin
   - API Documentation: http://localhost:3001/docs

4. **Set Up Your Wallets**

   The system will generate new wallets on first run if none are provided in your environment variables.
   Make sure to back up the generated wallet mnemonics from the admin interface!

## Data Persistence

The Docker setup includes three persistent volumes:

- `postgres_data`: Stores PostgreSQL database files
- `masumi_logs`: Stores application logs
- `masumi_wallets`: Stores wallet-related information

These volumes ensure your data persists across container restarts.

## Common Operations

- **Viewing logs**:
  ```bash
  docker-compose logs -f payment-service
  ```

- **Restart services**:
  ```bash
  docker-compose restart
  ```

- **Stop services**:
  ```bash
  docker-compose down
  ```

- **Complete teardown** (including volumes):
  ```bash
  docker-compose down -v
  ```
  Warning: This will delete all data, including database records and wallets.

## Troubleshooting

1. **Database connection issues**:
   - Check `POSTGRES_PASSWORD` in `.env` file matches what's in the Docker configuration
   - Ensure PostgreSQL container is running: `docker ps | grep postgres`

2. **API Errors**:
   - Verify your Blockfrost API key is valid for the selected network
   - Check logs for specific error messages: `docker-compose logs payment-service`

3. **Wallet issues**:
   - For testing on Preprod, ensure your wallets have test ADA (use faucets)
   - If using custom wallet mnemonics, ensure they are correctly formatted

## Getting Test ADA

For Preprod, get free test ADA from [Cardano Testnet Faucet](https://docs.cardano.org/cardano-testnets/tools/faucet).

## Next Steps

1. Review the security of your wallets and funds
2. Connect your CrewAI or other agent framework to the Masumi payment infrastructure
3. Consider registering your agent on the Masumi network

For more detailed instructions, refer to the [official Masumi documentation](https://docs.masumi.network/).

