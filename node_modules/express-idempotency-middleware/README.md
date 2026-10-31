# express-idempotency-middleware

[![npm version](https://img.shields.io/npm/v/express-idempotency-middleware.svg)](https://www.npmjs.com/package/express-idempotency-middleware)

Express middleware that makes **unsafe** HTTP requests (mainly `POST`) **idempotent** using an `Idempotency-Key`.
The first request executes your handler and caches `{status, body, headers(whitelist)}` for a TTL. Identical retries return the cached response. Conflicting payloads get `409 Conflict`. Bodies above the fingerprint size limit get `413 Payload Too Large` before a key is claimed. Concurrency is handled via `wait` or `reject` strategies.

---

## Highlights

- **Drop-in** per-route middleware
- **TypeScript-first**, ESM-only, Node ≥ 18
- Pluggable **stores**: built-in Memory (dev). Example Redis/Postgres stores in `examples/`
- **In-flight control**: `wait` (with timeout) or `reject`
- **Safe replay** with **header whitelist** (never replays cookies/auth)
- **Stable fingerprint**: method + path + normalized body + optional tenant/user
- **No partial fingerprints**: oversized bodies are rejected instead of being hashed only in part
- Designed for payments, orders, webhooks, and similar at-least-once scenarios

---

## Install

```bash
npm i express-idempotency-middleware
# peer
npm i express
```

> **ESM-only:** your project should use `"type": "module"` or native ESM (Node 18+).

---

## Quick Start

```ts
import express from "express";
import { idempotencyMiddleware, MemoryStore } from "express-idempotency-middleware";

const app = express();
app.use(express.json());

const store = new MemoryStore();

app.post(
  "/payments",
  idempotencyMiddleware({
    store,
    ttlMs: 24 * 60 * 60 * 1000,
    inFlight: { strategy: "wait", waitTimeoutMs: 3000, pollMs: 100 },
    replay: { headerWhitelist: ["location"] }
  }),
  async (req, res) => {
    // your business logic
    const orderId = "ord_" + Math.random().toString(36).slice(2);
    res.setHeader("Location", `/orders/${orderId}`);
    res.status(201).json({ orderId });
  }
);

app.listen(3000);
```

**Client header:**

```
Idempotency-Key: <uuid-v4>
```

---

## Examples / Usage

This repo ships with runnable examples under `examples/`. The quickest way to try the middleware is the **basic Express server**.

### Run the example (from this repo)

```bash
npm i
npm run build
node dist/examples/server-basic.js
# Server: http://localhost:3000
```

### 1) First request (create)

```bash
curl -i -X POST http://localhost:3000/payments   -H "Content-Type: application/json"   -H "Idempotency-Key: key-123"   -d '{"amount":100}'
```

**Expected:**

- `HTTP/1.1 201 Created`
- `Idempotency-Status: created`
- Body: `{"orderId":"..."}`

### 2) Replay — same key & same payload

```bash
curl -i -X POST http://localhost:3000/payments   -H "Content-Type: application/json"   -H "Idempotency-Key: key-123"   -d '{"amount":100}'
```

**Expected:**

- `HTTP/1.1 201 Created` (same status as the first response)
- `Idempotency-Status: cached`
- `Idempotency-Replayed: true`
- `Content-Type: application/json; charset=utf-8`
- Body: **identical** to the first response (same `orderId`)

### 3) Conflict — same key, different payload

```bash
curl -i -X POST http://localhost:3000/payments   -H "Content-Type: application/json"   -H "Idempotency-Key: key-123"   -d '{"amount":200}'
```

**Expected:**

- `HTTP/1.1 409 Conflict`
- `Idempotency-Status: conflict`

### 4) In-flight duplicates (concurrency)

The example route simulates ~300 ms of work and uses `inFlight: { strategy: "wait", waitTimeoutMs: 3000 }`.
Open two terminals and run the same request with the same key as fast as possible.
The second request will **wait** and return the cached result:

- `Idempotency-Status: cached`
- `Idempotency-Replayed: true`

---

## API

```ts
import type { RequestHandler, Request } from "express";

function idempotencyMiddleware(options: IdemOptions): RequestHandler;

export type IdemOptions = {
  store: Store;
  ttlMs?: number;                // default 24h
  methods?: string[];            // default ["POST"]
  keyHeader?: string;            // default "Idempotency-Key"
  requireKey?: boolean;          // default false (400 if true and missing)
  inFlight?: {                   // default {strategy: "reject"}
    strategy: "wait" | "reject";
    waitTimeoutMs?: number;      // default 5000
    pollMs?: number;             // default 100
  };
  fingerprint?: {
    includeQuery?: boolean;      // default false
    maxBodyBytes?: number;       // default 64KB; larger bodies return 413
    custom?: (req: Request) => string | undefined; // e.g., tenant/user id
  };
  replay?: {
    headerWhitelist?: string[];  // lowercase names, e.g., ["location"]
  };
};
```

`maxBodyBytes` limits the UTF-8 byte length of the canonical body used for the fingerprint. JSON object keys are sorted, while string values and array order are preserved. Raw `Buffer` bodies are hashed as bytes. Object and array bodies must contain plain JSON data; unsupported JavaScript objects are passed to the Express error handler. If your parser accepts bodies above 64 KB, set `maxBodyBytes` high enough for them, or they will receive `413` and the key will remain unused. Keep a request body parser before this middleware so `req.body` contains the payload that your handler uses.

### Store Interface

```ts
export type CachedResponse = {
  status: number;
  body: string | Buffer;
  headers: Record<string, string | string[]>;
  fingerprint: string;
  createdAt: number;
};

export interface Store {
  begin(key: string, fp: string, ttlMs: number): Promise<
    | { kind: "started"; reservationId?: string }
    | { kind: "replay"; cached: CachedResponse }
    | { kind: "conflict" }
    | { kind: "inflight" }
  >;
  commit(key: string, data: CachedResponse, reservationId?: string): Promise<void>;
  get(key: string): Promise<CachedResponse | null>;
  abort?(key: string, fp?: string, reservationId?: string): Promise<void>;
}
```

`begin` must atomically claim a key. If it returns a `reservationId`, `commit` and `abort` receive that ID so an expired request cannot modify a newer reservation. The built-in `MemoryStore` uses this safeguard. Custom stores should implement the same compare-and-set behavior and preserve the TTL. Set the TTL longer than the maximum handler duration; an expired in-flight reservation can allow a second execution.

---

## Behavior & Headers

- Adds response headers:
  - `Idempotency-Key`: echoes the key
  - `Idempotency-Status`: `created | cached | conflict | inflight | inflight-timeout | missing-key | too-large | unparsed-body`
  - `Idempotency-Replayed`: `true | false`
  - On in-flight timeout or reject: `Retry-After: 1`
- **Replay headers**: only those in `replay.headerWhitelist` are replayed, plus `content-type` is always replayed.
  Authentication, cookie, hop-by-hop, and `content-encoding` headers are **never** replayed, even if whitelisted.

### Upgrading from 1.0.x

Version 2 changes the fingerprint format to cover complete, unambiguous payloads. Existing entries in a persistent store have the old fingerprint and will return `409 Conflict` for the same key until their TTL expires. Keep old entries until they expire; deleting them early can allow duplicate operations. During rollout, route all instances sharing a store to the same major version so they agree on fingerprints. For a deployment without migration conflicts, stop new writes on 1.0.x, wait at least the longest active TTL and for in-flight handlers to finish, then switch all instances to version 2.

Requests with canonical bodies above `maxBodyBytes` now receive `413` instead of being hashed only in part. Requests with a nonempty body that has not been parsed before this middleware receive `400`. Configurations with invalid TTL, wait settings, body limit, or key header now fail at startup. The Express peer range begins at 4.22.3 or 5.1.0. Custom `Store` implementations with the former two-argument `commit` and `abort` signatures remain type-compatible; version 2 may pass an optional reservation ID as an additional argument. Custom stores should check that ID before modifying an in-flight entry.

---

## Using Redis / Postgres (examples)

`Redis` and `Postgres` files under `examples/` are **nonfunctional sketches**, not production stores. Their methods throw until implemented. Both stores need an atomic claim, state and fingerprint checks, TTL preservation, and reservation ID checks for commit and abort.

**Redis:** claim the key atomically with `SET ... NX PX` or a Lua script. Use compare-and-set logic that checks both the fingerprint and the reservation ID before changing an in-flight entry to done or deleting it.

**Typical approach (Postgres sketch):**
```sql
-- One possible schema (sketch)
CREATE TABLE idem_keys (
  key text PRIMARY KEY,
  fp text NOT NULL,
  state text NOT NULL CHECK (state IN ('inflight','done')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expiry timestamptz NOT NULL,
  status int,
  headers jsonb,
  body bytea
);
CREATE INDEX ON idem_keys (expiry);
```
```ts
// Use INSERT ... ON CONFLICT to claim/update atomically inside a transaction.
// Restrict commit/abort to the matching reservation ID.
```

> Keep TTL moderate (hours). Store only safe headers. Avoid caching 5xx responses.

---

## Best Practices

- Generate the key **client-side** (UUID v4) per unsafe request
- Include every input that affects the operation in the fingerprint. By default query parameters and request headers are excluded; use `includeQuery: true` and `custom` when they matter.
- Use a **centralized store** (Redis/PG) in production; MemoryStore is for dev/tests
- Whitelist only **safe headers** to replay (e.g., `location`); `content-type` is always replayed
- Keep TTL short (hours, not days). Consider background cleanup for SQL stores
- For webhooks, prefer provider event IDs (e.g., Stripe `event.id`) as the idempotency key

---

## Limitations

- Not designed for streaming responses or long-running jobs
  For multi-minute operations, prefer queues/outbox + status resources
- MemoryStore is single-process only and volatile; use Redis/PG in production

---

## Troubleshooting

- **`ERR_MODULE_NOT_FOUND` after build**
  Ensure compiled imports include explicit `.js` extensions and your `package.json` `exports` point to `./dist/src/index.js`.

- **Second request shows `created` instead of `cached`**
  Check that both requests use the same store instance and the first response completed before the retry. A reservation that expires during a long handler can also allow a new execution; increase `ttlMs` or use a job/status workflow.

- **`r2.body` is `{}` or a JSON string in tests**
  Make sure `Content-Type: application/json` is set and that replay includes `content-type` (the middleware always replays it by default).

---

## Development (this repo)

Development tools require Node 22.12 or newer; the published middleware supports Node 18 or newer.

```bash
npm i
npm run build
npm test
# Example server (after build):
node dist/examples/server-basic.js
```

---

## License

MIT
