---
project: inventory-api
goal: A production-ready REST API for inventory management with FastAPI, PostgreSQL, JWT auth, and full OpenAPI docs
stack: [python, fastapi, postgresql, pytest, docker]
preview:
  command: uvicorn app.main:app --reload --port 8000
  url: http://127.0.0.1:8000
  routes: ["/docs"]
phases:
  - id: scaffold
    name: Project scaffold
    tasks:
      - Create a Python project with pyproject.toml (Python 3.12+), FastAPI, SQLAlchemy 2, Alembic, pydantic-settings
      - Dockerised PostgreSQL for local dev via docker-compose.dev.yml; .env.example with DATABASE_URL and SECRET_KEY
      - Alembic migration workflow; initial migration creates the products table
      - Health endpoint GET /health returning {status, db, version}
      - pytest setup with a test database fixture; one smoke test that GETs /health
    checks:
      - file_exists: pyproject.toml
      - file_exists: app/main.py
      - cmd: python -m pytest tests/ -x -q
      - cmd: python -m uvicorn app.main:app --port 8000 &; sleep 2; curl -s http://127.0.0.1:8000/health | python -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('status')=='ok' else 1)"; kill %1
    done_when: The app starts, /health returns ok, and the smoke test passes

  - id: products
    name: Products CRUD
    depends_on: [scaffold]
    tasks:
      - Product model with id, sku (unique), name, description, quantity (int ≥ 0), price (decimal), created_at
      - CRUD endpoints POST /products, GET /products (pagination + search), GET /products/{id}, PATCH /products/{id}, DELETE /products/{id}
      - Input validation via Pydantic; return 422 with field-level errors for invalid input
      - Unit tests for all endpoints including edge cases (duplicate SKU, unknown id, invalid quantity)
    checks:
      - cmd: python -m pytest tests/test_products.py -x -q
      - cmd: python -m uvicorn app.main:app --port 8000 &; sleep 2; curl -sf http://127.0.0.1:8000/products | python -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if isinstance(d,dict) else 1)"; kill %1
    done_when: All CRUD operations work and tests pass with no regressions

  - id: auth
    name: JWT authentication
    depends_on: [products]
    tasks:
      - Users table with email (unique), hashed_password, is_active, role (user | admin)
      - POST /auth/register and POST /auth/token (OAuth2 password flow returning access + refresh JWT)
      - Protect all /products write endpoints with Depends(get_current_user); read endpoints are public
      - Role-based guard: only admins can DELETE /products
      - Tests for register, login, token refresh, protected route rejection, role check
    checks:
      - cmd: python -m pytest tests/ -x -q
      - cmd: python -m uvicorn app.main:app --port 8000 &; sleep 2; R=$(curl -sf -XPOST http://127.0.0.1:8000/products -H 'Content-Type:application/json' -d '{"sku":"X","name":"Y","quantity":1,"price":9.99}'); echo $R | python -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if 'detail' in d else 1)"; kill %1
    done_when: JWT auth works, protected routes reject unauthenticated requests, and all tests pass

  - id: observability
    name: Logging, metrics and OpenAPI polish
    depends_on: [auth]
    tasks:
      - Structured JSON logging via structlog; request ID header propagated through logs
      - Prometheus metrics endpoint /metrics (request count, latency p50/p95, DB pool size)
      - OpenAPI tags, descriptions and examples on all endpoints so /docs is demo-ready
      - Rate limiting (slowapi): 100 req/min per IP on auth endpoints
      - Integration test that hits /metrics and confirms histogram labels exist
    checks:
      - cmd: python -m pytest tests/ -x -q
      - http: /docs
      - http: /metrics
    done_when: Structured logs appear in stdout, /metrics has data, /docs is polished

# Notes for the engine
# - Use SQLAlchemy 2 async (asyncpg driver) and async pytest fixtures
# - Never put secrets in source code; read from pydantic-settings / .env
# - All monetary values use Python Decimal, not float
# - Every endpoint must have a 4xx test and a happy-path test
---

This plan builds a production-grade FastAPI service. The engine should follow Python best practices:
type-annotate everything, use async/await throughout, and ensure `mypy --strict` passes.
