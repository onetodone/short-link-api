#!/usr/bin/env bash
set -eo pipefail

# Load nvm so node and pnpm are available in the non-interactive SSH session
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

cd /opt/nestjs-shortlink-api

echo "==> Fetching and resetting to latest main..."
git fetch origin main
git reset --hard origin/main

echo "==> Enabling pnpm via corepack..."
corepack enable

echo "==> Installing dependencies..."
pnpm install --frozen-lockfile

# pnpm skips postinstall when dependencies are unchanged, so the client must be generated explicitly
echo "==> Generating Prisma client..."
pnpm exec prisma generate

echo "==> Deploying Prisma database migrations..."
pnpm exec prisma migrate deploy

echo "==> Building NestJS application..."
pnpm build

echo "==> Restarting systemd service..."
sudo systemctl restart nestjs-shortlink-api

echo "==> Verifying service readiness..."
retries=15
until curl -sf http://127.0.0.1:3020/health/ready > /dev/null || [ $retries -eq 0 ]; do
  echo "Waiting for app to start... ($retries retries left)"
  retries=$((retries-1))
  sleep 2
done

if [ $retries -eq 0 ]; then
  echo "❌ Healthcheck failed! Service failed to start properly."
  sudo journalctl -u nestjs-shortlink-api -n 30 --no-pager
  exit 1
fi

echo "🚀 Deployment completed successfully and app is healthy!"