import { createHash } from "node:crypto";

function hasValue(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isGatewayBearer(value) {
  return typeof value === "string" && /^Bearer [A-Za-z0-9\-._~+/]+={0,}$/.test(value);
}

function authError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function cacheScope(secret) {
  return createHash("sha256").update(secret).digest("hex");
}

export function resolvePortalAuth({
  gatewayAuthorization,
  appKey,
  personalKey,
  allowPersonalFallback,
} = {}) {
  const hasGatewayAuthorization = hasValue(gatewayAuthorization);
  if (hasGatewayAuthorization && !isGatewayBearer(gatewayAuthorization)) {
    throw authError("Open the application from Bitrix24", 401);
  }

  if (hasGatewayAuthorization && !hasValue(appKey)) {
    throw authError("Portal application credentials are not configured", 503);
  }

  if (hasGatewayAuthorization) {
    return {
      mode: "placement",
      apiKey: appKey,
      authorization: gatewayAuthorization,
      cacheScope: cacheScope(gatewayAuthorization),
    };
  }

  if (allowPersonalFallback === true && hasValue(personalKey)) {
    return {
      mode: "personal",
      apiKey: personalKey,
      cacheScope: cacheScope(personalKey),
    };
  }

  if (!hasValue(appKey) && !hasValue(personalKey)) {
    throw authError("Portal credentials are not configured", 503);
  }

  throw authError("Open the application from Bitrix24", 401);
}

export function portalHeaders(auth, hasBody) {
  return {
    "X-Api-Key": auth.apiKey,
    ...(auth.authorization ? { Authorization: auth.authorization } : {}),
    Accept: "application/json",
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
  };
}

export function scopedCacheKey(auth, key) {
  return `${auth.cacheScope}:${key}`;
}
