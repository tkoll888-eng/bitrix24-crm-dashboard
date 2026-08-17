# Bitrix24 Placement Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing CRM dashboard use the authenticated Bitrix24 placement user and redeploy it to the existing Vibe server.

**Architecture:** A focused `auth.js` module resolves either Gateway placement auth or an explicitly enabled local personal-key fallback. `server.js` forwards the resolved headers to Vibe API and scopes every cache by a one-way identity hash. The existing standalone server is redeployed without the personal key.

**Tech Stack:** Node.js 20+ ESM, built-in `node:test`, built-in HTTP/fetch/crypto APIs, Vibe REST deployment API.

## Global Constraints

- Production uses `BITRIX_APP_KEY` plus Gateway-injected `X-Vibe-Authorization`.
- `BITRIX_API_KEY` is local-only and requires `BITRIX_ALLOW_PERSONAL_FALLBACK=true`.
- Secrets and session tokens are never logged, returned, cached verbatim, archived, or deployed unnecessarily.
- Every cache holding CRM-derived data is scoped per resolved authentication context.
- CRM operations remain read-only and existing KPI/filter semantics do not change.
- No external npm dependencies are added.
- Reuse standalone server `d9bd453f-6b4f-4397-a440-11a84b836da2`; do not create another server.

---

### Task 1: Authentication context

**Files:**
- Create: `test/auth.test.js`
- Create: `auth.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `resolvePortalAuth({ gatewayAuthorization, appKey, personalKey, allowPersonalFallback })`.
- Produces: `portalHeaders(auth, hasBody)` and `scopedCacheKey(auth, key)`.

- [ ] **Step 1: Write failing tests**

Test placement precedence, outbound `Authorization`, explicit fallback, missing-auth errors, distinct session scopes, and absence of raw secrets in scopes.

```js
test("uses app key and Gateway bearer for placement requests", () => {
  const auth = resolvePortalAuth({
    gatewayAuthorization: "Bearer vibe_session_alice",
    appKey: "vibe_app_local_test",
    personalKey: "vibe_api_owner",
    allowPersonalFallback: true,
  });
  assert.equal(auth.mode, "placement");
  assert.equal(portalHeaders(auth, false).Authorization, "Bearer vibe_session_alice");
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/auth.test.js`

Expected: FAIL because `auth.js` does not exist.

- [ ] **Step 3: Implement minimal auth module**

Use `createHash("sha256")` for opaque scopes. Accept only non-empty `Bearer ...` Gateway headers. Throw errors with status `401` for missing placement auth and `503` when no usable credentials are configured.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/auth.test.js`

Expected: all tests pass.

- [ ] **Step 5: Add test script**

Set `package.json` script `test` to `node --test`.

### Task 2: Per-request API auth and cache isolation

**Files:**
- Modify: `server.js`
- Create: `test/server-auth.test.js`

**Interfaces:**
- Consumes: auth helpers from Task 1.
- Produces: `portal(auth, path, options)`, scoped stage/user/data caches, placement-aware `/api/meta`.

- [ ] **Step 1: Write failing HTTP integration tests**

Start a real local mock Vibe HTTP server and the dashboard as a child process. Assert that a placement request forwards `X-Api-Key: <app key>` and `Authorization: Bearer <session>`, a request without the Gateway header returns 401 without touching upstream, two requests from one session reuse cached data, a second session causes a separate upstream call, and user-name caches do not cross sessions.

- [ ] **Step 2: Verify RED**

Run: `node --test test/server-auth.test.js`

Expected: FAIL on missing app-key/session wiring.

- [ ] **Step 3: Wire authentication**

Import auth helpers; add `APP_KEY` and explicit fallback configuration. Resolve auth once per request handler. Forward `X-Api-Key` and optional `Authorization` through `portal()`.

- [ ] **Step 4: Isolate caches**

Prefix `cached()` keys with `scopedCacheKey(auth, key)`. Pass auth into stage lookup. Replace the single user cache with `Map<scope, {at,map}>`, and return the user map to `handleRecent`.

- [ ] **Step 5: Improve meta/error behavior**

Return `{ connected, configured, authMode, domain }`. Without a Gateway session in production, return an unauthenticated state instead of using owner CRM data.

- [ ] **Step 6: Verify GREEN**

Run: `node --test`

Expected: all tests pass.

### Task 3: Runtime presentation and documentation

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Create: `public/app-icon.svg`
- Modify: `README.md`

**Interfaces:**
- Consumes: `/api/meta` authentication fields.
- Produces: placement-specific disconnected guidance and platform favicon.

- [ ] **Step 1: Write failing static checks**

Extend `test/server-auth.test.js` to require `/_gw/icon`, placement guidance, and documentation of both keys.

- [ ] **Step 2: Verify RED**

Run: `node --test test/server-auth.test.js`

Expected: FAIL on missing runtime/documentation markers.

- [ ] **Step 3: Update UI and assets**

Add `<link rel="icon" href="/_gw/icon">`, a safe SVG icon, and UI copy instructing users to open the dashboard from Bitrix24 when no placement session is present.

- [ ] **Step 4: Update README**

Document the two-key local setup, production app-key-only setup, Gateway header flow, cache isolation, and redeploy procedure without secret values.

- [ ] **Step 5: Verify GREEN and syntax**

Run: `node --test && node --check server.js && node --check public/app.js`

Expected: tests and syntax checks pass.

### Task 4: Local integration verification

**Files:**
- Modify: `.env` (add only non-secret `BITRIX_ALLOW_PERSONAL_FALLBACK=true` locally)

- [ ] **Step 1: Start on an unused local port**

Run server with the current local env and a temporary `PORT`.

- [ ] **Step 2: Exercise API endpoints**

Verify `/api/meta`, `/api/deals/kpi`, `/api/deals/pipeline`, and `/api/deals/recent`. Confirm `authMode=personal`, all statuses are 200, aggregates are not truncated, stages resolve, and the existing personal key's missing `user` scope remains a local-only limitation.

- [ ] **Step 3: Verify secure production mode**

Start with only app-key/base/domain and no Gateway header. Confirm `/api/meta` reports unauthenticated and data endpoints do not return CRM data.

### Task 5: Redeploy existing standalone server

**Files:**
- Package runtime files into a temporary `.tar.gz`; exclude `.env`, `.opencode`, `docs`, `test`, debug files, and logs.

- [ ] **Step 1: Read fresh server/deploy contract**

Call `/me` and `/infra/servers/d9bd453f-6b4f-4397-a440-11a84b836da2`; confirm `kind=STANDALONE`, `status=running`, and `blackholeStatus=CONNECTED` before replacement.

- [ ] **Step 2: Build and inspect archive**

Archive only `package.json`, `server.js`, `auth.js`, and `public/`. List members and scan for `.env`, `vibe_api_`, or `vibe_app_`; expected zero secret matches.

- [ ] **Step 3: Deploy**

POST to `/infra/servers/:id/deploy` with source content, `runtime=node20`, `start=node server.js`, display name `Дашборд`, a CRM analytics description, port `3000`, and env containing only `BITRIX_APP_KEY`, `BITRIX_API_BASE_URL`, and `BITRIX_PORTAL_DOMAIN`.

- [ ] **Step 4: Upload icon**

POST `public/app-icon.svg` as multipart field `file` to `/infra/servers/:id/icon`.

- [ ] **Step 5: Poll and verify**

Poll server state until `running` and `CONNECTED`. Check access policy remains `AUTHENTICATED`, placement `LEFT_MENU` remains registered, inspect deploy warnings/logs, and smoke-test the app URL through a temporary platform access token where supported.

- [ ] **Step 6: Final evidence**

Re-run the complete local tests, verify the deployed root and static assets respond, and report any remaining requirement that can only be confirmed by opening `LEFT_MENU` as a real portal user.
