import { renderErrorText } from "./render-safe.js";

"use strict";

const state = {
  view: "overview",
  period: "90",
  from: "",
  to: "",
  meta: { connected: false, configured: false, authMode: null, domain: "" },
};

const $ = (sel) => document.querySelector(sel);
const money = (n) =>
  new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(n || 0);
const moneyCompact = (n) => {
  const v = n || 0;
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1).replace(".0", "") + " млн ₽";
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(0) + " тыс ₽";
  return v.toFixed(0) + " ₽";
};
const shortDate = (s) => {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
};
// ------------------------------ period --------------------------------
function periodParams() {
  const p = {};
  if (state.period !== "all") {
    const from = new Date();
    from.setDate(from.getDate() - Number(state.period));
    p.from = from.toISOString();
    p.to = new Date().toISOString();
  }
  if (state.from) p.from = new Date(state.from + "T00:00:00").toISOString();
  if (state.to) p.to = new Date(state.to + "T23:59:59").toISOString();
  return p;
}

// ------------------------------- fetch --------------------------------
async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data?.error || `Ошибка ${res.status}`);
  return data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.add("hidden"), 3200);
}

function renderLoading() {
  const c = $("#content");
  c.innerHTML = `<div class="loading"><div class="spinner"></div><span>Загружаем данные CRM…</span></div>`;
}

function setStatus(mode, text) {
  const el = $("#portal-status");
  el.className = "portal-status " + mode;
  el.innerHTML = `<span class="dot"></span> ${text}`;
}

// ------------------------------- views --------------------------------
function renderOverview() {
  const c = $("#content");
  c.innerHTML = `
    <div class="kpi-grid" id="kpiGrid"></div>
    <div class="panel">
      <div class="panel-head">
        <h2>Воронка по стадиям</h2>
        <span class="chip" id="pipeSum"></span>
      </div>
      <div id="pipeList" class="table-wrap"></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Последние сделки</h2></div>
      <div id="recentTable" class="table-wrap"></div>
    </div>
  `;
  return Promise.all([loadKpi(), loadPipeline(), loadRecent()]);
}

function renderPipeline() {
  const c = $("#content");
  c.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h2>Сводка по стадиям воронки</h2><span class="chip" id="pipeSum"></span></div>
      <div id="pipeList" class="table-wrap"></div>
    </div>
  `;
  return loadPipeline();
}

function renderDeals() {
  const c = $("#content");
  c.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h2>Последние сделки</h2><span class="chip" id="recentCount"></span></div>
      <div id="recentTable" class="table-wrap"></div>
    </div>
  `;
  return loadRecent();
}

// ---------------------------- KPI -------------------------------------
async function loadKpi() {
  const grid = $("#kpiGrid");
  try {
    const d = await api("/api/deals/kpi", periodParams());
    grid.innerHTML = `
      <div class="kpi">
        <div class="kpi-label">Сумма открытых сделок</div>
        <div class="kpi-value">${money(d.openSum)}</div>
        <div class="kpi-hint">${d.openCount ?? 0} сделок в работе · портал</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Выиграно за период</div>
        <div class="kpi-value">${d.wonCount ?? 0}</div>
        <div class="kpi-hint">на ${money(d.wonAmount)}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Средний чек (выигранные)</div>
        <div class="kpi-value">${money(d.avgCheck)}</div>
        <div class="kpi-hint">за выбранный период</div>
      </div>
    `;
    if (d.truncated) toast("Часть данных не досчитана на стороне портала — период может быть слишком широким");
  } catch (e) {
    renderErrorText(grid, "Не удалось загрузить показатели", e);
  }
}

// --------------------------- pipeline --------------------------------
async function loadPipeline() {
  const list = $("#pipeList");
  const sumEl = $("#pipeSum");
  try {
    const d = await api("/api/deals/pipeline", periodParams());
    const rows = d.rows || [];
    const maxAmount = Math.max(...rows.map((r) => r.amount), 1);
    const totalAmount = rows.reduce((s, r) => s + r.amount, 0);
    const totalCount = rows.reduce((s, r) => s + r.count, 0);
    if (sumEl) sumEl.textContent = `${totalCount} сделок · ${moneyCompact(totalAmount)}`;

    if (rows.length === 0) {
      list.innerHTML = `<div class="empty">Нет сделок за выбранный период.</div>`;
      return;
    }
    list.innerHTML = `
      <table>
        <thead><tr>
          <th>Стадия</th><th>Доля по сумме</th><th>Сделок</th><th>Сумма</th>
        </tr></thead>
        <tbody>
          ${rows
            .map((r) => {
              const pct = Math.round((r.amount / maxAmount) * 100);
              return `<tr>
                <td>
                  <span class="stage-sem ${r.semantics || ""}"></span>
                  <span class="stage-name">${escapeHtml(r.name)}
                    ${r.categoryName && r.categoryName !== "Основная воронка" ? `<span class="stage-cat"> · ${escapeHtml(r.categoryName)}</span>` : ""}
                  </span>
                </td>
                <td><div class="stage-track"><div class="stage-fill" style="width:${pct}%"></div></div></td>
                <td class="stage-count">${r.count}</td>
                <td class="stage-amount">${money(r.amount)}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    `;
    if (d.truncated) {
      const note = document.createElement("div");
      note.className = "truncated-note";
      note.textContent = `⚠ Период слишком широкий — портал обработал только часть сделок (${d.recordsProcessed ?? "?"}). Сузьте период для точных цифр.`;
      list.appendChild(note);
    }
  } catch (e) {
    renderErrorText(list, "Не удалось загрузить воронку", e);
  }
}

// ---------------------------- recent ---------------------------------
async function loadRecent() {
  const table = $("#recentTable");
  const countEl = $("#recentCount");
  try {
    const d = await api("/api/deals/recent", { ...periodParams(), limit: 15 });
    const rows = d.rows || [];
    if (countEl) countEl.textContent = `${rows.length} сделок`;
    if (rows.length === 0) {
      table.innerHTML = `<div class="empty">За выбранный период сделки не найдены.</div>`;
      return;
    }
    table.innerHTML = `
      <table>
        <thead><tr>
          <th>Сделка</th><th>Сумма</th><th>Стадия</th><th>Ответственный</th><th>Создана</th>
        </tr></thead>
        <tbody>
          ${rows
            .map((r) => {
              const link = state.meta.domain
                ? `<a href="https://${state.meta.domain}/crm/deal/details/${r.id}/" target="_blank" rel="noopener">${escapeHtml(r.title || `Сделка #${r.id}`)}</a>`
                : escapeHtml(r.title || `Сделка #${r.id}`);
              const isWon = /S|won/i.test(String(r.stageId));
              const isLost = /F|lose|failed/i.test(String(r.stageId));
              const pillClass = isWon ? "won" : isLost ? "lost" : "";
              const av = r.assignedName ? initialsOf(r.assignedName) : "?";
              return `<tr>
                <td class="deal-title">${link}</td>
                <td class="mono">${money(r.amount)}</td>
                <td><span class="pill ${pillClass}">${escapeHtml(r.stageName || "—")}</span></td>
                <td>
                  <span class="assign">
                    <span class="avatar ${r.assignedName ? "" : "alt"}">${escapeHtml(av)}</span>
                    ${escapeHtml(r.assignedName || "—")}
                  </span>
                </td>
                <td class="mono">${shortDate(r.createdAt)}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    `;
  } catch (e) {
    renderErrorText(table, "Не удалось загрузить сделки", e);
  }
}

function initialsOf(name) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase();
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ------------------------------ wiring -------------------------------
async function init() {
  try {
    state.meta = await api("/api/meta");
  } catch {}

  $("#period").addEventListener("change", (e) => {
    state.period = e.target.value;
    state.from = "";
    state.to = "";
    $("#from").value = "";
    $("#to").value = "";
  });
  $("#from").addEventListener("change", (e) => { state.from = e.target.value; state.period = "all"; $("#period").value = "all"; });
  $("#to").addEventListener("change", (e) => { state.to = e.target.value; state.period = "all"; $("#period").value = "all"; });
  $("#apply").addEventListener("click", refresh);

  document.querySelectorAll(".nav-item").forEach((n) => {
    n.addEventListener("click", () => {
      document.querySelectorAll(".nav-item").forEach((x) => x.classList.remove("active"));
      n.classList.add("active");
      state.view = n.dataset.view;
      $("#page-title").textContent = n.textContent.trim().replace(/^\S+\s/, "") || "Обзор воронки";
      const titles = { overview: "Обзор воронки", pipeline: "Воронка по стадиям", deals: "Последние сделки" };
      $("#page-title").textContent = titles[state.view] || "Обзор";
      refresh();
    });
  });

  const hasPlacementSession = state.meta.connected && state.meta.authMode === "placement";
  const hasLocalFallback = state.meta.connected && state.meta.authMode === "personal";
  if (!hasPlacementSession && !hasLocalFallback) {
    setStatus("err", "Портал не подключён");
    if (state.meta.configured) {
      $("#placement-guidance").classList.remove("hidden");
    } else {
      $("#local-setup-guidance").classList.remove("hidden");
    }
    $("#not-connected").classList.remove("hidden");
    $("#content").innerHTML = "";
    return;
  }
  setStatus("ok", "Подключено к порталу");
  refresh();
}

function refresh() {
  if (!state.meta.connected || !["placement", "personal"].includes(state.meta.authMode)) return;
  renderLoading();
  const view = state.view || "overview";
  if (view === "overview") renderOverview();
  else if (view === "pipeline") renderPipeline();
  else renderDeals();
}

document.addEventListener("DOMContentLoaded", init);
