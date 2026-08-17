import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function unusedPort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

function startMockVibe() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const authorization = req.headers.authorization || "";
    calls.push({ path: req.url, headers: req.headers, body });
    if (authorization === "Bearer session-upstream-error" && req.url === "/deals/aggregate") {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: '<img src=x onerror="attack()">' } }));
      return;
    }
    const payload = (() => {
      if (req.url === "/deals/aggregate") return { data: { groups: [] } };
      if (req.url === "/deal-categories") return { data: [] };
      if (req.url === "/statuses/search") return { data: [] };
      if (req.url === "/deals/search") {
        return { data: [{ id: 1, title: "Deal", amount: 10, stageId: "NEW", assignedById: 7 }] };
      }
      if (req.url === "/users/search") {
        const session = authorization.replace(/^Bearer /, "");
        return { data: [{ id: 7, name: `User ${session}`, lastName: "" }] };
      }
      return { data: [] };
    })();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  return { server, calls };
}

async function startDashboard(baseUrl) {
  const port = await unusedPort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      BITRIX_API_BASE_URL: baseUrl,
      BITRIX_APP_KEY: "test-app-key",
      BITRIX_ALLOW_PERSONAL_FALLBACK: "false",
      BITRIX_API_KEY: "",
      BITRIX_PORTAL_DOMAIN: "portal.example.test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Dashboard exited early: ${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/meta`);
      if (response.ok) return { child, baseUrl: `http://127.0.0.1:${port}` };
    } catch {
      // The child is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.kill();
  throw new Error(`Dashboard did not start: ${output}`);
}

async function stopDashboard(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await once(child, "exit");
}

async function request(baseUrl, pathname, { authorization, body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: body ? "POST" : "GET",
    headers: {
      ...(authorization ? { "X-Vibe-Authorization": authorization } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json() };
}

test("server resolves placement auth per request and isolates auth-scoped caches", async (t) => {
  const mock = startMockVibe();
  const upstreamPort = await listen(mock.server);
  const dashboard = await startDashboard(`http://127.0.0.1:${upstreamPort}`);
  t.after(async () => {
    await stopDashboard(dashboard.child);
    await close(mock.server);
  });

  const alice = "Bearer session-alice";
  const bob = "Bearer session-bob";

  await t.test("returns placement and unauthenticated meta shapes", async () => {
    const placement = await request(dashboard.baseUrl, "/api/meta", { authorization: alice });
    assert.deepEqual(placement, {
      status: 200,
      json: { connected: true, configured: true, authMode: "placement", domain: "portal.example.test" },
    });

    const unauthenticated = await request(dashboard.baseUrl, "/api/meta");
    assert.deepEqual(unauthenticated, {
      status: 200,
      json: { connected: false, configured: true, authMode: null, domain: "portal.example.test" },
    });
  });

  await t.test("forwards app and Gateway headers to the Vibe upstream", async () => {
    const result = await request(dashboard.baseUrl, "/api/deals/pipeline", { authorization: alice, body: {} });
    assert.equal(result.status, 200);
    const aggregate = mock.calls.find((call) => call.path === "/deals/aggregate");
    assert.equal(aggregate.headers["x-api-key"], "test-app-key");
    assert.equal(aggregate.headers.authorization, alice);
  });

  await t.test("rejects missing Gateway auth before accessing the CRM upstream", async () => {
    const before = mock.calls.length;
    const result = await request(dashboard.baseUrl, "/api/deals/pipeline", { body: {} });
    assert.equal(result.status, 401);
    assert.equal(mock.calls.length, before);
  });

  await t.test("reuses a session cache without sharing it with another session", async () => {
    const cacheAlice = "Bearer session-cache-alice";
    const cacheBob = "Bearer session-cache-bob";
    const period = { from: "2099-01-01T00:00:00.000Z", to: "2099-01-02T00:00:00.000Z" };
    const count = (pathname) => mock.calls.filter((call) => call.path === pathname).length;
    const before = {
      aggregate: count("/deals/aggregate"),
      categories: count("/deal-categories"),
      statuses: count("/statuses/search"),
    };

    assert.equal((await request(dashboard.baseUrl, "/api/deals/pipeline", { authorization: cacheAlice, body: period })).status, 200);
    assert.deepEqual({
      aggregate: count("/deals/aggregate") - before.aggregate,
      categories: count("/deal-categories") - before.categories,
      statuses: count("/statuses/search") - before.statuses,
    }, { aggregate: 1, categories: 1, statuses: 1 });

    assert.equal((await request(dashboard.baseUrl, "/api/deals/pipeline", { authorization: cacheAlice, body: period })).status, 200);
    assert.deepEqual({
      aggregate: count("/deals/aggregate") - before.aggregate,
      categories: count("/deal-categories") - before.categories,
      statuses: count("/statuses/search") - before.statuses,
    }, { aggregate: 1, categories: 1, statuses: 1 });

    assert.equal((await request(dashboard.baseUrl, "/api/deals/pipeline", { authorization: cacheBob, body: period })).status, 200);
    assert.deepEqual({
      aggregate: count("/deals/aggregate") - before.aggregate,
      categories: count("/deal-categories") - before.categories,
      statuses: count("/statuses/search") - before.statuses,
    }, { aggregate: 2, categories: 2, statuses: 2 });
  });

  await t.test("keeps user-name caches isolated by Gateway session", async () => {
    const userAlice = "Bearer session-user-alice";
    const userBob = "Bearer session-user-bob";
    const period = { from: "2099-02-01T00:00:00.000Z", to: "2099-02-02T00:00:00.000Z" };
    const count = (pathname) => mock.calls.filter((call) => call.path === pathname).length;
    const before = {
      deals: count("/deals/search"),
      categories: count("/deal-categories"),
      statuses: count("/statuses/search"),
      users: count("/users/search"),
    };
    const aliceRecent = await request(dashboard.baseUrl, "/api/deals/recent", { authorization: userAlice, body: period });
    const aliceCached = await request(dashboard.baseUrl, "/api/deals/recent", { authorization: userAlice, body: period });
    assert.equal(aliceRecent.json.rows[0].assignedName, "User session-user-alice");
    assert.equal(aliceCached.json.rows[0].assignedName, "User session-user-alice");
    assert.deepEqual({
      deals: count("/deals/search") - before.deals,
      categories: count("/deal-categories") - before.categories,
      statuses: count("/statuses/search") - before.statuses,
      users: count("/users/search") - before.users,
    }, { deals: 1, categories: 1, statuses: 1, users: 1 });

    const bobRecent = await request(dashboard.baseUrl, "/api/deals/recent", { authorization: userBob, body: period });
    assert.equal(bobRecent.json.rows[0].assignedName, "User session-user-bob");
    assert.deepEqual({
      deals: count("/deals/search") - before.deals,
      categories: count("/deal-categories") - before.categories,
      statuses: count("/statuses/search") - before.statuses,
      users: count("/users/search") - before.users,
    }, { deals: 2, categories: 2, statuses: 2, users: 2 });
  });

  await t.test("does not reflect upstream error text in API responses", async () => {
    const result = await request(dashboard.baseUrl, "/api/deals/pipeline", {
      authorization: "Bearer session-upstream-error",
      body: { from: "2099-03-01T00:00:00.000Z", to: "2099-03-02T00:00:00.000Z" },
    });
    assert.equal(result.status, 502);
    assert.equal(result.json.error, "Portal request failed (HTTP 502)");
  });
});
