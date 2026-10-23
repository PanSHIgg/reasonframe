COMPOSE ?= docker compose
COMPOSE_FILE ?= deploy/compose.yaml
ENV_FILE ?= deploy/.env
ENV_EXAMPLE ?= deploy/.env.example

.PHONY: test build build-backend build-ai infra-up infra-down compose-config migrate

test:
	npm --prefix ai-service test
	npm --prefix ai-service run test:ai
	cd backend && go test ./...

build: build-backend build-ai

build-backend:
	mkdir -p backend/bin
	go -C backend build -trimpath -o bin/rf ./cmd/rf

build-ai:
	npm --prefix ai-service run build

infra-up:
	@test -f $(ENV_FILE) || cp $(ENV_EXAMPLE) $(ENV_FILE)
	$(COMPOSE) -f $(COMPOSE_FILE) --env-file $(ENV_FILE) up -d --build

infra-down:
	$(COMPOSE) -f $(COMPOSE_FILE) down --remove-orphans

compose-config:
	$(COMPOSE) -f $(COMPOSE_FILE) --env-file $(ENV_EXAMPLE) config

migrate:
	$(COMPOSE) -f $(COMPOSE_FILE) --env-file $(ENV_FILE) run --rm migrate
