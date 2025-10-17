# frontend/Dockerfile
# frontend/Dockerfile
# syntax=docker/dockerfile:1.6

# ---------- build stage ----------
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Tooling seperlunya untuk beberapa deps native
RUN apt-get update && apt-get install -y --no-install-recommends \
    git python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Konfigurasi npm biar stabil + Rollup pakai fallback JS (tanpa binary native)
ENV CI=true \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_progress=false \
    ROLLUP_SKIP_NODEJS_NATIVE=1

RUN npm config set registry https://registry.npmjs.org \
 && npm config set fetch-retries 8 \
 && npm config set fetch-retry-mintimeout 40000 \
 && npm config set fetch-retry-maxtimeout 240000 \
 && npm config set fetch-timeout 1200000 \
 && npm config set loglevel info \
 && npm config set prefer-online true

# Jika koneksi npm lambat, boleh pakai mirror:
# RUN npm config set registry https://registry.npmmirror.com

# Copy manifest (aman walau tanpa lockfile)
COPY package*.json ./

# Install deps (pakai cache buildkit supaya next build lebih cepat)
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then \
      npm ci --verbose --legacy-peer-deps --cache /root/.npm; \
    else \
      npm install --verbose --legacy-peer-deps --cache /root/.npm; \
    fi

# Copy source + build
COPY . .
RUN npm run build

# ---------- runtime stage ----------
FROM nginx:1.27-alpine
WORKDIR /usr/share/nginx/html

# Copy hasil build Vite
COPY --from=build /app/dist ./

# Nginx untuk SPA + proxy /api ke backend
COPY nginx.conf /etc/nginx/nginx.conf

# Healthcheck ke /health (di-proxy ke backend)
RUN apk add --no-cache curl
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1/health || exit 1

EXPOSE 80
