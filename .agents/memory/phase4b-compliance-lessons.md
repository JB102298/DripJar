---
name: Phase 4B compliance lessons
description: Lessons from finalizing the Phase 4B webhook concurrency stress test (real Stripe signatures, 20-concurrent, ledger assertions, full-suite stability)
---

## Real Stripe signature verification in tests
- **Rule:** Send the webhook payload as a plain JSON **string**, not a `Buffer`, in supertest.
- **Why:** supertest with `Content-Type: application/json` and `.send(Buffer)` JSON-serializes the Buffer object (producing `{"type":"Buffer","data":[...]}` garbage). Sending the string directly lets `express.raw()` capture the exact bytes needed for signature verification.
- **How to apply:** `sendWebhookWithRealSig` helper in phase4b test — `.send(JSON.stringify(event))` (string), not `.send(Buffer.from(...))`.

## Stripe SDK secret handling
- `stripe.webhooks.constructEvent` (Stripe v22, NodeCryptoProvider) uses the secret string **as-is** — no base64-decoding, no `whsec_` prefix stripping.
- Safe to use `'whsec_test_...'` strings as HMAC keys in both the test HMAC generation and the SDK verification — they match.

## singleFork full-suite connection starvation
- **Rule:** Add a `waitForPoolConnections(minIdle, maxWaitMs)` call at the start of `beforeAll` in any stress test that sends N-concurrent DB-heavy requests.
- **Why:** With `singleFork:true`, all test files share one process and one pg pool. An earlier test file that times out (e.g. phase3-automation at 30s) can leave in-flight Express handlers holding pool connections beyond the failed test. When a subsequent stress test (phase4b Scenario A) immediately sends 20 concurrent requests, those connections aren't available and the test hangs.
- **How to apply:** Poll `pool.idleCount >= minIdle` every 500ms up to `maxWaitMs` (20s). Place call before test-data setup in `beforeAll`.

## pdfkit in pnpm workspaces
- The workspace root's `scripts/` directory has `"type": "module"` in its package.json.
- pdfkit is CommonJS; scripts that `require()` it must use `.cjs` extension to override the ESM default.
- pdfkit is available at: `node_modules/.pnpm/pdfkit@0.19.1/node_modules/pdfkit/js/pdfkit.standalone.js`
