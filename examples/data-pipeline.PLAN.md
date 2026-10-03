---
project: analytics-etl
goal: A production-grade data pipeline that ingests raw sales events, transforms them with dbt, and exposes aggregate tables for a BI dashboard with daily scheduling via Prefect
stack: [python, dbt, duckdb, prefect, pytest]
phases:
  - id: scaffold
    name: Ingest and raw layer
    tasks:
      - pyproject.toml with dbt-duckdb, prefect, pandas, pyarrow, pytest, faker
      - DuckDB database at data/warehouse.duckdb (created on first run, gitignored)
      - Ingest script (src/ingest.py) that reads CSV files from data/raw/ into a raw_events table in DuckDB
      - Seed data generator (scripts/seed.py) that creates 10,000 synthetic sales events with faker
      - A test that seeds data, ingests it, and asserts row count matches
    checks:
      - file_exists: pyproject.toml
      - cmd: python scripts/seed.py && python src/ingest.py && python -m pytest tests/test_ingest.py -x -q
    done_when: 10,000 rows ingested into DuckDB; test passes

  - id: transform
    name: dbt transformation layer
    depends_on: [scaffold]
    tasks:
      - dbt project (dbt_project.yml) targeting DuckDB; profiles.yml reads the database path from env
      - Staging model stg_events.sql that cleans types and filters nulls
      - Intermediate model int_daily_sales.sql that aggregates by date, product, and region
      - Mart model fct_sales.sql: final fact table joining daily_sales with a seeds/products.csv dim table
      - dbt tests for not_null and unique on all primary keys; custom test that asserts total_revenue ≥ 0
      - pytest integration test that runs `dbt run` and `dbt test` programmatically and asserts exit 0
    checks:
      - cmd: cd dbt && dbt run --profiles-dir . --project-dir .
      - cmd: cd dbt && dbt test --profiles-dir . --project-dir .
      - cmd: python -m pytest tests/test_dbt.py -x -q
    done_when: All dbt models run and pass tests; fct_sales is populated

  - id: schedule
    name: Prefect orchestration
    depends_on: [transform]
    tasks:
      - Prefect flow (flows/daily_refresh.py) with two tasks: ingest_task and dbt_task
      - Each task has retry logic (3 retries, exponential backoff) and structured logging
      - `prefect work-pool create --type process local-pool` in a setup script
      - A deployment YAML that schedules the flow daily at 06:00 UTC
      - Integration test that runs the flow once via the Prefect Python API and asserts the last run succeeded
    checks:
      - cmd: python -m pytest tests/test_flow.py -x -q
      - cmd: python -c "from flows.daily_refresh import daily_refresh; print('Flow imported OK')"
    done_when: Flow runs end-to-end programmatically; tests confirm both tasks complete

  - id: quality
    name: Data quality and alerting
    depends_on: [schedule]
    tasks:
      - Great Expectations suite for fct_sales: row count > 0, revenue non-negative, no nulls on key cols
      - Slack alerting task in the Prefect flow: POST to SLACK_WEBHOOK_URL if GE validation fails
      - Data freshness check: raise if max(event_date) in fct_sales is more than 2 calendar days old
      - Integration tests for the GE suite (use the real DuckDB) and mock Slack webhook test
    checks:
      - cmd: python -m pytest tests/ -x -q
      - cmd: cd dbt && dbt run --profiles-dir . --project-dir . && dbt test --profiles-dir . --project-dir .
    done_when: GE suite passes on seeded data; Slack alerting logic is tested with a mock

# Notes for the engine
# - DuckDB path is DATA_DIR/warehouse.duckdb; DATA_DIR defaults to data/ relative to the project root
# - Never hard-code file paths; use pathlib.Path throughout
# - All dbt models must be idempotent (incremental or full-refresh with --full-refresh flag)
# - Monetary amounts in raw data are strings like "1,234.56"; parse them in the staging model
---

Build a data engineering pipeline. Prioritise idempotency, clear error messages, and testability.
