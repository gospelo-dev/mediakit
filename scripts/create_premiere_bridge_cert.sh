#!/usr/bin/env bash
set -euo pipefail

# NOTE: This produces a SELF-SIGNED certificate. It is fine for exercising the
# Python bridge with a scripted WebSocket client, but the Premiere UXP panel
# will NOT connect with it: UXP only trusts publicly-issued certificates and
# ignores self-signed / mkcert / private-CA / OS-keychain trust. For the panel
# you need a public-CA (e.g. Let's Encrypt) certificate for a hostname that
# resolves to 127.0.0.1 via /etc/hosts. See premiere_uxp_bridge/README.md.

out_dir="${1:-.premiere-bridge-tls}"
mkdir -p "$out_dir"

openssl req -x509 -nodes -newkey rsa:2048 -sha256 -days 365 \
  -keyout "$out_dir/key.pem" \
  -out "$out_dir/cert.pem" \
  -subj "/CN=127.0.0.1" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"

echo "Created $out_dir/cert.pem and $out_dir/key.pem (self-signed)."
echo "This works for a scripted WebSocket client only."
echo "The Premiere UXP panel needs a public-CA cert; see premiere_uxp_bridge/README.md."
