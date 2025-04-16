#!/bin/bash
set -e

# Create the directories if they don't exist
mkdir -p nginx/certs

# Generate a self-signed certificate and key
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout nginx/certs/server.key \
  -out nginx/certs/server.crt \
  -subj "/C=DE/ST=State/L=Berlin/O=Plan.net Studios/CN=localhost" \
  -addext "subjectAltName = DNS:localhost,IP:127.0.0.1"

# Set appropriate permissions
chmod 600 nginx/certs/server.key
chmod 644 nginx/certs/server.crt

echo "Self-signed certificates generated for development."
echo "For production use, replace with proper certificates from a trusted CA."
