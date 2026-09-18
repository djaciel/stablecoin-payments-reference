# One image for every Node service in the repo. Compose decides which one it runs.
# TypeScript runs directly through tsx: this is a reference repo, and a build step
# between you and the code you are reading buys nothing here.
# Debian, not Alpine: Temporal's core-bridge is a native module shipped only for glibc
# targets, so a musl base cannot load the worker at all.
FROM node:22.22-bookworm-slim

WORKDIR /app
RUN corepack enable

# Manifests first, so a code change does not reinstall the whole workspace.
# Every package manifest is listed by hand: a new package that is missing here fails the
# build with ERR_PNPM_OUTDATED_LOCKFILE.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/signer/package.json apps/signer/
COPY apps/ui/package.json apps/ui/
COPY apps/worker/package.json apps/worker/
COPY packages/chain/package.json packages/chain/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/ledger/package.json packages/ledger/
RUN pnpm install --frozen-lockfile

COPY . .
