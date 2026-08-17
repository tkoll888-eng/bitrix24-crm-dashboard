import assert from "node:assert/strict";
import test from "node:test";

import { portalHeaders, resolvePortalAuth, scopedCacheKey } from "../auth.js";

test("uses app key and Gateway bearer for placement requests", () => {
  const auth = resolvePortalAuth({
    gatewayAuthorization: "Bearer vibe_session_alice",
    appKey: "vibe_app_local_test",
    personalKey: "vibe_api_owner",
    allowPersonalFallback: true,
  });

  assert.equal(auth.mode, "placement");
  assert.deepEqual(portalHeaders(auth, false), {
    "X-Api-Key": "vibe_app_local_test",
    Authorization: "Bearer vibe_session_alice",
    Accept: "application/json",
  });
});

test("adds JSON content type only when the outbound request has a body", () => {
  const auth = resolvePortalAuth({
    gatewayAuthorization: "Bearer vibe_session_alice",
    appKey: "vibe_app_local_test",
  });

  assert.equal(portalHeaders(auth, true)["Content-Type"], "application/json");
  assert.equal(portalHeaders(auth, false)["Content-Type"], undefined);
});

test("uses a personal key only when personal fallback is explicitly enabled", () => {
  const input = {
    appKey: "vibe_app_local_test",
    personalKey: "vibe_api_owner",
  };

  assert.throws(
    () => resolvePortalAuth({ ...input, allowPersonalFallback: false }),
    (error) => error.status === 401,
  );

  const auth = resolvePortalAuth({ ...input, allowPersonalFallback: true });
  assert.equal(auth.mode, "personal");
  assert.deepEqual(portalHeaders(auth, false), {
    "X-Api-Key": "vibe_api_owner",
    Accept: "application/json",
  });
});

test("does not downgrade a malformed Gateway header to personal fallback", () => {
  for (const gatewayAuthorization of ["Basic attacker", "Bearer ", "not-a-bearer"]) {
    assert.throws(
      () => resolvePortalAuth({
        gatewayAuthorization,
        appKey: "vibe_app_local_test",
        personalKey: "vibe_api_owner",
        allowPersonalFallback: true,
      }),
      (error) => error.status === 401,
    );
  }
});

test("rejects malformed or empty Gateway authorization headers", () => {
  for (const gatewayAuthorization of ["", "Basic abc", "Bearer ", "Bearer"]) {
    assert.throws(
      () => resolvePortalAuth({ gatewayAuthorization, appKey: "vibe_app_local_test" }),
      (error) => error.status === 401,
    );
  }
});

test("rejects Gateway authorization headers containing control characters", () => {
  for (const gatewayAuthorization of ["Bearer\ntoken", "Bearer\r\ntoken"]) {
    assert.throws(
      () => resolvePortalAuth({ gatewayAuthorization, appKey: "vibe_app_local_test" }),
      (error) => error.status === 401,
    );
  }
});

test("reports missing placement auth and missing credentials separately", () => {
  assert.throws(
    () => resolvePortalAuth({ appKey: "vibe_app_local_test" }),
    (error) => error.status === 401,
  );
  assert.throws(
    () => resolvePortalAuth({}),
    (error) => error.status === 503,
  );
});

test("separates cache scopes for different Gateway sessions without exposing secrets", () => {
  const alice = resolvePortalAuth({
    gatewayAuthorization: "Bearer vibe_session_alice",
    appKey: "vibe_app_local_test",
  });
  const bob = resolvePortalAuth({
    gatewayAuthorization: "Bearer vibe_session_bob",
    appKey: "vibe_app_local_test",
  });
  const aliceKey = scopedCacheKey(alice, "deals-pipeline");
  const bobKey = scopedCacheKey(bob, "deals-pipeline");

  assert.notEqual(aliceKey, bobKey);
  assert.equal(aliceKey.includes("vibe_session_alice"), false);
  assert.equal(aliceKey.includes("vibe_app_local_test"), false);
  assert.equal(bobKey.includes("vibe_session_bob"), false);
  assert.equal(bobKey.includes("vibe_app_local_test"), false);
});
