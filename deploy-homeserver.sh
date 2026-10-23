#!/bin/bash

set -e

PROJECT="/home/lakits/Documents/homeserver"

echo "=== Toolbox Deploy ==="

cd "$PROJECT"

echo "[1/3] Adding files..."
git add .

echo "[2/3] Committing..."
git commit -m "Deploy latest" || echo "Nothing new to commit."    # no changes is not an error

echo "[3/3] Pushing to GitHub..."
# --force-with-lease overwrites GitHub only if nobody changed it since your last push or fetch (a PR merged on the
# website, an edit made there); otherwise it stops instead of throwing that work away.
git push origin main --force-with-lease

echo
echo "=== Deploy complete ==="
