# Makefile (root)
# Usage cepat:
#   make up           # build & start containers (frontend+backend)
#   make down         # stop & remove containers
#   make logs         # follow logs all services
#   make fe-log       # follow logs frontend
#   make be-log       # follow logs backend
#   make rebuild      # rebuild images, no cache
#   make clean        # remove images & volumes (awas: hapus data)
#   make dev-be       # run backend locally (cargo run)
#   make dev-fe       # run frontend locally (vite dev)
#   make fmt          # rustfmt + prettier (jika ada)
#   make check        # cargo check

SHELL := /bin/bash
COMPOSE := docker compose
FRONTEND_DIR := frontend
BACKEND_DIR := backend
FRONTEND_PORT ?= 5173
BACKEND_PORT ?= 8080

.PHONY: help
help:
	@echo "Targets:"
	@echo "  up          - build & start containers (frontend+backend)"
	@echo "  down        - stop & remove containers"
	@echo "  logs        - tail logs all services"
	@echo "  fe-log      - tail logs frontend"
	@echo "  be-log      - tail logs backend"
	@echo "  rebuild     - rebuild images with no cache"
	@echo "  restart     - restart services"
	@echo "  clean       - remove containers, images & volumes (DANGER)"
	@echo "  ps          - show running containers"
	@echo "  url         - print service URLs"
	@echo "  dev-be      - run backend locally (requires Rust)"
	@echo "  dev-fe      - run frontend locally (requires Node)"
	@echo "  fmt         - format code (rustfmt + prettier if available)"
	@echo "  check       - cargo check (backend)"

# ---------- Docker (compose) ----------
.PHONY: up
up:
	$(COMPOSE) build
	$(COMPOSE) up -d
	@$(MAKE) url

.PHONY: down
down:
	$(COMPOSE) down

.PHONY: logs
logs:
	$(COMPOSE) logs -f

.PHONY: fe-log
fe-log:
	$(COMPOSE) logs -f frontend

.PHONY: be-log
be-log:
	$(COMPOSE) logs -f backend

.PHONY: rebuild
rebuild:
	$(COMPOSE) build --no-cache
	$(COMPOSE) up -d
	@$(MAKE) url

.PHONY: restart
restart:
	$(COMPOSE) restart

.PHONY: ps
ps:
	$(COMPOSE) ps

.PHONY: url
url:
	@echo "Frontend: http://localhost:$(FRONTEND_PORT)"
	@echo "Backend : http://localhost:$(BACKEND_PORT)"

.PHONY: clean
clean:
	$(COMPOSE) down --volumes --remove-orphans
	# Hapus images yang dibuat compose (opsional)
	-@docker images -q | xargs -r docker rmi

# ---------- Dev lokal (tanpa Docker) ----------
.PHONY: dev-be
dev-be:
	cd $(BACKEND_DIR) && OPENAI_API_KEY=$${OPENAI_API_KEY:?set OPENAI_API_KEY} cargo run

.PHONY: dev-fe
dev-fe:
	cd $(FRONTEND_DIR) && npm install && VITE_BACKEND_URL=$${VITE_BACKEND_URL:-http://localhost:$(BACKEND_PORT)} npm run dev

# ---------- Quality ----------
.PHONY: fmt
fmt:
	# Rust format
	@if command -v cargo >/dev/null 2>&1; then \
		cd $(BACKEND_DIR) && cargo fmt || true ; \
	fi
	# JS/TS format (optional)
	@if command -v npx >/dev/null 2>&1; then \
		cd $(FRONTEND_DIR) && npx --yes prettier -w . || true ; \
	fi

.PHONY: check
check:
	cd $(BACKEND_DIR) && cargo check
