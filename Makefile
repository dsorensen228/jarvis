.PHONY: api-sync api-test api-lint api-run contracts device-ui-sync device-ui-build \
	mobile-sync mobile-typecheck mobile-web wear-debug wear-factory-debug camera-sync camera-test camera-lint \
	voice-sync voice-models voice-test voice-lint jetson-models jetson-build jetson-up \
	jetson-down jetson-api-deploy jetson-api-restart code-factory-sync code-factory-test \
	code-factory-lint

api-sync:
	cd apps/api && uv sync --extra dev --python 3.8.10

api-test:
	cd apps/api && .venv/bin/pytest

api-lint:
	cd apps/api && .venv/bin/ruff check . && .venv/bin/ruff format --check .

api-run:
	cd apps/api && .venv/bin/python -m jarvis_api

contracts:
	cd apps/api && .venv/bin/python ../../scripts/export_openapi.py

device-ui-sync:
	npm ci

device-ui-build:
	npm run device-ui:build

mobile-sync:
	cd apps/mobile && npm ci

mobile-typecheck:
	cd apps/mobile && npm run typecheck

mobile-web:
	cd apps/mobile && npm run build:web

wear-debug:
	cd apps/wear && ./gradlew :wear:assembleDebug

wear-factory-debug:
	cd apps/wear-factory && ./gradlew :wear:assembleDebug :wear:testDebugUnitTest

camera-sync:
	cd devices/camera && uv sync --extra dev --locked --python 3.13.5

camera-test:
	cd devices/camera && .venv/bin/pytest

camera-lint:
	cd devices/camera && .venv/bin/ruff check . && .venv/bin/ruff format --check .

voice-sync:
	cd devices/voice && uv sync --all-groups --locked --python 3.13.5

voice-models:
	cd devices/voice && .venv/bin/python scripts/download-wake-models.py

voice-test:
	cd devices/voice && .venv/bin/pytest

voice-lint:
	cd devices/voice && .venv/bin/ruff check src tests scripts && .venv/bin/ruff format --check src tests scripts

code-factory-sync:
	cd services/code-factory && uv sync --locked --python 3.13.5

code-factory-test:
	cd services/code-factory && .venv/bin/pytest

code-factory-lint:
	cd services/code-factory && .venv/bin/ruff check . && .venv/bin/ruff format --check .

jetson-models:
	./scripts/download_jetson_models.sh

jetson-build:
	docker compose -f deploy/jetson/compose.yml build

jetson-up:
	docker compose -f deploy/jetson/compose.yml up -d

jetson-down:
	docker compose -f deploy/jetson/compose.yml down

jetson-api-deploy:
	docker compose -f deploy/jetson/compose.yml build api
	docker compose -f deploy/jetson/compose.yml up -d --no-deps api

jetson-api-restart:
	docker compose -f deploy/jetson/compose.yml restart api
