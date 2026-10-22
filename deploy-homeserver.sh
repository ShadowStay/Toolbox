#!/bin/bash

set -e

PROJECT="/home/lakits/Documents/homeserver"

echo "=== Toolbox Deploy ==="

cd "$PROJECT"

echo "[1/3] Adding files..."
git add .

echo "[2/3] Committing..."
git commit -m "Deploy latest"

echo "[3/3] Force pushing to GitHub..."
git push origin main --force

echo
echo "=== Deploy complete ==="
