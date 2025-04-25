#!/bin/bash
set -e

# Terminal colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Default values - empty strings mean they'll be auto-generated
BLOCKFROST_API_KEY_PREPROD="preprodtestkey_youmustchangethis"
BLOCKFROST_API_KEY_MAINNET=""
PURCHASE_WALLET_PREPROD_MNEMONIC=""
SELLING_WALLET_PREPROD_MNEMONIC=""
COLLECTION_WALLET_PREPROD_ADDRESS=""
PURCHASE_WALLET_MAINNET_MNEMONIC=""
SELLING_WALLET_MAINNET_MNEMONIC=""
COLLECTION_WALLET_MAINNET_ADDRESS=""
SSL_CERT_PATH=""
SSL_KEY_PATH=""

# Parse command line arguments
usage() {
    echo -e "Usage: $0 [OPTIONS]"
    echo -e "Options:"
    echo -e "  -p, --preprod-key KEY                 Blockfrost API key for Preprod environment"
    echo -e "  -m, --mainnet-key KEY                 Blockfrost API key for Mainnet environment"
    echo -e "  --purchase-preprod-mnemonic WORDS     Mnemonic for preprod purchase wallet (optional)"
    echo -e "  --selling-preprod-mnemonic WORDS      Mnemonic for preprod selling wallet (optional)"
    echo -e "  --collection-preprod-address ADDR     Address for preprod collection wallet (optional)"
    echo -e "  --purchase-mainnet-mnemonic WORDS     Mnemonic for mainnet purchase wallet (optional)"
    echo -e "  --selling-mainnet-mnemonic WORDS      Mnemonic for mainnet selling wallet (optional)"
    echo -e "  --collection-mainnet-address ADDR     Address for mainnet collection wallet (optional)"
    echo -e "  --ssl-cert PATH                       Path to SSL certificate (optional)"
    echo -e "  --ssl-key PATH                        Path to SSL private key (optional)"
    echo -e "  -h, --help                            Display this help message"
    exit 1
}

while [[ $# -gt 0 ]]; do
    case $1 in
        -p|--preprod-key)
            BLOCKFROST_API_KEY_PREPROD="$2"
            shift 2
            ;;
        -m|--mainnet-key)
            BLOCKFROST_API_KEY_MAINNET="$2"
            shift 2
            ;;
        --purchase-preprod-mnemonic)
            PURCHASE_WALLET_PREPROD_MNEMONIC="$2"
            shift 2
            ;;
        --selling-preprod-mnemonic)
            SELLING_WALLET_PREPROD_MNEMONIC="$2"
            shift 2
            ;;
        --collection-preprod-address)
            COLLECTION_WALLET_PREPROD_ADDRESS="$2"
            shift 2
            ;;
        --purchase-mainnet-mnemonic)
            PURCHASE_WALLET_MAINNET_MNEMONIC="$2"
            shift 2
            ;;
        --selling-mainnet-mnemonic)
            SELLING_WALLET_MAINNET_MNEMONIC="$2"
            shift 2
            ;;
        --collection-mainnet-address)
            COLLECTION_WALLET_MAINNET_ADDRESS="$2"
            shift 2
            ;;
        --ssl-cert)
            SSL_CERT_PATH="$2"
            shift 2
            ;;
        --ssl-key)
            SSL_KEY_PATH="$2"
            shift 2
            ;;
        -h|--help)
            usage
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            usage
            ;;
    esac
done

# Validate Blockfrost API key
if [ "${BLOCKFROST_API_KEY_PREPROD}" = "preprodtestkey_youmustchangethis" ] || [ -z "${BLOCKFROST_API_KEY_PREPROD}" ]; then
    echo -e "${RED}Error: No valid Blockfrost API key provided for preprod environment${NC}"
    echo -e "${RED}Please provide a valid Blockfrost API key using the --preprod-key option${NC}"
    exit 1
fi

echo -e "${BLUE}=========================================================${NC}"
echo -e "${BLUE}   Masumi Payment Service - Docker Deployment Setup      ${NC}"
echo -e "${BLUE}=========================================================${NC}"

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Error: Docker is not installed. Please install Docker and Docker Compose first.${NC}"
    exit 1
fi

# Check if Docker Compose is installed
if ! command -v docker compose &> /dev/null; then
    echo -e "${RED}Error: Docker Compose is not installed. Please install Docker Compose first.${NC}"
    exit 1
fi

# Check if OpenSSL is installed
if ! command -v openssl &> /dev/null; then
    echo -e "${RED}Error: OpenSSL is not installed. Please install OpenSSL first.${NC}"
    exit 1
fi

# Function to generate a secure random string - using openssl to avoid locale issues
generate_secure_string() {
    local length=$1
    openssl rand -base64 $((length*2)) | tr -dc 'a-zA-Z0-9-_' | head -c "$length"
}

# Step 1: Create .env file
echo -e "\n${YELLOW}Step 1: Creating .env file with secure random values${NC}"

# Generate secure random values
POSTGRES_PASSWORD=$(generate_secure_string 32)
ENCRYPTION_KEY=$(generate_secure_string 48)
ADMIN_KEY=$(generate_secure_string 32)

# Create .env file
cat > .env << EOL
# Database settings
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
DATABASE_URL=postgresql://masumi:${POSTGRES_PASSWORD}@postgres:5432/masumi_payment?schema=public
SHADOW_DATABASE_URL=postgresql://masumi:${POSTGRES_PASSWORD}@postgres:5432/masumi_payment_shadow?schema=public

# Security keys
ENCRYPTION_KEY=${ENCRYPTION_KEY}
ADMIN_KEY=${ADMIN_KEY}

# Blockfrost API keys
BLOCKFROST_API_KEY_PREPROD=${BLOCKFROST_API_KEY_PREPROD}
BLOCKFROST_API_KEY_MAINNET=${BLOCKFROST_API_KEY_MAINNET}

# Environment settings
NODE_ENV=production
DEFAULT_NETWORK=PREPROD
PORT=3001

# Wallet configuration - Preprod
PURCHASE_WALLET_PREPROD_MNEMONIC=${PURCHASE_WALLET_PREPROD_MNEMONIC}
SELLING_WALLET_PREPROD_MNEMONIC=${SELLING_WALLET_PREPROD_MNEMONIC}
COLLECTION_WALLET_PREPROD_ADDRESS=${COLLECTION_WALLET_PREPROD_ADDRESS}

# Wallet configuration - Mainnet
PURCHASE_WALLET_MAINNET_MNEMONIC=${PURCHASE_WALLET_MAINNET_MNEMONIC}
SELLING_WALLET_MAINNET_MNEMONIC=${SELLING_WALLET_MAINNET_MNEMONIC}
COLLECTION_WALLET_MAINNET_ADDRESS=${COLLECTION_WALLET_MAINNET_ADDRESS}

# Job intervals (in seconds)
BATCH_PAYMENT_INTERVAL=240
CHECK_COLLECTION_INTERVAL=300
CHECK_TX_INTERVAL=180
CHECK_COLLECT_REFUND_INTERVAL=300
CHECK_SET_REFUND_INTERVAL=300
CHECK_UNSET_REFUND_INTERVAL=300
CHECK_AUTHORIZE_REFUND_INTERVAL=300
CHECK_SUBMIT_RESULT_INTERVAL=300
CHECK_WALLET_TRANSACTION_HASH_INTERVAL=60
REGISTER_AGENT_INTERVAL=300
DEREGISTER_AGENT_INTERVAL=300
EOL

echo -e "${GREEN}Created .env file with secure random values.${NC}"

# Step 2: Handle SSL certificates
echo -e "\n${YELLOW}Step 2: Setting up SSL certificates for NGINX${NC}"

# Create certs directory
mkdir -p nginx/certs

if [ -n "$SSL_CERT_PATH" ] && [ -n "$SSL_KEY_PATH" ]; then
    if [ -f "$SSL_CERT_PATH" ] && [ -f "$SSL_KEY_PATH" ]; then
        echo -e "${GREEN}Using provided SSL certificate and key${NC}"
        cp "$SSL_CERT_PATH" nginx/certs/server.crt
        cp "$SSL_KEY_PATH" nginx/certs/server.key
        chmod 644 nginx/certs/server.crt
        chmod 600 nginx/certs/server.key
    else
        echo -e "${RED}Error: Provided SSL certificate or key file not found.${NC}"
        echo -e "${YELLOW}Falling back to generating self-signed certificate.${NC}"
        chmod +x generate-certificates.sh
        ./generate-certificates.sh
    fi
else
    echo -e "${YELLOW}No SSL certificate provided. Generating self-signed certificate.${NC}"
    echo -e "${YELLOW}Note: Self-signed certificates will trigger browser security warnings.${NC}"
    echo -e "${YELLOW}For production use, provide valid SSL certificates using --ssl-cert and --ssl-key options.${NC}"
    
    chmod +x generate-certificates.sh
    ./generate-certificates.sh
fi

# Step 3: Create necessary directories
echo -e "\n${YELLOW}Step 3: Creating necessary directories${NC}"
mkdir -p logs wallets

# Step 4: Check that Docker can access the current directory
echo -e "\n${YELLOW}Step 4: Verifying Docker access permissions${NC}"
if [ ! -w "$(pwd)" ]; then
    echo -e "${RED}Warning: The current directory may not be writable by Docker.${NC}"
    echo -e "${RED}You might encounter permission issues when running containers.${NC}"
else
    echo -e "${GREEN}Directory permissions look good.${NC}"
fi

# Step 5: Print wallet configuration warnings
echo -e "\n${YELLOW}Step 5: Wallet Configuration Status${NC}"

# Check preprod wallets
echo -e "${BLUE}Preprod Environment Wallets:${NC}"
if [ -z "$PURCHASE_WALLET_PREPROD_MNEMONIC" ]; then
    echo -e "  ${YELLOW}• Purchase Wallet: Will be auto-generated${NC}"
    echo -e "    A new wallet will be created during initialization."
else
    echo -e "  ${GREEN}• Purchase Wallet: Using provided mnemonic${NC}"
fi

if [ -z "$SELLING_WALLET_PREPROD_MNEMONIC" ]; then
    echo -e "  ${YELLOW}• Selling Wallet: Will be auto-generated${NC}"
    echo -e "    A new wallet will be created during initialization."
else
    echo -e "  ${GREEN}• Selling Wallet: Using provided mnemonic${NC}"
fi

if [ -z "$COLLECTION_WALLET_PREPROD_ADDRESS" ]; then
    echo -e "  ${YELLOW}• Collection Wallet: Not provided${NC}"
    echo -e "    The Selling Wallet will be used to collect payments."
else
    echo -e "  ${GREEN}• Collection Wallet: Using provided address${NC}"
fi

# Check mainnet wallets if mainnet key is provided
if [ -n "$BLOCKFROST_API_KEY_MAINNET" ]; then
    echo -e "\n${BLUE}Mainnet Environment Wallets:${NC}"
    if [ -z "$PURCHASE_WALLET_MAINNET_MNEMONIC" ]; then
        echo -e "  ${YELLOW}• Purchase Wallet: Will be auto-generated${NC}"
        echo -e "    A new wallet will be created during initialization."
    else
        echo -e "  ${GREEN}• Purchase Wallet: Using provided mnemonic${NC}"
    fi

    if [ -z "$SELLING_WALLET_MAINNET_MNEMONIC" ]; then
        echo -e "  ${YELLOW}• Selling Wallet: Will be auto-generated${NC}"
        echo -e "    A new wallet will be created during initialization."
    else
        echo -e "  ${GREEN}• Selling Wallet: Using provided mnemonic${NC}"
    fi

    if [ -z "$COLLECTION_WALLET_MAINNET_ADDRESS" ]; then
        echo -e "  ${YELLOW}• Collection Wallet: Not provided${NC}"
        echo -e "    The Selling Wallet will be used to collect payments."
    else
        echo -e "  ${GREEN}• Collection Wallet: Using provided address${NC}"
    fi
else
    echo -e "\n${BLUE}Mainnet Environment:${NC} Not configured (no Blockfrost API key)"
fi

# Important warning for auto-generated wallets
if [ -z "$PURCHASE_WALLET_PREPROD_MNEMONIC" ] || [ -z "$SELLING_WALLET_PREPROD_MNEMONIC" ] || \
   ([ -n "$BLOCKFROST_API_KEY_MAINNET" ] && ([ -z "$PURCHASE_WALLET_MAINNET_MNEMONIC" ] || [ -z "$SELLING_WALLET_MAINNET_MNEMONIC" ])); then
    echo -e "\n${RED}⚠️ IMPORTANT WALLET SECURITY WARNING ⚠️${NC}"
    echo -e "${RED}One or more wallet mnemonics will be auto-generated during initialization.${NC}"
    echo -e "${RED}After first startup, you MUST backup these wallet mnemonics from the admin interface!${NC}"
    echo -e "${RED}Failure to do so could result in permanent loss of access to these wallets and any funds they contain.${NC}"
fi

# SSL Certificate information
echo -e "\n${BLUE}SSL Certificate Status:${NC}"
if [ -n "$SSL_CERT_PATH" ] && [ -n "$SSL_KEY_PATH" ] && [ -f "$SSL_CERT_PATH" ] && [ -f "$SSL_KEY_PATH" ] && [ -f "nginx/certs/server.crt" ] && [ -f "nginx/certs/server.key" ]; then
    echo -e "  ${GREEN}• Using provided SSL certificates${NC}"
    echo -e "    Certificates copied from: $SSL_CERT_PATH and $SSL_KEY_PATH"
else
    echo -e "  ${YELLOW}• Using self-signed SSL certificates${NC}"
    if [ -n "$SSL_CERT_PATH" ] && [ -n "$SSL_KEY_PATH" ]; then
        echo -e "    ${YELLOW}Note: Provided certificate paths were not valid, fell back to self-signed${NC}"
    fi
    echo -e "    Browser security warnings will appear when accessing the service."
    echo -e "    For production use, replace with valid certificates from a trusted CA."
fi

# Final step: Print summary and next steps
echo -e "\n${GREEN}=========================================================${NC}"
echo -e "${GREEN} Setup Complete!${NC}"
echo -e "${GREEN}=========================================================${NC}"
echo -e "${BLUE}The following files have been created/updated:${NC}"
echo -e "  - .env (with secure random credentials)"
echo -e "  - nginx/certs/server.key (SSL private key)"
echo -e "  - nginx/certs/server.crt (SSL certificate)"
echo -e "\n${BLUE}Next Steps:${NC}"
echo -e "1. Run the following command to start the services:"
echo -e "   ${GREEN}docker compose up -d --build${NC}"
echo -e "2. If any wallets are auto-generated, access the admin interface at:"
echo -e "   ${GREEN}https://localhost/admin${NC}"
echo -e "   and backup all wallet mnemonics immediately."

echo -e "\n${GREEN}Ready for deployment!${NC}"
