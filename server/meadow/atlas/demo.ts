import fs from "node:fs";
import path from "node:path";
import { capture } from "../core/exec";
import { DEFAULT_GITIGNORE } from "../core/git";

/**
 * AcmePay: a reproducible multi-service repository with real git history, releases, PR merges,
 * incidents and docs. The planted root cause: PR #482 raises payment retries and drops backoff,
 * each retry holds a pooled DB connection, the pool saturates in v2.4.0 and payments time out (INC-2041).
 */

type Author = { name: string; email: string };
const PEOPLE = {
  priya: { name: "Priya Shah", email: "priya@acmepay.dev" },
  dana: { name: "Dana Kim", email: "dana@acmepay.dev" },
  marco: { name: "Marco Silva", email: "marco@acmepay.dev" },
  lena: { name: "Lena Okafor", email: "lena@acmepay.dev" },
  sam: { name: "Sam Patel", email: "sam@acmepay.dev" },
} satisfies Record<string, Author>;

const RETRY_V1 = `import { setTimeout as sleep } from "node:timers/promises";

export type RetryPolicy = { maxAttempts: number; baseDelayMs: number; jitter: boolean };

/** Conservative default: two attempts with jittered exponential backoff. */
export const retryPolicy: RetryPolicy = { maxAttempts: 2, baseDelayMs: 200, jitter: true };

export function backoffDelay(attempt: number, policy: RetryPolicy = retryPolicy): number {
  const base = policy.baseDelayMs * 2 ** (attempt - 1);
  return policy.jitter ? Math.round(base / 2 + Math.random() * (base / 2)) : base;
}

export async function withRetry<T>(operation: (attempt: number) => Promise<T>, policy: RetryPolicy = retryPolicy): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < policy.maxAttempts) await sleep(backoffDelay(attempt, policy));
    }
  }
  throw lastError;
}
`;

const RETRY_V2 = RETRY_V1
  .replace("/** Conservative default: two attempts with jittered exponential backoff. */\nexport const retryPolicy: RetryPolicy = { maxAttempts: 2, baseDelayMs: 200, jitter: true };", "/** Retry aggressively so transient card-network errors do not fail checkout. */\nexport const retryPolicy: RetryPolicy = { maxAttempts: 6, baseDelayMs: 0, jitter: false };")
  .replace("      if (attempt < policy.maxAttempts) await sleep(backoffDelay(attempt, policy));\n", "      if (attempt < policy.maxAttempts && policy.baseDelayMs > 0) await sleep(backoffDelay(attempt, policy));\n");

const RETRY_V3 = RETRY_V1.replace("/** Conservative default: two attempts with jittered exponential backoff. */\nexport const retryPolicy: RetryPolicy = { maxAttempts: 2, baseDelayMs: 200, jitter: true };", "/** Capped after INC-2041: three attempts, jittered backoff, connection released between attempts. */\nexport const retryPolicy: RetryPolicy = { maxAttempts: 3, baseDelayMs: 250, jitter: true };");

const CHARGE_V1 = `import { pool } from "./db";
import { withRetry } from "./retry";

const FRAUD_SERVICE_URL = process.env.FRAUD_SERVICE_URL ?? "http://fraud-service:8000";
const LEDGER_SERVICE_URL = process.env.LEDGER_SERVICE_URL ?? "http://ledger-service:9000";

export type ChargeRequest = { customerId: string; amountCents: number; currency: string; cardToken: string; idempotencyKey: string };

export async function scoreFraud(request: ChargeRequest): Promise<number> {
  const response = await fetch(\`\${FRAUD_SERVICE_URL}/score\`, { method: "POST", body: JSON.stringify(request) });
  const body = (await response.json()) as { score: number };
  return body.score;
}

export async function postLedgerEntry(paymentId: string, amountCents: number) {
  await fetch(\`\${LEDGER_SERVICE_URL}/ledger/entries\`, { method: "POST", body: JSON.stringify({ paymentId, amountCents }) });
}

/** Charges a card. Each attempt checks out a pooled connection for the whole card-network call. */
export async function chargeCard(request: ChargeRequest) {
  const score = await scoreFraud(request);
  if (score > 0.9) throw new Error("payment rejected by fraud screening");
  return withRetry(async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const customer = await client.query("SELECT id, risk_tier FROM customers WHERE id = $1", [request.customerId]);
      const result = await client.query("INSERT INTO payments (customer_id, amount_cents, currency, status, idempotency_key) VALUES ($1, $2, $3, 'authorised', $4) RETURNING id", [customer.rows[0].id, request.amountCents, request.currency, request.idempotencyKey]);
      await callCardNetwork(request);
      await client.query("COMMIT");
      await postLedgerEntry(result.rows[0].id, request.amountCents);
      return { id: result.rows[0].id, status: "authorised" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}

export async function callCardNetwork(request: ChargeRequest) {
  const response = await fetch("https://cards.example.net/authorise", { method: "POST", body: JSON.stringify({ token: request.cardToken, amount: request.amountCents }) });
  if (!response.ok) throw new Error(\`card network returned \${response.status}\`);
}
`;

const BASE: Record<string, string> = {
  ".gitignore": `${DEFAULT_GITIGNORE}.atlas/eval.json\n`,
  ".meadow/rules.md": "",
  "README.md": `# AcmePay

AcmePay is a payments platform made of six services behind an API gateway.

- api-gateway: public HTTP edge, auth and routing.
- payment-service: card authorisation, refunds and the payments table.
- order-service: checkout orders; asks payment-service to charge.
- fraud-service: risk scoring for every charge.
- ledger-service: double-entry ledger for settled money.
- notification-service: emails and webhooks after payment events.

See docs/architecture.md for the full picture and docs/runbooks for on-call guides.
`,
  "CODEOWNERS": `/services/api-gateway/ @acme/platform-team
/services/payment-service/ @acme/payments-team
/services/order-service/ @acme/commerce-team
/services/fraud-service/ @acme/risk-team
/services/ledger-service/ @acme/ledger-team
/services/notification-service/ @acme/platform-team
/infra/ @acme/platform-team
`,
  "docker-compose.yml": `services:
  api-gateway:
    build: ./services/api-gateway
    depends_on:
      - payment-service
      - order-service
  order-service:
    build: ./services/order-service
    depends_on:
      - payment-service
      - postgres
  payment-service:
    build: ./services/payment-service
    depends_on:
      - postgres
      - fraud-service
      - ledger-service
  fraud-service:
    build: ./services/fraud-service
  ledger-service:
    build: ./services/ledger-service
    depends_on:
      - postgres
  notification-service:
    build: ./services/notification-service
  postgres:
    image: postgres:16
`,
  "db/migrations/001_init.sql": `CREATE TABLE customers (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  risk_tier TEXT NOT NULL DEFAULT 'standard'
);

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id),
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT UNIQUE
);

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id),
  total_cents INTEGER NOT NULL,
  payment_id UUID REFERENCES payments(id)
);

CREATE TABLE ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  payment_id UUID NOT NULL,
  debit_account TEXT NOT NULL,
  credit_account TEXT NOT NULL,
  amount_cents INTEGER NOT NULL
);

CREATE TABLE fraud_rules (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  threshold NUMERIC NOT NULL
);
`,
  "infra/terraform/main.tf": `resource "aws_db_instance" "payments_db" {
  engine            = "postgres"
  instance_class    = "db.r6g.large"
  max_connections   = 100
}

resource "aws_ecs_service" "payment_service" {
  name          = "payment-service"
  desired_count = 4
}

resource "aws_ecs_service" "api_gateway" {
  name          = "api-gateway"
  desired_count = 3
}

resource "aws_ecs_service" "order_service" {
  name          = "order-service"
  desired_count = 2
}

resource "aws_ecs_service" "fraud_service" {
  name          = "fraud-service"
  desired_count = 2
}

resource "aws_ecs_service" "ledger_service" {
  name          = "ledger-service"
  desired_count = 2
}

resource "aws_sqs_queue" "notification_events" {
  name = "notification-events"
}
`,
  ".github/workflows/deploy.yml": `name: Deploy
on:
  push:
    tags: ["v*"]
jobs:
  deploy:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        service: [api-gateway, payment-service, order-service, fraud-service, ledger-service, notification-service]
    steps:
      - uses: actions/checkout@v4
      - run: ./scripts/deploy.sh \${{ matrix.service }}
`,
  "services/api-gateway/package.json": JSON.stringify({ name: "api-gateway", version: "2.2.0", dependencies: { express: "^4.19.2", "http-proxy-middleware": "^3.0.0" } }, null, 2),
  "services/api-gateway/src/server.ts": `import express from "express";
import { requireApiKey } from "./auth";

const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL ?? "http://payment-service:8080";
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL ?? "http://order-service:8081";
const UPSTREAM_TIMEOUT_MS = 5000;

const app = express();
app.use(express.json());
app.use(requireApiKey);

export async function forward(base: string, path: string, body: unknown) {
  const response = await fetch(\`\${base}\${path}\`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  return { status: response.status, body: await response.json() };
}

app.post("/v1/payments", async (req, res) => {
  const result = await forward(PAYMENT_SERVICE_URL, "/payments", req.body);
  res.status(result.status).json(result.body);
});

app.post("/v1/orders", async (req, res) => {
  const result = await forward(ORDER_SERVICE_URL, "/orders", req.body);
  res.status(result.status).json(result.body);
});

app.listen(3000);
`,
  "services/api-gateway/src/auth.ts": `import type { NextFunction, Request, Response } from "express";

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (!req.header("x-api-key")) return res.status(401).json({ error: "missing api key" });
  next();
}
`,
  "services/payment-service/package.json": JSON.stringify({ name: "payment-service", version: "2.2.0", dependencies: { express: "^4.19.2", pg: "^8.11.0" } }, null, 2),
  "services/payment-service/src/db.ts": `import { Pool } from "pg";

/** Shared Postgres pool. 4 tasks x 20 connections stays under the payments_db limit of 100. */
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20, connectionTimeoutMillis: 2000 });
`,
  "services/payment-service/src/retry.ts": RETRY_V1,
  "services/payment-service/src/charge.ts": CHARGE_V1,
  "services/payment-service/src/server.ts": `import express from "express";
import { chargeCard } from "./charge";
import { pool } from "./db";

const app = express();
app.use(express.json());

app.post("/payments", async (req, res) => {
  try {
    res.status(201).json(await chargeCard(req.body));
  } catch (error) {
    res.status(502).json({ error: (error as Error).message });
  }
});

app.get("/payments/:id", async (req, res) => {
  const result = await pool.query("SELECT id, status, amount_cents FROM payments WHERE id = $1", [req.params.id]);
  res.json(result.rows[0] ?? null);
});

app.listen(8080);
`,
  "services/payment-service/openapi.yaml": `openapi: 3.0.0
info:
  title: Payment Service
paths:
  /payments:
    post:
      summary: Authorise a card payment
  /payments/{id}:
    get:
      summary: Fetch a payment by id
`,
  "services/order-service/package.json": JSON.stringify({ name: "order-service", version: "2.2.0", dependencies: { express: "^4.19.2", pg: "^8.11.0" } }, null, 2),
  "services/order-service/src/orders.ts": `import express from "express";
import { Pool } from "pg";

const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL ?? "http://payment-service:8080";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const app = express();
app.use(express.json());

export async function createOrder(customerId: string, totalCents: number, cardToken: string) {
  const payment = await fetch(\`\${PAYMENT_SERVICE_URL}/payments\`, { method: "POST", body: JSON.stringify({ customerId, amountCents: totalCents, currency: "usd", cardToken }) });
  const body = (await payment.json()) as { id: string };
  const result = await pool.query("INSERT INTO orders (customer_id, total_cents, payment_id) VALUES ($1, $2, $3) RETURNING id", [customerId, totalCents, body.id]);
  return result.rows[0];
}

app.post("/orders", async (req, res) => {
  res.status(201).json(await createOrder(req.body.customerId, req.body.totalCents, req.body.cardToken));
});

app.listen(8081);
`,
  "services/fraud-service/requirements.txt": "fastapi==0.111.0\nuvicorn==0.30.0\npsycopg==3.1.19\n",
  "services/fraud-service/app/main.py": `from fastapi import FastAPI
from .rules import load_rules

app = FastAPI()


def score_payment(payload: dict) -> float:
    """Combine rule weights into a 0..1 risk score."""
    rules = load_rules()
    score = 0.0
    if payload.get("amountCents", 0) > 500_000:
        score += rules.get("large_amount", 0.4)
    if payload.get("currency") not in ("usd", "eur"):
        score += rules.get("foreign_currency", 0.2)
    return min(score, 1.0)


@app.post("/score")
def score(payload: dict):
    return {"score": score_payment(payload)}
`,
  "services/fraud-service/app/rules.py": `import psycopg

_cache: dict = {}


def load_rules() -> dict:
    """Read thresholds from the fraud_rules table, cached in memory."""
    if _cache:
        return _cache
    with psycopg.connect() as conn:
        for name, threshold in conn.execute("SELECT name, threshold FROM fraud_rules"):
            _cache[name] = float(threshold)
    return _cache
`,
  "services/ledger-service/go.mod": "module github.com/acmepay/ledger-service\n\ngo 1.22\n",
  "services/ledger-service/main.go": `package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
)

var db *sql.DB

type Entry struct {
	PaymentID   string \`json:"paymentId"\`
	AmountCents int    \`json:"amountCents"\`
}

func RecordEntry(entry Entry) error {
	_, err := db.Exec("INSERT INTO ledger_entries (payment_id, debit_account, credit_account, amount_cents) VALUES ($1, 'customer', 'merchant', $2)", entry.PaymentID, entry.AmountCents)
	return err
}

func handleEntries(w http.ResponseWriter, r *http.Request) {
	var entry Entry
	if err := json.NewDecoder(r.Body).Decode(&entry); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := RecordEntry(entry); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusCreated)
}

func main() {
	http.HandleFunc("/ledger/entries", handleEntries)
	http.ListenAndServe(":9000", nil)
}
`,
  "services/notification-service/requirements.txt": "fastapi==0.111.0\nboto3==1.34.0\n",
  "services/notification-service/app/main.py": `from fastapi import FastAPI

app = FastAPI()


def render_receipt(payment: dict) -> str:
    return f"Payment {payment['id']} for {payment['amountCents'] / 100:.2f} succeeded."


@app.post("/notify")
def notify(payment: dict):
    """Send a receipt email when a payment is authorised."""
    return {"sent": True, "body": render_receipt(payment)}
`,
  "docs/architecture.md": `# AcmePay architecture

## Request flow

Clients call the api-gateway, which forwards checkout requests to order-service and direct charges to payment-service.
order-service asks payment-service to charge the card. payment-service calls fraud-service for a risk score before charging,
then records money movement through ledger-service. notification-service sends receipts.

## Data

All services share the payments_db Postgres instance (max 100 connections). payment-service owns the payments table,
order-service owns orders, ledger-service owns ledger_entries and fraud-service reads fraud_rules.

## Timeouts

The api-gateway gives upstreams 5 seconds. payment-service waits up to 2 seconds for a pooled database connection.
`,
  "docs/runbooks/payment-timeouts.md": `# Runbook: payment timeouts

## Symptoms

api-gateway returns 504 on POST /v1/payments and p99 latency climbs above 5 seconds.

## Checks

1. Look at payment-service logs for "timeout exceeded when trying to connect" which means the pg pool is exhausted.
2. Compare active connections on payments_db against max_connections (100).
3. Check whether a recent release changed retry or pool settings in payment-service.

## Mitigation

Scale payment-service down to reduce total connections, or roll back the last release.
`,
  "docs/adr/0003-retry-policy.md": `# ADR 0003: payment retry policy

## Decision

payment-service retries card authorisation at most twice with jittered exponential backoff.
Every attempt holds a database connection, so retry counts multiply pool usage.

## Consequences

Higher retry counts must be paired with releasing the connection between attempts.
`,
  "incidents/INC-1877.md": `---
id: INC-1877
title: Fraud scores slow during rules reload
date: 2025-12-18T09:10:00Z
severity: SEV3
services: [fraud-service]
---
## Summary

fraud-service took 3 seconds per score while the rules cache was rebuilt after a deploy. Charges were slower but succeeded.

## Resolution

The rules cache is now warmed on startup.
`,
};

type Step = { date: string; author: Author; message: string; files?: Record<string, string>; remove?: string[]; tag?: string };

const STEPS: Step[] = [
  { date: "2025-11-01T10:00:00Z", author: PEOPLE.priya, message: "Initial AcmePay platform", files: BASE },
  { date: "2025-11-03T16:00:00Z", author: PEOPLE.priya, message: "Release v2.2.0", tag: "v2.2.0" },
  {
    date: "2025-12-02T11:20:00Z", author: PEOPLE.marco, message: "Add refund endpoint to payment-service (#431)",
    files: {
      "services/payment-service/src/refunds.ts": `import { pool } from "./db";

export async function refundPayment(paymentId: string, amountCents: number) {
  await pool.query("UPDATE payments SET status = 'refunded' WHERE id = $1", [paymentId]);
  await pool.query("INSERT INTO refunds (payment_id, amount_cents) VALUES ($1, $2)", [paymentId, amountCents]);
}
`,
      "db/migrations/002_refunds.sql": "CREATE TABLE refunds (\n  id BIGSERIAL PRIMARY KEY,\n  payment_id UUID REFERENCES payments(id),\n  amount_cents INTEGER NOT NULL\n);\n",
    },
  },
  {
    date: "2025-12-19T14:05:00Z", author: PEOPLE.lena, message: "Warm fraud rules cache on startup (#440)",
    files: { "services/fraud-service/app/startup.py": "from .rules import load_rules\n\n\ndef warm_cache() -> None:\n    \"\"\"Called on boot so the first score does not hit the database.\"\"\"\n    load_rules()\n" },
  },
  { date: "2026-01-08T15:00:00Z", author: PEOPLE.priya, message: "Release v2.3.0", tag: "v2.3.0" },
  {
    date: "2026-02-10T10:30:00Z", author: PEOPLE.sam, message: "Receipt templates for notification-service (#470)",
    files: { "services/notification-service/app/templates.py": "RECEIPT = \"Thanks! Payment {id} for {amount} succeeded.\"\n\n\ndef receipt_template(payment: dict) -> str:\n    return RECEIPT.format(id=payment['id'], amount=payment['amountCents'] / 100)\n" },
  },
  {
    date: "2026-02-24T13:45:00Z", author: PEOPLE.lena, message: "Idempotency keys for ledger entries (#478)",
    files: { "db/migrations/003_ledger_idempotency.sql": "ALTER TABLE ledger_entries ADD COLUMN idempotency_key TEXT UNIQUE;\n" },
  },
  {
    date: "2026-03-04T17:10:00Z", author: PEOPLE.dana, message: "Increase payment retry attempts and remove backoff for card network blips (#482)",
    files: { "services/payment-service/src/retry.ts": RETRY_V2 },
  },
  { date: "2026-03-11T15:30:00Z", author: PEOPLE.priya, message: "Release v2.4.0", tag: "v2.4.0" },
  {
    date: "2026-03-12T18:40:00Z", author: PEOPLE.priya, message: "Postmortem for INC-2041",
    files: {
      "incidents/INC-2041.md": `---
id: INC-2041
title: Payment API timeouts after release v2.4.0
date: 2026-03-12T14:20:00Z
severity: SEV1
services: [payment-service, api-gateway, order-service]
release: v2.4.0
---
## Summary

From 14:20 UTC the api-gateway returned 504 for 38% of POST /v1/payments requests and checkout failed in order-service.

## Timeline

- 14:20 alerts fire for p99 latency above 5s on the api-gateway.
- 14:31 payment-service logs show "timeout exceeded when trying to connect" from the pg pool.
- 14:52 payments_db reports 100 of 100 connections in use.
- 15:40 v2.4.0 rolled back; latency recovers.

## Contributing factors

Under card-network latency each charge attempt held a pooled connection. Something in v2.4.0 made attempts pile up.
`,
    },
  },
  {
    date: "2026-03-13T11:00:00Z", author: PEOPLE.dana, message: "Cap payment retries at 3 with jittered backoff (#489)",
    files: { "services/payment-service/src/retry.ts": RETRY_V3 },
  },
  { date: "2026-03-13T16:00:00Z", author: PEOPLE.priya, message: "Release v2.4.1", tag: "v2.4.1" },
  {
    date: "2026-04-02T09:15:00Z", author: PEOPLE.lena, message: "Ledger reconciliation job (#495)",
    files: {
      "services/ledger-service/reconcile.go": `package main

func Reconcile() (int, error) {
	row := db.QueryRow("SELECT COUNT(*) FROM ledger_entries WHERE credit_account = 'merchant'")
	var count int
	err := row.Scan(&count)
	return count, err
}
`,
      "incidents/INC-1990.md": `---
id: INC-1990
title: Ledger reconciliation lag
date: 2026-04-05T08:00:00Z
severity: SEV3
services: [ledger-service]
---
## Summary

The nightly reconciliation over ledger_entries ran for 40 minutes. No customer impact.
`,
    },
  },
];

export type EvalCase = { id: string; question: string; type: string; relevant: string[]; answerHints: string[] };

/** Ground truth for the retrieval benchmark. `relevant` holds graph node keys. */
export const ACMEPAY_EVAL: EvalCase[] = [
  { id: "root-cause", question: "Why did payment API timeouts start after release v2.4.0?", type: "multi-hop", relevant: ["pr:#482", "file:services/payment-service/src/retry.ts", "incident:INC-2041", "release:v2.4.0"], answerHints: ["#482", "retry", "pool"] },
  { id: "callers", question: "Which services call payment-service?", type: "relationship", relevant: ["service:api-gateway", "service:order-service"], answerHints: ["api-gateway", "order-service"] },
  { id: "owner-fraud", question: "Who owns fraud-service?", type: "entity", relevant: ["team:@acme/risk-team", "service:fraud-service"], answerHints: ["risk-team"] },
  { id: "ledger-writes", question: "Which tables does ledger-service write to?", type: "relationship", relevant: ["table:ledger_entries", "service:ledger-service"], answerHints: ["ledger_entries"] },
  { id: "retry-impl", question: "Where is the payment retry policy implemented?", type: "code", relevant: ["file:services/payment-service/src/retry.ts"], answerHints: ["retry.ts"] },
  { id: "release-diff", question: "What changed between v2.3.0 and v2.4.0?", type: "temporal", relevant: ["pr:#470", "pr:#478", "pr:#482", "release:v2.4.0"], answerHints: ["#482", "#478", "#470"] },
  { id: "incidents-payment", question: "Which incidents affected payment-service?", type: "relationship", relevant: ["incident:INC-2041"], answerHints: ["INC-2041"] },
  { id: "payments-db", question: "What runs on the payments_db database?", type: "relationship", relevant: ["infra:tf:aws_db_instance.payments_db", "table:payments"], answerHints: ["payments_db"] },
  { id: "orders-endpoint", question: "Which endpoint creates orders?", type: "exact", relevant: ["api:POST /orders", "api:POST /v1/orders"], answerHints: ["/orders"] },
  { id: "fraud-scoring", question: "How does fraud scoring work?", type: "code", relevant: ["file:services/fraud-service/app/main.py", "service:fraud-service"], answerHints: ["score_payment"] },
  { id: "runbook", question: "What is the runbook for payment timeouts?", type: "semantic", relevant: ["doc:docs/runbooks/payment-timeouts.md"], answerHints: ["pool"] },
  { id: "refund-pr", question: "Which PR introduced refunds?", type: "temporal", relevant: ["pr:#431"], answerHints: ["#431"] },
];

async function run(cwd: string, args: string[], env: Record<string, string> = {}) {
  const result = await capture("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env }, timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
}

/** Writes the AcmePay repository with its full history into `dir` (must be empty or absent). */
export async function generateAcmePay(dir: string): Promise<{ commits: number; tags: string[] }> {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} is not empty`);
  fs.mkdirSync(dir, { recursive: true });
  await run(dir, ["init", "-q", "-b", "main"]);
  const tags: string[] = [];
  for (const step of STEPS) {
    for (const [file, content] of Object.entries(step.files ?? {})) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), content);
    }
    for (const file of step.remove ?? []) fs.rmSync(path.join(dir, file), { force: true });
    const env = { GIT_AUTHOR_NAME: step.author.name, GIT_AUTHOR_EMAIL: step.author.email, GIT_AUTHOR_DATE: step.date, GIT_COMMITTER_NAME: step.author.name, GIT_COMMITTER_EMAIL: step.author.email, GIT_COMMITTER_DATE: step.date };
    if (step.tag) {
      await run(dir, ["tag", "-a", step.tag, "-m", step.message], env);
      tags.push(step.tag);
      continue;
    }
    await run(dir, ["add", "-A"], env);
    await run(dir, ["commit", "-q", "-m", step.message], env);
  }
  fs.mkdirSync(path.join(dir, ".atlas"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".atlas", "eval.json"), JSON.stringify(ACMEPAY_EVAL, null, 2));
  return { commits: STEPS.filter(step => !step.tag).length, tags };
}
