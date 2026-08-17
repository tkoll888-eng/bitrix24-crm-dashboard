import http from "node:http";
import { readFile, readFileSync } from "node:fs";
import path from "node:path";
import { portalHeaders, resolvePortalAuth, scopedCacheKey } from "./auth.js";
import { BoundedTtlCache } from "./bounded-cache.js";
import { listenerHost } from "./server-network.js";

// ---------------------------------------------------------------------------
// Загрузка .env (только локально). На деплоенном сервере .env нет — три
// управляемые переменные уже приходят через process.env, этот блок no-op.
// process.loadEnvFile никогда не перезаписывает уже установленные переменные.
// ---------------------------------------------------------------------------
try {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile();
  } else {
    const text = readFileSync(path.join(process.cwd(), ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  }
} catch {
  // Нет .env на диске (сервер) — переменные уже в process.env.
}

const PORT = process.env.PORT || 3000;
const BASE = process.env.BITRIX_API_BASE_URL || "";
const KEY = process.env.BITRIX_API_KEY || "";
const APP_KEY = process.env.BITRIX_APP_KEY || "";
const ALLOW_PERSONAL_FALLBACK = process.env.BITRIX_ALLOW_PERSONAL_FALLBACK === "true";
const DOMAIN = process.env.BITRIX_PORTAL_DOMAIN || "";
const PUBLIC_DIR = path.join(process.cwd(), "public");

// ----------------------------- portal access -----------------------------
async function portal(auth, p, { method = "GET", body } = {}) {
  if (!BASE) {
    const err = new Error("Портал не подключён");
    err.status = 503;
    throw err;
  }
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: portalHeaders(auth, Boolean(body)),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error(`Portal request failed (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
  // data.data — массив или объект payload; иначе сам ответ.
  return data?.data ?? data;
}

// Простой TTL-кэш: портал рейт-лимитит по ключу, тот же ключ обслуживает и
// Коворк/Код этого пользователя. Циклы опроса деградируют весь воркспейс.
const cache = new BoundedTtlCache({ maxEntries: 512 });
async function cached(key, ttlMs, produce) {
  return cache.getOrCreate(key, ttlMs, produce);
}

// ------------------------------ helpers ---------------------------------
function iso(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  return d; // строка
}

// Период по умолчанию: last 90 days, как разумный дефолт для дашборда.
function defaultFrom() {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return d.toISOString();
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function fail(res, err) {
  const status = err.status || 500;
  sendJson(res, status, { error: err.message || "Внутренняя ошибка" });
}

// Сумма по группе агрегата лежит в g.aggregates.amount.sum (для count —
// g.count). Нормализуем сумму из разной формы ответа.
function groupSum(g) {
  const v = g?.aggregates?.amount?.sum;
  if (v !== undefined && v !== null) return Number(v) || 0;
  return Number(g?.amount) || 0;
}

// ------------------------- data: stages catalogue ------------------------
// Получает справочник стадий основной воронки и (бест-эффект) воронок.
async function fetchStageCatalogue(auth) {
  // Основная воронка = DEAL_STAGE, дополнительные = DEAL_STAGE_<categoryId>.
  const byCode = new Map();
  let categories = [];
  try {
    categories = await portal(auth, "/deal-categories", { params: { limit: 50 } });
  } catch {
    categories = [];
  }
  if (!Array.isArray(categories)) categories = [];

  // Основная воронка (categoryId 0)
  try {
    const st = await portal(auth, "/statuses/search", {
      method: "POST",
      body: { filter: { entityId: "DEAL_STAGE" }, limit: 500 },
    });
    if (Array.isArray(st)) {
      for (const s of st) {
        byCode.set(s.statusId, {
          id: s.statusId,
          name: s.name || s.statusId,
          sort: s.sort,
          semantics: s.semantics || "",
          categoryId: 0,
          categoryName: "Основная воронка",
        });
      }
    }
  } catch {
    // игнорируем — падаем на доступные
  }

  // Дополнительные воронки, если они есть (не критично для базовой сводки).
  for (const cat of categories) {
    if (String(cat.id) === "0") continue;
    try {
      const st = await portal(auth, "/statuses/search", {
        method: "POST",
        body: { filter: { entityId: `DEAL_STAGE_${cat.id}` }, limit: 500 },
      });
      if (Array.isArray(st)) {
        for (const s of st) {
          byCode.set(`${s.statusId}`, {
            id: s.statusId,
            name: s.name || s.statusId,
            sort: s.sort,
            semantics: s.semantics || "",
            categoryId: cat.id,
            categoryName: cat.name || `Воронка ${cat.id}`,
          });
        }
      }
    } catch {
      // ignore
    }
  }
  return { byCode, categories };
}

// --------------------------- /api/meta -----------------------------------
async function handleMeta(req, res) {
  let auth = null;
  try {
    auth = resolveRequestAuth(req);
  } catch {
    // Meta remains available outside a placement so the UI can describe its state.
  }
  sendJson(res, 200, {
    connected: Boolean(auth && BASE),
    configured: Boolean(BASE && (APP_KEY || (ALLOW_PERSONAL_FALLBACK && KEY))),
    authMode: auth?.mode || null,
    domain: DOMAIN,
  });
}

// ------------------------ /api/deals/pipeline ----------------------------
// Сводка по стадиям: количество сделок и сумма по каждой стадии за период.
// Использует серверный aggregate + справочник стадий.
async function handlePipeline(req, res, auth) {
  let query = {};
  try {
    const raw = await readBody(req);
    query = JSON.parse(raw || "{}");
  } catch {
    query = {};
  }
  const { from, to } = parsePeriod(query);

  const filter = {};
  if (from) filter.createdAt = { ...(filter.createdAt || {}), $gte: from };
  if (to) filter.createdAt = { ...(filter.createdAt || {}), $lte: to };

  try {
    const [agg, cat] = await Promise.all([
      cached(scopedCacheKey(auth, `deals-pipeline-${from}-${to}`), 60_000, () =>
        portal(auth, "/deals/aggregate", {
          method: "POST",
          body: {
            aggregate: [
              { field: "amount", function: "sum" },
              { field: "*", function: "count" },
            ],
            groupBy: "stageId",
            filter,
          },
        }),
      ),
      cached(scopedCacheKey(auth, "stage-catalogue"), 300_000, () => fetchStageCatalogue(auth)),
    ]);

    const groups = Array.isArray(agg?.groups) ? agg.groups : [];
    const rows = groups
      .map((g) => {
        const rawId = String(g.stageId ?? g.groupKey ?? g.id ?? "");
        const bareId = rawId.split(":").pop();
        const stage = cat.byCode.get(rawId) || cat.byCode.get(bareId);
        let name = stage?.name || stage?.name || "";
        // суффикс-код наподобие C2:NEW приводим к осмысленному виду
        if (!name) {
          name = cat.byCode.get(bareId)?.name || bareId || rawId;
        }
        return {
          stageId: rawId,
          name,
          sort: stage?.sort ?? 0,
          semantics: stage?.semantics ?? "",
          categoryName: stage?.categoryName ?? "",
          count: Number(g.count ?? 0),
          amount: groupSum(g),
        };
      })
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || String(a.name).localeCompare(String(b.name)));

    sendJson(res, 200, {
      rows,
      truncated: Boolean(agg?.meta?.truncated),
      recordsProcessed: agg?.meta?.recordsProcessed,
      total: agg?.count,
    });
  } catch (err) {
    fail(res, err);
  }
}

// ----------------------------- /api/deals/kpi ----------------------------
// Ключевые показатели: сумма открытых сделок, кол-во выигранных за период,
// средний чек (по выигранным за период).
async function handleKpi(req, res, auth) {
  let query = {};
  try {
    query = JSON.parse((await readBody(req)) || "{}");
  } catch {
    query = {};
  }
  const { from, to } = parsePeriod(query);

  try {
    // 1) Сумма всех открытых (в работе) сделок портала.
    //    groupBy должен быть реальным полем (для сделок это stageId и т.п.),
    //    агрегируем по стадиям, затем суммируем группы на сервере.
    const openAgg = await cached(scopedCacheKey(auth, "deals-open-sum"), 60_000, async () => {
      const r = await portal(auth, "/deals/aggregate", {
        method: "POST",
        body: {
          aggregate: [
            { field: "amount", function: "sum" },
            { field: "*", function: "count" },
          ],
          groupBy: "stageId",
          filter: { stageSemanticId: "P" },
        },
      });
      return r;
    });
    const openGroups = Array.isArray(openAgg?.groups) ? openAgg.groups : [];
    const openSum = openGroups.reduce((s, g) => s + groupSum(g), 0);
    const openCount = openGroups.reduce((s, g) => s + Number(g.count || 0), 0);
    const openTruncated = Boolean(openAgg?.meta?.truncated);

    // 2) Выигранные сделки за период (по дате ЗАКРЫТИЯ, семантика S).
    const wonFilter = { stageSemanticId: "S" };
    if (from) wonFilter.closeDate = { ...(wonFilter.closeDate||{}), $gte: from };
    if (to) wonFilter.closeDate = { ...(wonFilter.closeDate||{}), $lte: to };

    const wonAgg = await portal(auth, "/deals/aggregate", {
      method: "POST",
      body: {
        aggregate: [
          { field: "amount", function: "sum" },
          { field: "*", function: "count" },
        ],
        groupBy: "stageId",
        filter: wonFilter,
      },
    });
    const wonGroups = Array.isArray(wonAgg?.groups) ? wonAgg.groups : [];
    const wonAmount = wonGroups.reduce((s, g) => s + groupSum(g), 0);
    const wonCount = wonGroups.reduce((s, g) => s + Number(g.count || 0), 0);
    const avgCheck = wonCount > 0 ? Math.round((wonAmount / wonCount) * 100) / 100 : 0;

    sendJson(res, 200, {
      openSum,
      openCount,
      openTruncated,
      wonAmount,
      wonCount,
      avgCheck,
      period: { from, to },
      truncated: Boolean(openTruncated || wonAgg?.meta?.truncated),
    });
  } catch (err) {
    fail(res, err);
  }
}

// ---------------------------- /api/deals/recent --------------------------
// Последние 10-20 сделок за период с названием, суммой, стадией, ответственным.
async function handleRecent(req, res, auth) {
  let query = {};
  try {
    query = JSON.parse((await readBody(req)) || "{}");
  } catch {
    query = {};
  }
  const { from, to } = parsePeriod(query);
  const limit = Math.min(20, Math.max(1, Number(query.limit) || 15));

  const filter = {};
  if (from) filter.createdAt = { ...(filter.createdAt||{}), $gte: from };
  if (to) filter.createdAt = { ...(filter.createdAt||{}), $lte: to };

  try {
    const [deals, cat] = await Promise.all([
      cached(scopedCacheKey(auth, `deals-recent-${from}-${to}-${limit}`), 60_000, () =>
        portal(auth, "/deals/search", {
          method: "POST",
          body: {
            filter,
            sort: { id: "desc" },
            select: ["id", "title", "amount", "stageId", "assignedById", "currencyId", "createdAt", "closeDate"],
            limit,
          },
        }),
      ),
      cached(scopedCacheKey(auth, "stage-catalogue"), 300_000, () => fetchStageCatalogue(auth)),
    ]);

    // Прогружаем имена ответственных (кэш).
    const users = await fetchUsersByIds(auth);

    const rows = (Array.isArray(deals) ? deals : []).map((d) => {
      const stage = cat.byCode.get(String(d.stageId ?? ""));
      const userName = userNameOf(users, d.assignedById);
      return {
        id: d.id,
        title: d.title,
        amount: Number(d.amount ?? 0),
        currencyId: d.currencyId || "RUB",
        stageId: d.stageId,
        stageName: stage?.name || d.stageId || "—",
        assignedById: d.assignedById,
        assignedName: userName,
        createdAt: d.createdAt,
      };
    });

    sendJson(res, 200, { rows, total: Array.isArray(deals) ? deals.length : 0 });
  } catch (err) {
    fail(res, err);
  }
}

// --------------------------- /api/users ----------------------------------
// Справочник пользователей (ответственные) — кэшируем; читаем всех активных.
const USER_CACHES = new BoundedTtlCache({ maxEntries: 256 });
async function fetchUsersByIds(auth, ids) {
  const cacheKey = scopedCacheKey(auth, "users");
  try {
    return await USER_CACHES.getOrCreate(cacheKey, 300_000, async () => {
      const list = await portal(auth, "/users/search", {
        method: "POST",
        body: { filter: { active: true }, limit: 500 },
      });
      const users = new Map();
      if (Array.isArray(list)) {
        for (const u of list) {
          users.set(Number(u.id), `${u.name || ""} ${u.lastName || ""}`.trim());
        }
      }
      return users;
    });
  } catch {
    return new Map();
  }
}

function userNameOf(users, id) {
  if (id === null || id === undefined) return null;
  return users.get(Number(id)) || null;
}

// ----------------------------- read body --------------------------------
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

function parsePeriod(query) {
  let from = query?.from || null;
  let to = query?.to || null;
  return { from, to };
}

function resolveRequestAuth(req) {
  return resolvePortalAuth({
    gatewayAuthorization: req.headers["x-vibe-authorization"],
    appKey: APP_KEY,
    personalKey: KEY,
    allowPersonalFallback: ALLOW_PERSONAL_FALLBACK,
  });
}

// -------------------------------- server --------------------------------
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  const method = req.method;
  const p = url.pathname;

  if (p === "/api/meta" && method === "GET") return handleMeta(req, res);

  let auth;
  if (p === "/api/deals/pipeline" || p === "/api/deals/kpi" || p === "/api/deals/recent") {
    try {
      auth = resolveRequestAuth(req);
    } catch (err) {
      return fail(res, err);
    }
  }
  if (p === "/api/deals/pipeline" && (method === "POST" || method === "GET")) return handlePipeline(req, res, auth);
  if (p === "/api/deals/kpi" && (method === "POST" || method === "GET")) return handleKpi(req, res, auth);
  if (p === "/api/deals/recent" && (method === "POST" || method === "GET")) return handleRecent(req, res, auth);

  // Статика — только из public/.
  const rel = p === "/" ? "index.html" : p.slice(1);
  const isDotfile = rel.split("/").some((seg) => seg.startsWith("."));
  const filePath = path.resolve(PUBLIC_DIR, rel);
  const inside = filePath === PUBLIC_DIR || filePath.startsWith(PUBLIC_DIR + path.sep);
  if (isDotfile || !inside) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  readFile(filePath, (err, file) => {
    if (err) {
      res.writeHead(404).end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type =
      ext === ".html" ? "text/html; charset=utf-8"
      : ext === ".js" ? "text/javascript; charset=utf-8"
      : ext === ".css" ? "text/css; charset=utf-8"
      : ext === ".svg" ? "image/svg+xml"
      : "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(file);
  });
});

const LISTENER_HOST = listenerHost(ALLOW_PERSONAL_FALLBACK);
const onListening = () => console.log(`CRM dashboard listening on ${PORT}`);
if (LISTENER_HOST) server.listen(PORT, LISTENER_HOST, onListening);
else server.listen(PORT, onListening);
