# syntax=docker/dockerfile:1

# ---------- Stage 1: install dependencies (cached until package*.json changes) ----------
FROM node:20-bookworm-slim AS deps
WORKDIR /app

# Toolchain only as a fallback for native modules without prebuilt binaries
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# ---------- Stage 2: build Strapi (server TS + admin panel) ----------
FROM node:20-bookworm-slim AS build
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund

# ---------- Stage 3: runtime ----------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=1337

COPY --from=build --chown=node:node /app ./
RUN mkdir -p /app/.tmp /app/public/uploads && chown -R node:node /app/.tmp /app/public

USER node
EXPOSE 1337
CMD ["npm", "run", "start"]
