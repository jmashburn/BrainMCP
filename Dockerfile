# Multi-stage build for minimal final image
FROM node:22-slim AS builder

WORKDIR /build

# Copy workspace files
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/app/package.json ./packages/app/

# Install dependencies
RUN npm ci --workspace @obsidian-mcp/app --include-workspace-root

# Copy source code and build configuration
COPY packages/app/src ./packages/app/src
COPY packages/app/tsconfig.json ./packages/app/

# Build both stdio and http bundles
RUN npm run build:stdio --workspace @obsidian-mcp/app && \
    npm run build:http --workspace @obsidian-mcp/app

# Production dependencies only.
#
# The stdio and http bundles are built with esbuild's --packages=external, so
# they import their dependencies at runtime rather than inlining them. Without
# node_modules in the runtime image the server cannot start at all — it fails
# on the first import. (The lambda bundle differs: it has no --packages=external
# and is self-contained, which is why that path works.)
FROM node:22-slim AS deps

WORKDIR /deps

COPY package.json package-lock.json ./
COPY packages/app/package.json ./packages/app/

RUN npm ci --omit=dev --workspace @obsidian-mcp/app --include-workspace-root

# Runtime stage - minimal Node.js image
FROM node:22-slim

WORKDIR /app

# Install git (required for simple-git operations at runtime)
RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# gitleaks, for vaults that carry their own pre-commit secret scanning
# (VAULT_HOOKS_PATH). Hooks run inside this container, so a vault hook that
# shells out to gitleaks finds nothing unless the binary is here — and because
# such hooks fail closed, its absence turns into "every write fails" rather
# than "scanning is off".
#
# Pinned rather than tracking latest: an image rebuild should not silently
# change what does or doesn't get flagged.
ARG GITLEAKS_VERSION=8.30.1
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) gl_arch=x64 ;; \
      arm64) gl_arch=arm64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/gitleaks.tar.gz \
      "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${gl_arch}.tar.gz"; \
    tar -C /usr/local/bin -xzf /tmp/gitleaks.tar.gz gitleaks; \
    chmod +x /usr/local/bin/gitleaks; \
    rm -f /tmp/gitleaks.tar.gz; \
    gitleaks version

# Runtime dependencies, keeping the workspace layout.
#
# npm hoists most packages to the root but nests any that conflict (currently
# `diff`) under packages/app/node_modules. Flattening the two into one directory
# would work today and silently install the wrong version the first time a real
# conflict appears, so preserve the structure and let node resolve as it does in
# development. This also brings package.json, whose "type": "module" the ESM
# bundles need — without it node parses them as CommonJS and fails on the first
# import.
COPY --from=deps /deps ./

# Copy built bundles from builder
COPY --from=builder /build/packages/app/dist/stdio/index.js ./packages/app/dist/stdio/index.js
COPY --from=builder /build/packages/app/dist/http/index.js ./packages/app/dist/http/index.js

# Create entrypoint script inline
RUN cat > /app/entrypoint.sh <<'EOF'
#!/bin/sh
set -e

# A vault hook that fails closed turns a missing scanner into "every write
# fails" at first use, which reads as a server bug. Say so at startup instead.
if [ -n "${VAULT_HOOKS_PATH:-}" ] && ! command -v gitleaks >/dev/null 2>&1; then
  echo "WARNING: VAULT_HOOKS_PATH=${VAULT_HOOKS_PATH} but gitleaks is not on PATH." >&2
  echo "         A vault hook that scans for secrets will fail every commit." >&2
fi

# Default mode is stdio if no argument provided
MODE="${1:-stdio}"

case "$MODE" in
  stdio)
    echo "Starting Obsidian MCP Server in stdio mode..."
    exec node packages/app/dist/stdio/index.js
    ;;
  http)
    echo "Starting Obsidian MCP Server in http mode..."
    exec node packages/app/dist/http/index.js
    ;;
  *)
    echo "Error: Invalid mode '$MODE'. Use 'stdio' or 'http'."
    echo "Usage: docker run ... obsidian-mcp [stdio|http]"
    echo "  stdio (default) - Run in stdio mode for local MCP clients"
    echo "  http            - Run in HTTP mode on port 3000"
    exit 1
    ;;
esac
EOF

RUN chmod +x /app/entrypoint.sh

# Set environment variables
ENV NODE_ENV=production \
    NODE_OPTIONS="--no-warnings" \
    LOCAL_VAULT_PATH=/app/vaults/vault-local

# Create directory for git clones (vault storage)
RUN mkdir -p /app/vaults

# Expose port for HTTP mode (used when running with 'http' argument)
EXPOSE 3000

# Use custom entrypoint script to handle mode selection
# Defaults to stdio mode
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["stdio"]
