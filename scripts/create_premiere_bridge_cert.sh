#!/usr/bin/env bash
set -euo pipefail

out_dir="${1:-.premiere-bridge-tls}"
mkdir -p "$out_dir"

openssl req -x509 -nodes -newkey rsa:2048 -sha256 -days 365 \
  -keyout "$out_dir/key.pem" \
  -out "$out_dir/cert.pem" \
  -subj "/CN=127.0.0.1" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"

echo "Created $out_dir/cert.pem and $out_dir/key.pem"
echo "Trust cert.pem in your OS trust store before loading the UXP panel."
