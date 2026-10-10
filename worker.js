/**
 * 台股天際線 · 後端 Worker (Cloudflare Workers)
 * ------------------------------------------------------------------
 * 路由：
 *   GET  /api/stock?code=2330   → 行情＋估值＋三大法人＋近四個月日 K（開高低收量）＋技術指標（秒讀；上市、上櫃皆可）
 *   GET  /api/extra?code=2330   → 基本面與籌碼：月營收、季 EPS、股利、融資融券、外資持股、重大訊息、大盤
 *   GET  /api/quotes?codes=2330,6488,0050 → 多檔即時報價（自選股、持股損益用；一次最多 30 檔，上市上櫃可混查）
 *   GET  /api/screen            → 全市場掃描（市場雷達五份榜單，目前只含上市）
 *   GET  /api/debug             → 逐一檢查每個證交所／櫃買中心資料源是否正常（部署後先打這支確認）
 *   POST /api/analyze | /api/news | /api/command → 呼叫 Claude
 *
 * 證交所資料來源（上市）：
 *   - OpenAPI（openapi.twse.com.tw/v1）：每日收盤、估值、月營收、EPS、股利、融資融券、重大訊息、大盤
 *   - 證交所網站 RWD 端點（www.twse.com.tw/rwd/zh）：OpenAPI 沒提供的「三大法人 T86」「外資持股 MI_QFIIS」
 *     與「個股日成交 STOCK_DAY」。這組端點有頻率限制（約每 5 秒 3 次），所以全部加了快取與交易日回推。
 *   - 即時行情（mis.twse.com.tw）：盤中約 5 秒延遲的快照（上市、上櫃都有）
 *
 * 櫃買中心資料來源（上櫃）：
 *   - OpenAPI（www.tpex.org.tw/openapi/v1）：估值、融資融券、櫃買指數、基本資料、月營收、EPS、股利、重大訊息
 *   - 網站端點（www.tpex.org.tw/www/zh-tw）：三大法人買賣明細、個股日成交
 *   - 有開源專案回報櫃買中心會擋 Cloudflare 機房發出的請求（回 520），所以上櫃資料全部當「選配」：
 *     抓不到就加註說明，行情改靠即時快照，不影響上市股票。部署後請用 /api/debug 確認。
 *
 * 為什麼要有這個後端：
 *   1. 證交所 API 從瀏覽器直接打會有 CORS 問題；從 Worker（伺服器端）打沒有這個限制，還能快取。
 *   2. Anthropic API 金鑰不能放在前端；放在 Worker 的加密環境變數才安全，且能部署到 GitHub Pages。
 *
 * 部署後要做：
 *   - 設定密鑰：wrangler secret put ANTHROPIC_API_KEY   （或在 Dashboard → Settings → Variables 加密變數）
 *   - 建議把下方 ALLOW_ORIGIN 改成你的網域，例如 "https://skyzbpt.github.io"
 */

const ANTHROPIC_MODEL   = "claude-sonnet-4-6";        // 想更快、更省成本可改 "claude-haiku-4-5-20251001"
const ANTHROPIC_VERSION = "2023-06-01";
const ANALYSIS_MAX_TOKENS = 1600;
const UA = "Mozilla/5.0 (compatible; TaiguSkyline/1.0; +https://github.com/)";

// 部署後改成你的前端網域可提升安全性；開發階段用 "*" 允許全部
const ALLOW_ORIGIN = "https://skyzbpt.github.io";

// ---- 共用工具 ----
function corsHeaders() {
  const h = {
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  return h;
}
function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, corsHeaders())
  });
}
function num(v) {
  if (v == null) return null;
  const s = String(v).replace(/,/g, "").replace(/[^0-9.\-]/g, "");
  if (s === "" || s === "-") return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
// 依關鍵字在物件的 key 裡找第一個符合的欄位（相容英文／中文欄位名）
// 同一個關鍵字先找完全相同的欄位，避免 "MarginPurchaseBalance" 誤抓到 "MarginPurchaseBalancePreviousDay"
function pick(obj, patterns) {
  const keys = Object.keys(obj || {});
  for (const p of patterns) {
    const k = keys.find((k) => k.trim() === p) || keys.find((k) => k.indexOf(p) !== -1);
    if (k != null) return obj[k];
  }
  return null;
}
function rocToISO(d) {
  const m = String(d).trim().match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return String(d);
  const y = parseInt(m[1], 10) + 1911;
  return y + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
}

// ---- 台灣時間（Worker 跑在 UTC，交易日要用 UTC+8 判斷）----
function twNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
function ymdOf(d) {
  return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0");
}

// ---- 同一個 Worker 實例內的記憶體快取（減少打到證交所的次數）----
// 只存「已完成」的結果：Workers 不允許一個請求等待另一個請求的 I/O（會被判定卡死回 1101），
// 所以不能把進行中的 Promise 放進共用快取；同時發出的重複請求交給 Cloudflare 邊緣快取吸收。
const MEMO = new Map();
async function memo(key, ttlSec, fn) {
  const hit = MEMO.get(key);
  if (hit && hit.exp > Date.now()) return hit.v;
  const v = await fn();
  if (v != null) {
    const now = Date.now();
    if (MEMO.size > 400) for (const [k, e] of MEMO) if (e.exp <= now) MEMO.delete(k);
    MEMO.set(key, { v, exp: now + ttlSec * 1000 });
  }
  return v;
}

// ---- 抓證交所資料（伺服器端 + Cloudflare 邊緣快取）----
const FETCH_TIMEOUT_MS = 12000;
const RT_TIMEOUT_MS = 5000;   // 即時行情在查詢的關鍵路徑上，逾時設短一點
// www.twse.com.tw 約每 5 秒 3 次就可能暫時封鎖 IP：同一實例內把請求錯開，避免冷快取時一次爆量（櫃買中心比照辦理）
const WWW_GAP_MS = 450;
const THROTTLED = { "www.twse.com.tw": 1, "www.tpex.org.tw": 1 };
const slotNext = {};
async function hostSlot(host) {
  const now = Date.now(), at = Math.max(now, slotNext[host] || 0);
  slotNext[host] = at + WWW_GAP_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}
// 櫃買中心連不上（逾時、5xx、回 HTML）時，1 分鐘內不再重試，免得每次查詢都卡在等它
const TPEX_HOST = "www.tpex.org.tw";
const TPEX_BACKOFF_MS = 60000;
let tpexDownUntil = 0;
function twFetch(u, ttl) {
  return memo(u, ttl || 600, async () => {
    const url = new URL(u), isTpex = url.host === TPEX_HOST, tag = isTpex ? "TPEx" : "TWSE";
    const down = () => { if (isTpex) tpexDownUntil = Date.now() + TPEX_BACKOFF_MS; };
    const pausedErr = () => new Error("TPEx 剛才連線失敗，暫停重試 1 分鐘");
    if (isTpex && Date.now() < tpexDownUntil) throw pausedErr();
    // 只錯開網站端點；OpenAPI 是整包資料集、都有快取，不需要排隊
    if (THROTTLED[url.host] && url.pathname.indexOf("/openapi/") !== 0) await hostSlot(url.host);
    // 排隊期間若已有其他請求發現櫃買中心連不上，就不要再打
    if (isTpex && Date.now() < tpexDownUntil) throw pausedErr();
    let res;
    try {
      res = await fetch(u, {
        headers: { "User-Agent": UA, "Accept": "application/json" },
        cf: { cacheTtl: ttl || 600, cacheEverything: true },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        // 櫃買中心擋 Cloudflare 時會一路轉址到 /errors，每一跳都算一次子請求（免費方案每次最多 50 次）；
        // 它的 JSON 端點本來就不會轉址，所以不跟隨，看到轉址就當成連不上
        redirect: isTpex ? "manual" : "follow"
      });
    } catch (e) { down(); throw e; }
    if (isTpex && ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect")) {
      down();
      throw new Error("TPEx 轉址 " + res.status + "（可能被擋）" + url.pathname);
    }
    if (!res.ok) {
      if (res.status >= 500 || res.status === 403 || res.status === 429) down(); // 404 可能只是單一資料集改名，不算整站掛掉
      throw new Error(tag + " " + res.status + " " + url.pathname);
    }
    // 被限流（或被擋）時會回 HTML 而不是 JSON
    return res.json().catch(() => { down(); throw new Error(tag + " 回傳非 JSON（可能被限流）" + url.pathname); });
  });
}

// OpenAPI 資料集（https://openapi.twse.com.tw/ 的 swagger 有完整清單）
const OPENAPI = {
  dayAll: "exchangeReport/STOCK_DAY_ALL",   // 上市個股日成交資訊
  bwibbu: "exchangeReport/BWIBBU_ALL",      // 本益比、殖利率、股價淨值比
  basic:  "opendata/t187ap03_L",            // 上市公司基本資料
  rev:    "opendata/t187ap05_L",            // 每月營業收入彙總表
  fin:    "opendata/t187ap14_L",            // 各產業 EPS 統計資訊（季）
  div:    "opendata/t187ap45_L",            // 股利分派情形
  margn:  "exchangeReport/MI_MARGN",        // 融資融券餘額
  qfii20: "fund/MI_QFIIS_sort_20",          // 外資持股前 20 名（完整名單走 RWD）
  news:   "opendata/t187ap04_L",            // 每日重大訊息
  mkt:    "exchangeReport/FMTQIK"           // 每日市場成交資訊（含加權指數）
};
function oa(key, ttl) { return twFetch("https://openapi.twse.com.tw/v1/" + OPENAPI[key], ttl); }

// 櫃買中心 OpenAPI 資料集（https://www.tpex.org.tw/openapi/ 有完整清單）
// mopsfin_t187ap*_O 是證交所 t187ap*_L 的上櫃版（同樣來自公開資訊觀測站）。03／04／05 的名稱有多個開源專案佐證，
// 14／45 依同一命名規則。上櫃版多半是英文欄位（已知：SecuritiesCompanyCode、SecuritiesIndustryCode），
// 其餘欄位名稱未經實測，解析時中英文都試；對不上就顯示「—」，部署後用 /api/debug?ds=tp_rev&otc=6488 看實際欄位
const TPEX_OPENAPI = {
  pe:    "tpex_mainboard_peratio_analysis",  // 本益比、殖利率、股價淨值比（有專案回報已下架，抓不到改走網站端點）
  margn: "tpex_mainboard_margin_balance",    // 融資融券餘額
  index: "tpex_index",                       // 櫃買指數
  basic: "mopsfin_t187ap03_O",               // 上櫃公司基本資料
  rev:   "mopsfin_t187ap05_O",               // 每月營業收入彙總表
  fin:   "mopsfin_t187ap14_O",               // 各產業 EPS 統計資訊（季）
  div:   "mopsfin_t187ap45_O",               // 股利分派情形
  news:  "mopsfin_t187ap04_O"                // 每日重大訊息
};
function tpOa(key, ttl) { return twFetch("https://" + TPEX_HOST + "/openapi/v1/" + TPEX_OPENAPI[key], ttl); }

// ---- 證交所網站 RWD 端點：回傳 { date, fields, data }；查無資料回 null，連線失敗會丟錯 ----
async function twseRwd(path, params, ttl) {
  const q = Object.keys(params).map((k) => k + "=" + encodeURIComponent(params[k])).join("&");
  const j = await twFetch("https://www.twse.com.tw/rwd/zh/" + path + "?" + q + "&response=json", ttl);
  if (!j || j.stat !== "OK") return null;
  let fields = j.fields, data = j.data;
  if ((!Array.isArray(data) || !data.length) && Array.isArray(j.tables)) {
    const t = j.tables.find((t) => Array.isArray(t.fields) && Array.isArray(t.data) && t.data.length);
    if (t) { fields = t.fields; data = t.data; }
  }
  if (!Array.isArray(fields) || !Array.isArray(data) || !data.length) return null;
  return { date: j.date ? anyDateToISO(j.date) : null, fields: fields.map((f) => String(f).trim()), data };
}

// ---- 櫃買中心網站端點：回傳 { stat:"ok", tables:[{ date, fields, data }] } → { date, name, fields, data }；查無資料回 null ----
function slashDate(ymd) { return ymd.slice(0, 4) + "/" + ymd.slice(4, 6) + "/" + ymd.slice(6, 8); }
async function tpexWww(path, params, ttl) {
  const q = Object.keys(params).map((k) => k + "=" + encodeURIComponent(params[k])).join("&");
  const j = await twFetch("https://" + TPEX_HOST + "/www/zh-tw/" + path + "?" + q + "&response=json", ttl);
  if (!j || String(j.stat || "").toLowerCase() !== "ok" || !Array.isArray(j.tables)) return null;
  const t = j.tables.find((t) => Array.isArray(t.data) && t.data.length);
  if (!t) return null;
  return { date: (t.date || j.date) ? anyDateToISO(t.date || j.date) : null, name: j.name || null,
    fields: (Array.isArray(t.fields) ? t.fields : []).map((f) => String(f).trim()), data: t.data };
}

// 盤後資料約 15:00 後公布：從最近一個交易日往回找（跳過週末；農曆年前後可能連續 7 個平日休市，最多試 10 天）
// 休市日查無資料的結果會快取 12 小時，所以長回推只有第一次會多打幾次
async function latestTradingDay(fetchDay) {
  const now = twNow(), today = ymdOf(now);
  const d = new Date(now.getTime());
  if (now.getUTCHours() < 15) d.setUTCDate(d.getUTCDate() - 1);
  for (let tries = 0, guard = 0; tries < 10 && guard < 20; guard++, d.setUTCDate(d.getUTCDate() - 1)) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const ymd = ymdOf(d);
    let r;
    try { r = await fetchDay(ymd, ymd === today ? 300 : 43200); }
    catch (e) { return null; } // 連線失敗或被限流就停，不要繼續狂打
    if (r) return Object.assign(r, { date: r.date || anyDateToISO(ymd) });
    tries++;
  }
  return null;
}
function twseLatest(path, params) {
  return latestTradingDay((ymd, ttl) => twseRwd(path, Object.assign({ date: ymd }, params), ttl));
}
function tpexLatest(path, params) {
  return latestTradingDay((ymd, ttl) => tpexWww(path, Object.assign({ date: slashDate(ymd) }, params), ttl));
}
function colIdx(fields, test) { return fields.findIndex(test); }
const has = (s) => (h) => h.indexOf(s) !== -1;

// ---- 三大法人買賣超日報（T86）。OpenAPI 沒有這份資料，改走 RWD 端點 ----
function fetchT86() {
  return memo("T86", 600, async () => {
    const r = await twseLatest("fund/T86", { selectType: "ALLBUT0999" });
    if (!r) return null;
    const f = r.fields;
    const iCode = colIdx(f, has("證券代號"));
    const iForeign = colIdx(f, has("外陸資買賣超"));          // 外資及陸資（不含外資自營商）
    const iForeignDealer = colIdx(f, has("外資自營商買賣超"));
    const iTrust = colIdx(f, has("投信買賣超"));
    const iDealer = colIdx(f, (h) => h === "自營商買賣超股數");  // 自營商合計（自行買賣＋避險）
    const iDealerSelf = colIdx(f, (h) => h.indexOf("自營商買賣超股數(自行買賣)") === 0);
    const iDealerHedge = colIdx(f, (h) => h.indexOf("自營商買賣超股數(避險)") === 0);
    const iTotal = colIdx(f, has("三大法人買賣超"));
    if (iCode < 0) return null;
    const at = (row, i) => (i < 0 ? null : num(row[i]));
    const lots = (v) => (v == null ? null : Math.round(v / 1000));
    const byCode = {};
    for (const row of r.data) {
      const code = String(row[iCode] || "").trim();
      if (!code) continue;
      const fx = at(row, iForeign), fd = at(row, iForeignDealer), tr = at(row, iTrust);
      let dl = at(row, iDealer);
      if (dl == null && (iDealerSelf >= 0 || iDealerHedge >= 0)) dl = (at(row, iDealerSelf) || 0) + (at(row, iDealerHedge) || 0);
      const foreign = (fx == null && fd == null) ? null : (fx || 0) + (fd || 0);
      let total = at(row, iTotal);
      if (total == null && (foreign != null || tr != null || dl != null)) total = (foreign || 0) + (tr || 0) + (dl || 0);
      byCode[code] = { foreignLots: lots(foreign), trustLots: lots(tr), dealerLots: lots(dl), totalLots: lots(total) };
    }
    return { date: r.date, byCode };
  });
}

// ---- 外資及陸資持股（MI_QFIIS 全部個股）。OpenAPI 只有前 20 名，完整名單走 RWD ----
function fetchQFIIS() {
  return memo("QFIIS", 1800, async () => {
    const r = await twseLatest("fund/MI_QFIIS", { selectType: "ALLBUT0999" });
    if (!r) return null;
    const f = r.fields;
    const iCode = colIdx(f, has("證券代號"));
    let iPct = colIdx(f, has("全體外資及陸資持股比率"));
    if (iPct < 0) iPct = colIdx(f, (h) => h.indexOf("持股比率") !== -1 && h.indexOf("尚可") === -1);
    const iLimit = colIdx(f, has("共用法令投資上限比率"));
    if (iCode < 0 || iPct < 0) return null;
    const byCode = {};
    for (const row of r.data) {
      const code = String(row[iCode] || "").trim();
      if (code) byCode[code] = { holdingPct: num(row[iPct]), limitPct: iLimit < 0 ? null : num(row[iLimit]) };
    }
    return { date: r.date, byCode };
  });
}

// ---- 上櫃三大法人買賣明細（櫃買中心網站端點）----
// 欄位順序參考 fugle/node-twstock（以實際回應驗證）：代號、名稱之後
//   24 欄版：外資(不含外資自營商) 買/賣/超、外資自營商 買/賣/超、外資及陸資合計 買/賣/超、投信 買/賣/超、
//           自營商(自行買賣) 買/賣/超、自營商(避險) 買/賣/超、自營商合計 買/賣/超、三大法人合計
//   16 欄版：外資 買/賣/超、投信 買/賣/超、自營商合計、自營商(自行買賣) 買/賣/超、自營商(避險) 買/賣/超、三大法人合計
function fetchTpexInst() {
  return memo("TPEX_INST", 600, async () => {
    const r = await tpexLatest("insti/dailyTrade", { type: "Daily", sect: "EW" });
    if (!r) return null;
    // 單位通常是「股」；若欄位標示為「張」就不用再除以 1000
    const inLots = r.fields.some((h) => h.indexOf("張") !== -1);
    const lots = (v) => (v == null ? null : inLots ? Math.round(v) : Math.round(v / 1000));
    const byCode = {};
    for (const row of r.data) {
      const code = String(row[0] || "").trim();
      if (!code) continue;
      const v = row.slice(2).map(num);
      let foreign, trust, dealer, total;
      if (v.length >= 22) { foreign = v[8]; trust = v[11]; dealer = v[20]; total = v[21]; }
      else if (v.length >= 14) { foreign = v[2]; trust = v[5]; dealer = v[6]; total = v[13]; }
      else continue;
      byCode[code] = { foreignLots: lots(foreign), trustLots: lots(trust), dealerLots: lots(dealer), totalLots: lots(total) };
    }
    return { date: r.date, byCode };
  });
}

// ---- 上櫃本益比／殖利率／股價淨值比 ----
// 先用 OpenAPI；有開源專案回報這個資料集已下架，抓不到就改走網站端點 afterTrading/peQryDate
// （欄位順序參考 fugle/node-twstock：代號、名稱、本益比、每股股利、股利年度、殖利率、股價淨值比）
function fetchTpexPe() {
  return memo("TPEX_PE", 600, async () => {
    const rows = await tpOa("pe", 600).catch(() => null);
    const byCode = {};
    if (Array.isArray(rows) && rows.length) {
      for (const r of rows) {
        const code = codeOf(r);
        if (code) byCode[code] = { name: String(pick(r, ["CompanyName", "公司名稱"]) || "").trim() || null,
          pe: num(pick(r, ["PriceEarningRatio", "本益比"])), dividendYield: num(pick(r, ["YieldRatio", "殖利率"])),
          pb: num(pick(r, ["PriceBookRatio", "淨值比"])) };
      }
      return { source: "openapi", byCode };
    }
    const w = await tpexLatest("afterTrading/peQryDate", {});
    if (!w) return null;
    const at = (test, dflt) => { const i = colIdx(w.fields, test); return i < 0 ? dflt : i; };
    const iPe = at(has("本益比"), 2), iY = at(has("殖利率"), 5), iPb = at(has("淨值比"), 6);
    for (const row of w.data) {
      const code = String(row[0] || "").trim();
      if (code) byCode[code] = { name: String(row[1] || "").trim() || null, pe: num(row[iPe]), dividendYield: num(row[iY]), pb: num(row[iPb]) };
    }
    return { source: "www", date: w.date, byCode };
  });
}

// ---- 盤中／當日即時快照（TWSE MIS，約 5 秒延遲；上市 tse_、上櫃 otc_）----
const MIS_URL = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp";
const MIS_HEADERS = { "User-Agent": UA, "Accept": "application/json", "Referer": "https://mis.twse.com.tw/stock/index.jsp" };

// 把 MIS 回傳的一筆 msgArray 整理成統一格式（單檔即時行情與多檔報價共用，判斷規則才會一致）
// 沒有代號回 null；還沒有當盤成交（例如未開盤）時 close／change 為 null，只剩昨收 prevClose
function parseMis(m) {
  if (!m || !m.c) return null;
  const y = num(m.y);
  let z = num(m.z), approx = false;
  // 這 5 秒內剛好沒成交時 z 會是 "-"：開盤後改用最佳買價（沒有就最佳賣價）暫代
  if (z == null && num(m.o) != null) {
    const first = (s) => num(String(s || "").split("_")[0]);
    z = first(m.b);
    if (z == null) z = first(m.a);
    approx = z != null;
  }
  const iso = anyDateToISO(m.d) || null;
  return {
    name: m.n || null,
    ex: m.ex === "otc" ? "otc" : "tse",
    market: m.ex === "otc" ? "上櫃 (TPEx)" : "上市 (TWSE)",
    date: /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null, time: m.t || null, approx,
    close: z, open: num(m.o), high: num(m.h), low: num(m.l),
    prevClose: y,
    change: (z != null && y != null) ? +(z - y).toFixed(2) : null,
    changePct: (z != null && y != null && y !== 0) ? +((z - y) / y * 100).toFixed(2) : null,
    volumeLots: num(m.v)
  };
}

async function fetchRealtime(code) {
  for (const ex of ["tse", "otc"]) {
    try {
      const res = await fetch(MIS_URL + "?ex_ch=" + ex + "_" + code + ".tw&json=1&delay=0", {
        headers: MIS_HEADERS,
        cf: { cacheTtl: 30, cacheEverything: true },
        signal: AbortSignal.timeout(RT_TIMEOUT_MS)
      });
      if (!res.ok) continue;
      const j = await res.json().catch(() => null);
      const q = parseMis(j && Array.isArray(j.msgArray) && j.msgArray[0]);
      if (!q || q.close == null) continue; // 尚無當盤成交（如未開盤），交給收盤資料處理
      return q;
    } catch (e) { /* 換下一個來源 */ }
  }
  return null;
}

// ---- 多檔即時報價（/api/quotes：自選股行情、價格警示、持股損益共用）----
// 每個代號的上市 tse_ 與上櫃 otc_ 頻道都問（MIS 只會回存在的那一個），所以不用先判斷市場；每 15 檔合併成一次請求
const QUOTES_MAX = 30, QUOTES_CHUNK = 15, QUOTES_TIMEOUT_MS = 8000;

// 解析 ?codes=2330,6488,0050：去空白、轉大寫、去重複；格式不對或超過上限回 { error }
function parseCodes(s) {
  const codes = [];
  for (const raw of String(s || "").split(",")) {
    const c = raw.trim().toUpperCase();
    if (!c) continue; // 容許多打的逗號（例如結尾的 ","）
    if (!/^\d{4,6}[A-Z]?$/.test(c)) return { error: "股票代號格式不正確：" + c.slice(0, 12) };
    if (codes.indexOf(c) === -1) codes.push(c);
  }
  if (!codes.length) return { error: "請提供股票代號，用逗號分隔（例如 2330,0050）" };
  if (codes.length > QUOTES_MAX) return { error: "一次最多查詢 " + QUOTES_MAX + " 檔股票" };
  return { codes };
}

// 回傳 { asOf, quotes: { 代號: 報價 }, missing: [查無的代號] }；
// 盤前還沒成交、但有昨收的股票照樣回傳（close 為 null），讓網頁顯示「尚未開盤」
async function fetchQuotes(codes) {
  const want = new Set(codes);
  const chunks = [];
  for (let i = 0; i < codes.length; i += QUOTES_CHUNK) chunks.push(codes.slice(i, i + QUOTES_CHUNK));
  const lists = await Promise.all(chunks.map(async (part) => {
    const exCh = part.map((c) => "tse_" + c + ".tw|otc_" + c + ".tw").join("|");
    try {
      const res = await fetch(MIS_URL + "?ex_ch=" + exCh + "&json=1&delay=0", {
        headers: MIS_HEADERS,
        cf: { cacheTtl: 15, cacheEverything: true },
        signal: AbortSignal.timeout(QUOTES_TIMEOUT_MS)
      });
      if (!res.ok) return null;
      const j = await res.json().catch(() => null);  // 被限流時會回 HTML
      return j && Array.isArray(j.msgArray) ? j.msgArray : null;
    } catch (e) { return null; }
  }));
  // 每一批都失敗才算整體失敗；只有部分失敗時，那幾檔會列在 missing
  if (lists.every((x) => x == null)) throw new Error("即時報價暫時無法取得（證交所即時行情連線失敗），請稍後再試");
  const quotes = {};
  for (const list of lists) for (const m of list || []) {
    const q = parseMis(m);
    const code = q ? String(m.c).trim().toUpperCase() : "";
    if (!q || !want.has(code)) continue;
    if (q.close == null && q.prevClose == null) continue;     // 沒成交也沒昨收（例如暫停交易）就當查無
    if (quotes[code] && quotes[code].close != null) continue; // 同一代號回了兩筆時，以有成交的那筆為準
    quotes[code] = {
      code, name: q.name, ex: q.ex, close: q.close, open: q.open, high: q.high, low: q.low,
      prevClose: q.prevClose, change: q.change, changePct: q.changePct, volumeLots: q.volumeLots,
      date: q.date, time: q.time, approx: q.approx
    };
  }
  return { asOf: new Date().toISOString(), quotes, missing: codes.filter((c) => !quotes[c]) };
}

// ---- 個股日成交（給 K 線圖與技術分析用）----
// 抓最近 4 個月（前 3 個月＋當月），留最後 80 個交易日：60 日均線、MACD 都需要夠長的資料
const HIST_MONTHS = 4, HIST_ROWS = 80;
// 回傳新→舊的月份清單：從當月往回抓，中途被限流而停下時，至少保住最近的資料（不會只剩舊月份、跟今天接不上）
// 當月還會變動，快取短一點；之前的月份已定案，快取 12 小時
function recentMonths() {
  const now = twNow(), out = [];
  for (let i = 0; i < HIST_MONTHS; i++) {
    out.push({ ymd: ymdOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))), ttl: i === 0 ? 1800 : 43200 });
  }
  return out;
}
// 各月資料（新→舊）接回由舊到新、去掉重複日期，只留最後 HIST_ROWS 筆
function joinMonths(chunks) {
  const seen = {};
  const rows = [].concat(...chunks.reverse()).filter((x) => (seen[x.date] ? false : (seen[x.date] = 1)));
  return rows.slice(-HIST_ROWS);
}

async function fetchHistory(code) {
  const chunks = [];
  for (const m of recentMonths()) {
    let r = null;
    try { r = await twseRwd("afterTrading/STOCK_DAY", { date: m.ymd, stockNo: code }, m.ttl); }
    catch (e) {
      // 被限流或逾時就停，不要再多打；只有 4xx（網址改版）才退回舊版網址
      if (!/^TWSE 4\d\d/.test(String(e && e.message))) break;
      try {
        const j = await twFetch("https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=" + m.ymd + "&stockNo=" + code, m.ttl);
        if (j && j.stat === "OK" && Array.isArray(j.data)) r = { data: j.data };
      } catch (e2) { /* 略過單月失敗 */ }
    }
    if (!r) continue;
    const rows = [];
    for (const d of r.data) {
      // d: [日期, 成交股數, 成交金額, 開盤, 最高, 最低, 收盤, 漲跌價差, 成交筆數]（沒成交的日子開高低收是 "--"）
      const close = num(d[6]);
      const vol = num(d[1]);
      if (close != null) rows.push({ date: rocToISO(d[0]), open: num(d[3]), high: num(d[4]), low: num(d[5]), close,
        volumeLots: vol != null ? Math.round(vol / 1000) : null });
    }
    chunks.push(rows);
  }
  return joinMonths(chunks);
}

// ---- 上櫃個股日成交（櫃買中心網站端點）----
// 欄位：日期、成交張數（舊資料為成交仟股，兩者都是 1000 股）、成交仟元、開盤、最高、最低、收盤、漲跌、筆數
// 回傳 { name, rows }；rows 帶開高低收，最新一筆可直接當收盤行情
async function fetchTpexHistory(code) {
  const chunks = [];
  let name = null;
  for (const m of recentMonths()) {
    let r = null;
    try { r = await tpexWww("afterTrading/tradingStock", { code, date: slashDate(m.ymd) }, m.ttl); }
    catch (e) { break; } // 連不上就停，不要再多打
    if (!r) continue;
    name = name || r.name;
    const f = r.fields;
    const at = (test, dflt) => { const i = colIdx(f, test); return i < 0 ? dflt : i; };
    const iVol = at((h) => h.indexOf("成交") === 0 && (h.indexOf("張") !== -1 || h.indexOf("仟股") !== -1), 1);
    const iAmt = at(has("仟元"), 2), iOpen = at(has("開盤"), 3), iHigh = at(has("最高"), 4), iLow = at(has("最低"), 5);
    const iClose = at(has("收盤"), 6), iChg = at(has("漲跌"), 7), iTx = at(has("筆數"), 8);
    const rows = [];
    for (const d of r.data) {
      const close = num(d[iClose]);
      if (close == null) continue;
      const amt = num(d[iAmt]);
      rows.push({
        date: rocToISO(String(d[0]).replace(/[^\d\/]/g, "")), close, volumeLots: num(d[iVol]),
        open: num(d[iOpen]), high: num(d[iHigh]), low: num(d[iLow]), change: num(d[iChg]),
        tradeValue: amt != null ? amt * 1000 : null, transactions: num(d[iTx])
      });
    }
    chunks.push(rows);
  }
  return { name, rows: joinMonths(chunks) };
}

// 盤中／當日即時快照優先（解決全市場收盤檔更新延遲的問題）
function applyRealtime(snap, rt, source) {
  if (!rt || rt.close == null) return;
  snap.name = snap.name || rt.name;
  if (rt.market) snap.market = rt.market;
  const base = snap.price || {};
  const sameDay = base.close != null && base.close === rt.close;
  snap.price = {
    close: rt.close, open: rt.open, high: rt.high, low: rt.low,
    change: rt.change, changePct: rt.changePct,
    volumeLots: rt.volumeLots != null ? rt.volumeLots : (base.volumeLots != null ? base.volumeLots : null),
    tradeValue: sameDay && base.tradeValue != null ? base.tradeValue : null,
    transactions: sameDay && base.transactions != null ? base.transactions : null
  };
  snap.priceDate = rt.date;
  snap.priceTime = rt.time;
  snap.priceLabel = rt.time === "13:30:00" ? "收盤" : "盤中即時";
  snap.source = source + " ＋ 即時行情快照";
  if (rt.approx) snap.notes.push("最近 5 秒內沒有成交，現價暫以最佳買價（或賣價）顯示。");
}
// 盤中／今日即時價還沒進日成交檔：補到走勢最後一點，讓 K 線圖與技術面看到今天
// 現價若是暫代的最佳買賣價，可能略超出當日高低，所以高低點放寬到包含現價，K 棒才不會畫歪
function appendLive(hist, rt) {
  if (!hist || !rt || !rt.date || rt.close == null) return;
  const last = hist[hist.length - 1];
  if (!last || last.date < rt.date) {
    hist.push({
      date: rt.date, open: rt.open,
      high: rt.high != null ? Math.max(rt.high, rt.close) : null,
      low: rt.low != null ? Math.min(rt.low, rt.close) : null,
      close: rt.close, volumeLots: rt.volumeLots, live: true
    });
  }
}

// ---- 技術指標（純計算，不打任何 API）----
// hist：由舊到新的 { date, open, high, low, close, volumeLots, live? }；收盤價不到 20 筆回 null
//   均線 MA：最近 N 日收盤的簡單平均（N 日不足回 null）
//   RSI(14)：Wilder 平滑法，前 14 個漲跌幅先取簡單平均，之後 新均值＝(舊均值×13＋今日)/14；
//            期間完全沒跌回 100，完全沒漲也沒跌（價格持平）回 50
//   KD(9,3,3)：台灣常用算法，RSV＝(今收−9日最低)/(9日最高−9日最低)×100（最高＝最低時 RSV 取 50），
//            K＝2/3×前K＋1/3×RSV、D＝2/3×前D＋1/3×K，從第 9 根開始算、K、D 起始值 50
//   MACD：DIF＝EMA12−EMA26、DEA＝DIF 的 EMA9、柱狀體 hist＝DIF−DEA（看盤軟體的 OSC）；
//         EMA 以前 N 筆的簡單平均起算，所以要 26＋9 根才有第一個 DEA，不到 35 根回 null
//   量比：今日成交張數 ÷ 前 5 日平均張數
// 缺最高／最低價的日子用收盤價代替
function computeTechnical(hist) {
  const rows = (Array.isArray(hist) ? hist : []).filter((x) => x && typeof x.close === "number" && isFinite(x.close));
  const n = rows.length;
  if (n < 20) return null;
  const C = rows.map((x) => x.close);
  const H = rows.map((x) => Math.max(x.high != null ? x.high : x.close, x.close));
  const L = rows.map((x) => Math.min(x.low != null ? x.low : x.close, x.close));
  const r1 = (v) => (v == null ? null : +v.toFixed(1));
  const r2 = (v) => (v == null ? null : +v.toFixed(2));
  const last = rows[n - 1], close = C[n - 1];

  // 均線
  const sma = (len) => (n < len ? null : C.slice(n - len).reduce((a, b) => a + b, 0) / len);
  const m5 = sma(5), m20 = sma(20);

  // RSI(14)
  let rsi = null;
  if (n > 14) {
    let gain = 0, loss = 0;
    for (let i = 1; i <= 14; i++) { const d = C[i] - C[i - 1]; if (d > 0) gain += d; else loss -= d; }
    gain /= 14; loss /= 14;
    for (let i = 15; i < n; i++) {
      const d = C[i] - C[i - 1];
      gain = (gain * 13 + (d > 0 ? d : 0)) / 14;
      loss = (loss * 13 + (d < 0 ? -d : 0)) / 14;
    }
    rsi = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  }

  // KD(9,3,3)：同時記下前一天的 K、D，用來判斷交叉
  let k = 50, d = 50, kPrev = 50, dPrev = 50;
  for (let i = 8; i < n; i++) {
    const hh = Math.max(...H.slice(i - 8, i + 1)), ll = Math.min(...L.slice(i - 8, i + 1));
    const rsv = hh === ll ? 50 : (C[i] - ll) / (hh - ll) * 100;
    kPrev = k; dPrev = d;
    k = k * 2 / 3 + rsv / 3;
    d = d * 2 / 3 + k / 3;
  }

  // MACD(12,26,9)
  const ema = (vals, len) => {
    const out = new Array(vals.length).fill(null);
    if (vals.length < len) return out;
    let e = vals.slice(0, len).reduce((a, b) => a + b, 0) / len;
    out[len - 1] = e;
    for (let i = len; i < vals.length; i++) { e = e + (vals[i] - e) * 2 / (len + 1); out[i] = e; }
    return out;
  };
  let macd = null, osc = null, oscPrev = null;
  if (n >= 35) {
    const e12 = ema(C, 12), e26 = ema(C, 26);
    const dif = e26.slice(25).map((v, i) => e12[i + 25] - v);  // 第 26 根起才有 DIF
    const dea = ema(dif, 9);
    osc = dif[dif.length - 1] - dea[dea.length - 1];
    oscPrev = dif[dif.length - 2] - dea[dea.length - 2];
    macd = { dif: r2(dif[dif.length - 1]), dea: r2(dea[dea.length - 1]), hist: r2(osc) };
  }

  // 量比
  const vNow = last.volumeLots;
  const prev5 = rows.slice(n - 6, n - 1).map((x) => x.volumeLots).filter((v) => typeof v === "number");
  const avg5 = prev5.length === 5 ? prev5.reduce((a, b) => a + b, 0) / 5 : null;
  const volRatio = (typeof vNow === "number" && avg5) ? r2(vNow / avg5) : null;

  // 近 20 日高低點
  const high20 = Math.max(...H.slice(n - 20)), low20 = Math.min(...L.slice(n - 20));

  // 訊號（tone：bull 偏多、bear 偏空、neutral 中性）
  const signals = [];
  const above = close >= m20;
  signals.push({ key: "trend",
    label: (above ? "站上月線" : "跌破月線") + (m5 > m20 ? "，均線多頭排列" : m5 < m20 ? "，均線空頭排列" : ""),
    tone: above && m5 > m20 ? "bull" : !above && m5 < m20 ? "bear" : "neutral" });
  if (rsi != null) {
    if (rsi > 70) signals.push({ key: "rsi", label: "RSI 偏高，短線過熱", tone: "bear" });
    else if (rsi < 30) signals.push({ key: "rsi", label: "RSI 偏低，短線超賣", tone: "bull" });
    else signals.push({ key: "rsi", label: "RSI 中性", tone: "neutral" });
  }
  if (kPrev <= dPrev && k > d) signals.push({ key: "kd", label: "KD 黃金交叉", tone: "bull" });
  else if (kPrev >= dPrev && k < d) signals.push({ key: "kd", label: "KD 死亡交叉", tone: "bear" });
  else if (k > 80) signals.push({ key: "kd", label: "KD 高檔，短線偏熱", tone: "bear" });
  else if (k < 20) signals.push({ key: "kd", label: "KD 低檔，短線偏冷", tone: "bull" });
  else signals.push({ key: "kd", label: "KD 中性", tone: "neutral" });
  if (macd) {
    if (oscPrev <= 0 && osc > 0) signals.push({ key: "macd", label: "MACD 翻紅", tone: "bull" });
    else if (oscPrev >= 0 && osc < 0) signals.push({ key: "macd", label: "MACD 翻綠", tone: "bear" });
    else if (osc > 0) signals.push({ key: "macd", label: "MACD 多方", tone: "bull" });
    else if (osc < 0) signals.push({ key: "macd", label: "MACD 空方", tone: "bear" });
    else signals.push({ key: "macd", label: "MACD 持平", tone: "neutral" }); // 價格完全沒動時柱狀體剛好是 0
  }
  // 盤中的量還在累積，量比一定偏低，所以今天是即時資料時不判斷「量縮」
  if (volRatio != null && volRatio >= 2) signals.push({ key: "vol", label: "爆量（量增 " + (+volRatio.toFixed(1)) + " 倍）", tone: "neutral" });
  else if (volRatio != null && volRatio <= 0.5 && !last.live) signals.push({ key: "vol", label: "量縮", tone: "neutral" });
  // 20 日內價格完全沒動時，最高＝最低，不算創新高或新低
  if (high20 > low20) {
    if (close >= high20) signals.push({ key: "range", label: "創 20 日新高", tone: "bull" });
    else if (close <= low20) signals.push({ key: "range", label: "創 20 日新低", tone: "bear" });
  }

  return {
    asOf: last.date, bars: n,
    ma: { ma5: r2(m5), ma10: r2(sma(10)), ma20: r2(m20), ma60: r2(sma(60)) },
    rsi14: r1(rsi),
    kd: { k: r1(k), d: r1(d) },
    macd, volRatio,
    high20: r2(high20), low20: r2(low20),
    signals
  };
}

// 上市全市場收盤檔筆數正常（上千檔）才拿來判斷市場；空陣列或殘缺時當作沒抓到，免得把上市股誤判成上櫃
function listedOf(dayAll) { return Array.isArray(dayAll) && dayAll.length > 100 ? dayAll : null; }

// 判斷上市或上櫃（/api/stock、/api/extra、/api/command 共用同一套規則，兩張卡片才不會互相矛盾）：
//   上市全市場收盤檔有這檔 → 上市；否則看即時行情回報的市場；
//   即時行情也沒有（盤前、興櫃、代號有誤）→ 收盤檔正常就推定上櫃（未確認），收盤檔也抓不到就無法判斷（null）
// rtP 可由呼叫端先發出；沒給的話，只有在上市清單找不到時才去查即時行情
async function marketOf(code, rtP) {
  const dayAll = await oa("dayAll", 600).catch(() => null);
  const listed = listedOf(dayAll);
  if (listed && listed.some((r) => r.Code === code)) return { market: "tse", confirmed: true, dayAll };
  const rt = await (rtP || fetchRealtime(code).catch(() => null));
  if (rt) return { market: rt.ex, confirmed: true, dayAll };
  return { market: listed ? "otc" : null, confirmed: false, dayAll };
}

// mkP／rtP 可由 /api/command 傳入，讓行情與基本面共用同一次判斷
async function buildSnapshot(code, mkP, rtP) {
  rtP = rtP || fetchRealtime(code).catch(() => null);
  // 上市整包資料跟著判斷一起發出，上市股不用等判斷完才開始抓（上櫃股會多抓這兩份，但有快取，市場雷達也會用到）
  const bwP = oa("bwibbu", 600).catch(() => null);
  const t86P = fetchT86().catch(() => null);
  // 個股日成交只對上市股有用：即時行情若比收盤檔先回來、而且確認是上市，就先開始抓
  let histP = null;
  const histOnce = () => histP || (histP = fetchHistory(code).catch(() => null));
  rtP.then((rt) => { if (rt && rt.ex === "tse") histOnce(); });
  const mk = await (mkP || marketOf(code, rtP));
  const twse = () => buildTwseSnapshot(code, mk.dayAll, rtP, bwP, t86P, histOnce);
  if (mk.market === "tse") return twse();
  if (mk.market === "otc") return buildOtcSnapshot(code, await rtP, mk.confirmed);
  // 無法判斷：照舊先走上市，沒有價格再試上櫃
  const s = await twse();
  if (s.price) return s;
  const o = await buildOtcSnapshot(code, null, false).catch(() => null);
  return (o && o.price) ? o : s;
}

async function buildTwseSnapshot(code, dayAll, rtP, bwP, t86P, histOnce) {
  const [bwibbu, t86, hist, rt] = await Promise.all([bwP, t86P, histOnce(), rtP]);

  const snap = {
    code, name: null, market: "上市 (TWSE)", asOf: new Date().toISOString(),
    source: "臺灣證券交易所 OpenAPI", price: null, priceDate: null, priceLabel: null, priceTime: null,
    valuation: null, institutional: null, history: null, technical: null, notes: []
  };

  // 收盤行情
  if (Array.isArray(dayAll)) {
    const row = dayAll.find((r) => r.Code === code);
    if (row) {
      snap.name = row.Name || snap.name;
      const close = num(row.ClosingPrice), change = num(row.Change);
      const prev = (close != null && change != null) ? (close - change) : null;
      const vol = num(row.TradeVolume);
      snap.price = {
        close, open: num(row.OpeningPrice), high: num(row.HighestPrice), low: num(row.LowestPrice),
        change, changePct: (change != null && prev) ? +(change / prev * 100).toFixed(2) : null,
        volumeLots: vol != null ? Math.round(vol / 1000) : null,
        tradeValue: num(row.TradeValue), transactions: num(row.Transaction)
      };
      if (row.Date) snap.priceDate = anyDateToISO(row.Date);
      snap.priceLabel = "收盤";
    }
  }
  applyRealtime(snap, rt, "臺灣證券交易所 OpenAPI");

  if (!snap.price) snap.notes.push("查無此代號的每日收盤資料（可能為興櫃、代號有誤，或當日非交易日）。");

  // 估值（本益比／殖利率／股價淨值比）
  if (Array.isArray(bwibbu)) {
    const row = bwibbu.find((r) => r.Code === code);
    if (row) {
      snap.name = snap.name || row.Name;
      snap.valuation = {
        pe: num(pick(row, ["PEratio", "本益比"])),
        dividendYield: num(pick(row, ["DividendYield", "殖利率"])),
        pb: num(pick(row, ["PBratio", "股價淨值比", "淨值比"]))
      };
    }
  }

  // 三大法人買賣超（單位：張＝股數/1000；正為買超、負為賣超；外資含外資自營商）
  if (t86 && t86.byCode[code]) {
    snap.institutional = Object.assign({ unit: "張", date: t86.date }, t86.byCode[code]);
  } else {
    snap.notes.push(t86 ? "最近交易日三大法人資料中查無此代號。" : "三大法人資料暫時無法取得（證交所尚未公布或連線受限）。");
  }

  appendLive(hist, rt);

  // 歷史走勢（若每日收盤缺，用歷史最後一筆補價格）
  if (hist && hist.length) {
    snap.history = hist;
    // 備援：沒有即時快照時，若全市場收盤檔落後（等於前一日、不等於最新一日），改用個股歷史最新收盤
    if ((!rt || rt.close == null) && snap.price && hist.length >= 2) {
      const lastH = hist[hist.length - 1], prevH = hist[hist.length - 2];
      if (snap.price.close === prevH.close && lastH.close !== snap.price.close) {
        snap.price.close = lastH.close;
        snap.price.change = +(lastH.close - prevH.close).toFixed(2);
        snap.price.changePct = prevH.close ? +((lastH.close - prevH.close) / prevH.close * 100).toFixed(2) : null;
        snap.price.open = null; snap.price.high = null; snap.price.low = null;
        snap.price.volumeLots = lastH.volumeLots;
        snap.price.tradeValue = null; snap.price.transactions = null;
        snap.priceDate = lastH.date;
        snap.notes.push("全市場收盤檔尚未更新至最新交易日，價格已改用個股日成交最新一筆。");
      }
    }
    if (!snap.price) {
      const last = hist[hist.length - 1], prev = hist[hist.length - 2];
      snap.price = {
        close: last.close,
        change: prev ? +(last.close - prev.close).toFixed(2) : null,
        changePct: prev ? +((last.close - prev.close) / prev.close * 100).toFixed(2) : null,
        open: null, high: null, low: null, volumeLots: last.volumeLots, tradeValue: null, transactions: null
      };
      snap.priceDate = last.date; snap.priceLabel = "收盤";
      snap.notes.push("即時每日資料不足，價格改用月成交歷史推算。");
    }
  }
  // 技術指標（走勢已含今天的即時點；資料不到 20 天為 null）
  snap.technical = computeTechnical(snap.history);

  return snap;
}

// confirmed＝即時行情已確認是上櫃；false 代表只是「不在上市清單」推定的
async function buildOtcSnapshot(code, rt, confirmed) {
  const [pe, inst, th] = await Promise.all([
    fetchTpexPe().catch(() => null),
    fetchTpexInst().catch(() => null),
    fetchTpexHistory(code).catch(() => null)
  ]);
  const SRC = "證券櫃檯買賣中心（櫃買中心）";
  const hist = th && th.rows.length ? th.rows : null;
  const snap = {
    code, name: (th && th.name) || null, market: "上櫃 (TPEx)", asOf: new Date().toISOString(),
    source: SRC, price: null, priceDate: null, priceLabel: null, priceTime: null,
    valuation: null, institutional: null, history: null, technical: null, notes: []
  };

  // 收盤行情：個股日成交最新一筆
  if (hist) {
    const last = hist[hist.length - 1];
    const prev = last.change != null ? last.close - last.change : null;
    snap.price = {
      close: last.close, open: last.open, high: last.high, low: last.low, change: last.change,
      changePct: (last.change != null && prev) ? +(last.change / prev * 100).toFixed(2) : null,
      volumeLots: last.volumeLots, tradeValue: last.tradeValue, transactions: last.transactions
    };
    snap.priceDate = last.date;
    snap.priceLabel = "收盤";
  }
  applyRealtime(snap, rt, SRC);
  if (!snap.price) snap.notes.push("查無此代號的上市／上櫃行情（可能為興櫃、代號有誤，或櫃買中心暫時無法連線）。");

  // 估值（本益比／殖利率／股價淨值比）
  const v = pe && pe.byCode[code];
  if (v) {
    snap.name = snap.name || v.name;
    snap.valuation = { pe: v.pe, dividendYield: v.dividendYield, pb: v.pb };
  }

  // 三大法人買賣超（張；外資含外資自營商）
  if (inst && inst.byCode[code]) {
    snap.institutional = Object.assign({ unit: "張", date: inst.date }, inst.byCode[code]);
  } else if (snap.price) {
    snap.notes.push(inst ? "最近交易日上櫃三大法人資料中查無此代號。" : "上櫃三大法人資料暫時無法取得（櫃買中心尚未公布或連線受限）。");
  }

  // 歷史走勢（日 K：開高低收量）與技術指標
  if (hist) {
    snap.history = hist.map((x) => ({ date: x.date, open: x.open, high: x.high, low: x.low, close: x.close, volumeLots: x.volumeLots }));
    appendLive(snap.history, rt);
  } else if (snap.price) {
    snap.notes.push("上櫃個股走勢暫時無法取得（櫃買中心連線受限），目前只顯示即時行情。");
  }
  snap.technical = computeTechnical(snap.history);
  // 沒有任何上櫃資料認得這個代號（興櫃、打錯，或盤前且櫃買中心連不上）：不要標成上櫃，免得網頁與 AI 誤認
  if (!confirmed && !hist && !snap.valuation && !snap.institutional) snap.market = null;
  return snap;
}

// ---- 個股延伸資料（基本面／籌碼／重大訊息／大盤）----
const INDUSTRY = { "01":"水泥工業","02":"食品工業","03":"塑膠工業","04":"紡織纖維","05":"電機機械","06":"電器電纜","08":"玻璃陶瓷","09":"造紙工業","10":"鋼鐵工業","11":"橡膠工業","12":"汽車工業","14":"建材營造","15":"航運業","16":"觀光餐旅","17":"金融保險","18":"貿易百貨","19":"綜合","20":"其他","21":"化學工業","22":"生技醫療","23":"油電燃氣","24":"半導體","25":"電腦及週邊設備","26":"光電","27":"通信網路","28":"電子零組件","29":"電子通路","30":"資訊服務","31":"其他電子","32":"文化創意","33":"農業科技","34":"電子商務","35":"綠能環保","36":"數位雲端","37":"運動休閒","38":"居家生活" };

function anyDateToISO(d) {
  const s = String(d || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (s.indexOf("/") !== -1) return rocToISO(s);
  if (/^\d{7}$/.test(s)) return (parseInt(s.slice(0, 3), 10) + 1911) + "-" + s.slice(3, 5) + "-" + s.slice(5, 7);
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8);
  return s;
}
function codeOf(r) {
  const v = r.Code || r.SecuritiesCompanyCode || r["公司代號"] || r["證券代號"] || r["股票代號"] ||
    pick(r, ["公司代號", "證券代號", "股票代號", "CompanyCode"]);
  return String(v || "").trim();
}

async function buildExtra(code, mkP) {
  const mk = await (mkP || marketOf(code));
  const otc = mk.market === "otc";   // 無法判斷時照舊查上市資料
  const get = otc ? tpOa : oa;
  const [basic, rev, fin, div, margn, qfiis, qfii20, news, mkt] = await Promise.all([
    get("basic", 3600).catch(() => null),
    get("rev", 3600).catch(() => null),
    get("fin", 3600).catch(() => null),
    get("div", 3600).catch(() => null),
    get("margn", 1800).catch(() => null),
    otc ? null : fetchQFIIS().catch(() => null),
    otc ? null : oa("qfii20", 1800).catch(() => null),
    get("news", 600).catch(() => null),
    (otc ? tpOa("index", 1800) : oa("mkt", 1800)).catch(() => null)
  ]);
  const out = { code, market: otc ? "上櫃 (TPEx)" : "上市 (TWSE)", asOf: new Date().toISOString(),
    source: otc
      ? "證券櫃檯買賣中心 OpenAPI（基本資料／月營收／季報／股利／信用交易／重大訊息／櫃買指數）"
      : "臺灣證券交易所 OpenAPI（基本資料／月營收／季報／股利／信用交易／重大訊息／大盤）＋ 證交所外資持股統計",
    profile: null, monthlyRevenue: null, quarterly: null, dividend: null,
    margin: null, foreign: null, announcements: null, marketIndex: null, notes: [] };
  if (otc && [basic, rev, fin, div, margn, news, mkt].every((x) => x == null)) {
    out.notes.push("櫃買中心資料暫時無法取得（連線受限），基本面暫不顯示。");
  }

  // 公司基本資料 → 產業別、股本
  if (Array.isArray(basic)) {
    const r = basic.find((x) => codeOf(x) === code);
    if (r) {
      const shares = num(pick(r, ["已發行普通股數"]));
      const capital = num(pick(r, ["實收資本額"]));
      out.profile = {
        industry: INDUSTRY[String(pick(r, ["產業別", "SecuritiesIndustryCode"]) || "").trim()] || null,
        sharesB: shares != null ? +(shares / 1e8).toFixed(2) : (capital != null ? +(capital / 10 / 1e8).toFixed(2) : null),
        capitalB: capital != null ? +(capital / 1e8).toFixed(1) : null,
        unit: "sharesB=億股, capitalB=億元"
      };
    }
  }
  // 月營收（千元 → 億元）
  if (Array.isArray(rev)) {
    const r = rev.find((x) => codeOf(x) === code);
    if (r) {
      const cur = num(pick(r, ["-當月營收", "當月營收"]));
      const ytd = num(pick(r, ["當月累計營收"]));
      out.monthlyRevenue = {
        ym: String(pick(r, ["資料年月"]) || "").trim() || null,
        revenueB: cur != null ? +(cur / 1e5).toFixed(2) : null,
        momPct: num(pick(r, ["上月比較增減"])),
        yoyPct: num(pick(r, ["去年同月增減"])),
        ytdB: ytd != null ? +(ytd / 1e5).toFixed(1) : null,
        ytdYoyPct: num(pick(r, ["前期比較增減"])),
        unit: "revenueB/ytdB=億元, 其餘=%"
      };
    }
  }
  // 最新季報（一般業；金融保險業無此彙總表）
  if (Array.isArray(fin)) {
    const rows = fin.filter((x) => codeOf(x) === code).sort((a, b) =>
      ((num(pick(a, ["年度"])) || 0) * 10 + (num(pick(a, ["季別"])) || 0)) -
      ((num(pick(b, ["年度"])) || 0) * 10 + (num(pick(b, ["季別"])) || 0)));
    const r = rows.length ? rows[rows.length - 1] : null;
    if (r) {
      const rv = num(pick(r, ["營業收入"]));
      const gp = num(pick(r, ["營業毛利"]));
      const op = num(pick(r, ["營業利益"]));
      const ni = num(pick(r, ["本期淨利", "本期稅後淨利", "稅後淨利", "本期損益", "淨利"]));
      out.quarterly = {
        period: (String(pick(r, ["年度"]) || "").trim() + " Q" + String(pick(r, ["季別"]) || "").trim()).trim(),
        eps: num(pick(r, ["基本每股盈餘"])),
        revenueB: rv != null ? +(rv / 1e5).toFixed(1) : null,
        grossMarginPct: (rv && gp != null) ? +(gp / rv * 100).toFixed(2) : null,
        operatingMarginPct: (rv && op != null) ? +(op / rv * 100).toFixed(2) : null,
        netMarginPct: (rv && ni != null) ? +(ni / rv * 100).toFixed(2) : null,
        netIncomeB: ni != null ? +(ni / 1e5).toFixed(1) : null
      };
    }
  }
  // 股利分派（現金＝盈餘＋公積；股票＝盈餘轉增資＋公積轉增資，單位 元/股）
  if (Array.isArray(div)) {
    // 同一家公司可能有多筆（年度／季配），取股利年度＋期別最新的一筆
    const rows = div.filter((x) => codeOf(x) === code).sort((a, b) =>
      ((num(pick(a, ["股利年度"])) || 0) * 10 + (num(pick(a, ["期別"])) || 0)) -
      ((num(pick(b, ["股利年度"])) || 0) * 10 + (num(pick(b, ["期別"])) || 0)));
    const r = rows.length ? rows[rows.length - 1] : null;
    if (r) {
      const c1 = num(pick(r, ["盈餘分配之現金股利"]));
      const c2 = num(pick(r, ["公積發放之現金"]));
      const s1 = num(pick(r, ["盈餘轉增資配股"]));
      const s2 = num(pick(r, ["公積轉增資配股"]));
      out.dividend = {
        year: String(pick(r, ["股利年度"]) || "").trim() || null,
        cash: (c1 != null || c2 != null) ? +(((c1 || 0) + (c2 || 0)).toFixed(4)) : null,
        stock: (s1 != null || s2 != null) ? +(((s1 || 0) + (s2 || 0)).toFixed(4)) : null
      };
    }
  }
  // 融資融券餘額（張）
  if (Array.isArray(margn)) {
    const r = margn.find((x) => codeOf(x) === code);
    if (r) {
      // 證交所為中文欄位；櫃買中心為 MarginPurchaseBalance／ShortSaleBalance 這類英文欄位
      const mb = num(pick(r, ["MarginBalanceToday", "融資今日餘額", "MarginPurchaseBalance", "TodayBalance", "MarginBalance"]));
      const mp = num(pick(r, ["MarginBalancePreviousDay", "融資前日餘額", "MarginPurchaseBalancePreviousDay", "PreviousDayBalance"]));
      const sb = num(pick(r, ["ShortBalanceToday", "融券今日餘額", "ShortSaleBalance", "ShortBalance"]));
      out.margin = {
        unit: "張",
        marginBalanceLots: mb,
        marginChangeLots: (mb != null && mp != null) ? mb - mp : null,
        shortBalanceLots: sb
      };
    }
  }
  // 市場沒被上市清單或即時行情確認時，資料集裡也查不到這檔就不標市場（可能是興櫃或代號有誤）
  if (!mk.confirmed && !(out.profile || out.monthlyRevenue || out.quarterly || out.dividend || out.margin)) out.market = null;
  // 外資及陸資持股比率（%）：完整名單優先，抓不到再看 OpenAPI 前 20 名
  if (qfiis && qfiis.byCode[code]) {
    out.foreign = Object.assign({ date: qfiis.date }, qfiis.byCode[code]);
  } else if (Array.isArray(qfii20)) {
    const r = qfii20.find((x) => codeOf(x) === code);
    if (r) out.foreign = { holdingPct: num(pick(r, ["全體外資及陸資持股比率", "外資及陸資持股比率", "持股比率", "Shareholding"])) };
  }
  if (otc) { if (out.market) out.notes.push("上櫃股票的外資持股比率目前沒有串接資料源，暫不顯示。"); }
  else if (!out.foreign && !qfiis) out.notes.push("外資持股資料暫時無法取得（證交所尚未公布或連線受限）。");
  // 當日重大訊息（最多 3 則）
  if (Array.isArray(news)) {
    const rows = news.filter((x) => codeOf(x) === code);
    if (rows.length) {
      out.announcements = rows.slice(-3).reverse().map((r) => ({
        date: anyDateToISO(pick(r, ["發言日期", "Date"])),
        subject: String(pick(r, ["主旨", "Subject"]) || "").trim().slice(0, 80)
      }));
    }
  }
  // 大盤最新一日：上市看加權指數、上櫃看櫃買指數（櫃買指數檔的日期是西元 8 碼，排序不保證，取日期最新的一筆）
  if (Array.isArray(mkt) && mkt.length) {
    const dateOf = (r) => anyDateToISO(pick(r, ["Date", "日期"]));
    const r = mkt.reduce((a, b) => (dateOf(b) > dateOf(a) ? b : a));
    out.marketIndex = {
      name: otc ? "櫃買指數" : "加權指數",
      date: dateOf(r),
      index: num(pick(r, otc ? ["Close", "收盤指數"] : ["TAIEX", "發行量加權股價指數"])),
      change: num(pick(r, ["Change", "漲跌點數"]))
    };
  }
  return out;
}

// ---- 全市場掃描（市場雷達）----
async function buildScreen() {
  const [dayAll, bwibbu, t86] = await Promise.all([
    oa("dayAll", 600).catch(() => null),
    oa("bwibbu", 600).catch(() => null),
    fetchT86().catch(() => null)
  ]);

  const byCode = {};
  if (Array.isArray(dayAll)) for (const r of dayAll) {
    const code = r.Code; if (!code) continue;
    const close = num(r.ClosingPrice), change = num(r.Change);
    const prev = (close != null && change != null) ? (close - change) : null;
    const vol = num(r.TradeVolume);
    byCode[code] = {
      code, name: r.Name || "", close, change,
      changePct: (change != null && prev) ? +(change / prev * 100).toFixed(2) : null,
      volumeLots: vol != null ? Math.round(vol / 1000) : null,
      pe: null, yield: null, pb: null, instLots: null
    };
  }
  if (Array.isArray(bwibbu)) for (const r of bwibbu) {
    const it = byCode[r.Code]; if (!it) continue;
    it.pe = num(pick(r, ["PEratio", "本益比"]));
    it.yield = num(pick(r, ["DividendYield", "殖利率"]));
    it.pb = num(pick(r, ["PBratio", "股價淨值比", "淨值比"]));
  }
  if (t86) for (const code in t86.byCode) {
    const it = byCode[code]; if (!it) continue;
    it.instLots = t86.byCode[code].totalLots;
  }
  let dataDate = null;
  if (Array.isArray(dayAll) && dayAll[0] && dayAll[0].Date) dataDate = anyDateToISO(dayAll[0].Date);

  const all = Object.values(byCode).filter((x) => x.close != null);
  let up = 0, down = 0, flat = 0;
  for (const x of all) { if (x.change > 0) up++; else if (x.change < 0) down++; else flat++; }

  const strip = (x) => ({ code: x.code, name: x.name, close: x.close, changePct: x.changePct,
    volumeLots: x.volumeLots, pe: x.pe, yield: x.yield, pb: x.pb, instLots: x.instLots });
  const topBy = (keyFn, filterFn) => all.filter(filterFn).sort((a, b) => keyFn(b) - keyFn(a)).slice(0, 12).map(strip);

  return {
    asOf: new Date().toISOString(),
    source: "臺灣證券交易所 OpenAPI（上市）＋ 三大法人買賣超日報",
    dataDate, instDate: t86 ? t86.date : null,
    breadth: { up, down, flat, listed: all.length },
    lists: {
      // 三大法人合計買超最多
      instBuy:   topBy((x) => x.instLots, (x) => x.instLots != null && x.instLots > 0),
      // 高殖利率（過濾極端值與無獲利者，避免資料異常）
      highYield: topBy((x) => x.yield, (x) => x.yield != null && x.yield > 0 && x.yield < 15 && x.pe != null && x.pe > 0),
      // 低本益比（要求有配息，過濾異常低 PE）
      lowPE:     all.filter((x) => x.pe != null && x.pe > 2 && x.yield != null && x.yield > 0)
                    .sort((a, b) => a.pe - b.pe).slice(0, 12).map(strip),
      // 今日強勢（過濾冷門低量股）
      strong:    topBy((x) => x.changePct, (x) => x.changePct != null && x.volumeLots != null && x.volumeLots > 500),
      // 成交爆量
      hotVolume: topBy((x) => x.volumeLots, (x) => x.volumeLots != null)
    }
  };
}

// ---- 呼叫 Claude（共用）----
// 有網路搜尋時，伺服器端搜尋迴圈到上限會回 stop_reason "pause_turn"：把目前內容原樣送回即可續跑
async function callClaude(env, payload) {
  const blocks = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let stopReason = null;
  for (let i = 0; i < 4; i++) {
    const messages = blocks.length ? payload.messages.concat([{ role: "assistant", content: blocks }]) : payload.messages;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
      body: JSON.stringify(Object.assign({}, payload, { messages }))
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error && data.error.message) || ("Anthropic " + res.status));
    if (Array.isArray(data.content)) blocks.push(...data.content);
    if (data.usage) { usage.input_tokens += data.usage.input_tokens || 0; usage.output_tokens += data.usage.output_tokens || 0; }
    stopReason = data.stop_reason || null;
    if (stopReason !== "pause_turn") break;
  }
  return { text: textOf(blocks), sources: sourcesOf(blocks), stopReason, usage };
}
// 有引用來源時，一段話會被切成好幾個 text 區塊：同一段直接接起來，遇到搜尋區塊才換段
function textOf(blocks) {
  const segs = [];
  let cur = "";
  for (const b of blocks) {
    if (b.type === "text") cur += b.text;
    else if (cur) { segs.push(cur); cur = ""; }
  }
  if (cur) segs.push(cur);
  return segs.map((s) => s.trim()).filter(Boolean).join("\n\n");
}
function sourcesOf(blocks) {
  const seen = {}, out = [];
  for (const b of blocks) {
    if (b.type !== "text" || !Array.isArray(b.citations)) continue;
    for (const c of b.citations) {
      if (!c || !/^https?:\/\//.test(c.url || "") || seen[c.url]) continue;
      seen[c.url] = 1;
      out.push({ url: c.url, title: String(c.title || c.url).slice(0, 120) });
    }
  }
  return out.slice(0, 20);
}

// ---- 研究指令（Slash Commands）----
const RESEARCH_SYS =
  "你是台股資深研究員助理，為想深入研究的一般投資人產出專業、精準但淺顯的研究內容。原則：\n" +
  "- 繁體中文、台灣慣用語；專有名詞第一次出現時用括號補一句白話。\n" +
  "- 數據紀律：我方提供的證交所／櫃買中心數據以其為準並標註日期；網路搜尋到的資訊標註來源與日期；查不到就明說「查無資料」，嚴禁編造數字。\n" +
  "- 區分「事實」與「推論」；多空並陳、保持中立；不下『一定買／一定賣』等指令式建議。\n" +
  "- 用結構化 Markdown（##標題、表格、條列），開頭不要客套話。\n" +
  "- 結尾固定加一行：本內容由 AI 彙整，僅供研究參考，不構成投資建議，投資有風險，請自行評估並為自己的決策負責。";

function compactSrv(s) {
  if (!s) return null;
  const c = { code: s.code, name: s.name, market: s.market, asOf: s.asOf, price: s.price,
    priceDate: s.priceDate || null, valuation: s.valuation, institutional: s.institutional, notes: s.notes };
  if (s.history && s.history.length) c.history = { desc: "每日收盤 [日期,收盤]", points: s.history.slice(-30).map((x) => [x.date, x.close]) };
  if (s.technical) c.technical = compactTech(s.technical);
  return c;
}
// 技術指標精簡版（給 AI 看）：只留數值與訊號文字，K 線明細不送，避免提示太長
function compactTech(t) {
  return { asOf: t.asOf, ma: t.ma, rsi14: t.rsi14, kd: t.kd, macd: t.macd, volRatio: t.volRatio,
    signals: (t.signals || []).map((x) => x.label) };
}
function cmdData(x) {
  let s = "";
  if (x.snap || x.extra) s += "\n\n【個股最新數據（證交所／櫃買中心，JSON；market 標示上市或上櫃）】\n```json\n" + JSON.stringify({ snapshot: x.snap, extra: x.extra }) + "\n```";
  if (x.screen) s += "\n\n【全市場掃描（臺灣證交所，JSON；lists 為五份榜單）】\n```json\n" + JSON.stringify(x.screen) + "\n```";
  if (x.watchTxt) s += "\n\n【使用者自選股清單】" + x.watchTxt;
  if (x.context) s += "\n\n【使用者先前建立的投資論點（原文）】\n" + x.context;
  return s;
}

const CMD = {
  "earnings-analysis": { needCode: true, web: 8, tokens: 8000, tpl: function (x) { return "指令：/earnings-analysis（財報深度研究報告）\n任務：撰寫 " + x.label + " 的完整財報研究報告，目標 3000～5000 字。\n步驟：先用網路搜尋找出最近一次財報與法說會重點（營收、毛利率、EPS、財測、管理層說法、法人問答焦點、市場預期比較），再結合下方證交所／櫃買中心數據撰寫。\n輸出結構：\n1. 標題（公司、季度、撰寫日期）＋ 3～5 點摘要結論\n2. ## 本季關鍵數字（表格，附季增/年增，查得到市場預期就比較）\n3. ## 營運亮點與隱憂\n4. ## 管理層展望與財測\n5. ## 法說會問答重點\n6. ## 估值與同業比較\n7. ## 多空論點整理\n8. ## 風險\n9. ## 後續觀察指標與時點" + cmdData(x); } },
  "initiating-coverage": { needCode: true, web: 8, tokens: 8000, tpl: function (x) { return "指令：/initiating-coverage（首次覆蓋研究報告）\n任務：對 " + x.label + " 做機構級首次覆蓋報告，依五步驟撰寫長文：\n第一步 ## 公司與商業模式：產品組合、獲利方式、主要客戶與市場（需搜尋補足）\n第二步 ## 產業結構與競爭定位：產業鏈位置、競爭對手、護城河\n第三步 ## 財務體質與成長動能：用下方數據＋搜尋，看營收趨勢、獲利能力、配息\n第四步 ## 估值：至少三種角度交叉（本益比區間、股價淨值比、殖利率法、同業比較），列出計算假設\n第五步 ## 投資論點與風險：核心論點、關鍵假設、風險與失效條件、觀察指標" + cmdData(x); } },
  "earnings": { needCode: true, web: 4, tokens: 3000, tpl: function (x) { return "指令：/earnings（快速季度財報點評）\n任務：搜尋 " + x.label + " 最新一季財報重點，結合下方數據，輸出精簡點評（500～800 字）：\n1. 一句話結論\n2. ## 關鍵數字（表格：營收/毛利率/EPS 與季增年增）\n3. ## 三個亮點\n4. ## 三個疑慮\n5. ## 下季觀察重點" + cmdData(x); } },
  "initiate": { needCode: true, web: 3, tokens: 2500, tpl: function (x) { return "指令：/initiate（首次研究流程入口）\n任務：為 " + x.label + " 產出研究起手包：\n1. ## 公司一頁概覽（是做什麼的、賺什麼錢，搜尋補足）\n2. ## 該蒐集的資料清單（依優先順序）\n3. ## 關鍵問題清單（5～8 題，回答了就能形成觀點）\n4. ## 建議的後續指令（例如 /earnings-analysis、/thesis、/catalysts，說明各自時機）" + cmdData(x); } },
  "screen": { needCode: false, screen: true, web: 0, tokens: 3500, tpl: function (x) { return "指令：/screen（股票篩選）\n使用者條件：" + (x.arg || "未指定，請從榜單中找出數據面最值得留意的標的") + "\n任務：只用下方全市場掃描數據做篩選（不要用網路資訊），輸出：\n1. ## 符合條件的標的（表格：代號/名稱/關鍵數據/上榜原因，最多 10 檔）\n2. ## 每檔一句主要風險\n3. ## 篩選限制說明（此數據只含上市股票的價格/估值/法人榜單，條件超出範圍就明說做不到）" + cmdData(x); } },
  "sector": { needArg: true, web: 5, tokens: 3500, tpl: function (x) { return "指令：/sector（產業分析報告）\n產業：" + x.arg + "\n任務：搜尋該產業近況（供需、報價、政策、龍頭動態、台廠地位），輸出精簡產業報告：\n1. ## 產業現況（一段）\n2. ## 關鍵驅動因素（3～5 點，附數據或來源）\n3. ## 台股相關公司梳理（表格：公司/代號/在產業鏈的角色/近況一句）\n4. ## 多空整理\n5. ## 風險與觀察指標"; } },
  "sector-overview": { needArg: true, web: 8, tokens: 8000, tpl: function (x) { return "指令：/sector-overview（完整產業概覽）\n產業：" + x.arg + "\n任務：搜尋撰寫完整產業概覽長文：\n1. ## 產業規模與價值鏈全景\n2. ## 全球競爭格局與台廠角色\n3. ## 需求端趨勢\n4. ## 供給端與產能\n5. ## 技術與政策變數\n6. ## 台股代表公司深度比較（表格＋各一段）\n7. ## 投資切入角度（不同風險屬性怎麼看）\n8. ## 風險\n9. ## 追蹤儀表板（該定期看哪些數據與來源）"; } },
  "thesis": { needCode: true, web: 4, tokens: 3500, tpl: function (x) { return "指令：/thesis（建立投資論點）\n任務：為 " + x.label + " 建立可被追蹤驗證的投資論點：\n1. ## 核心論點（一段講清楚）\n2. ## 三大支柱（每個支柱附支持數據或搜尋到的證據）\n3. ## 反方論點（最強的空方理由）\n4. ## 關鍵假設與驗證指標（做成表格，指標要可量化、註明去哪查）\n5. ## 失效條件（出現什麼訊號代表論點壞了）\n6. ## 時間框架與催化事件" + cmdData(x); } },
  "thesis-tracker": { needCode: true, needContext: true, web: 3, tokens: 3000, tpl: function (x) { return "指令：/thesis-tracker（論點追蹤）\n任務：使用者先前為 " + x.label + " 建立過投資論點（附於下方）。請搜尋此後的最新發展、比對下方最新數據，輸出：\n1. ## 論點健康度總評（良好／警示／受損，一句理由）\n2. ## 各支柱逐一檢視（狀態＋最新證據）\n3. ## 假設驗證表（原假設 vs 目前狀況）\n4. ## 是否觸發失效條件\n5. ## 建議更新的內容" + cmdData(x); } },
  "catalysts": { needCode: true, web: 5, tokens: 3000, tpl: function (x) { return "指令：/catalysts（催化事件）\n任務：搜尋並列出 " + x.label + " 未來 1～6 個月可能影響股價的事件：財報／法說會日期、除權息、新品或擴產、大客戶與訂單、產業事件、政策。日期不確定就標「日期未定」，嚴禁編造日期。\n輸出：\n1. ## 催化事件表（日期/事件/預期影響方向/重要度 高中低/依據來源）\n2. ## 最該優先關注的兩件事與原因" + cmdData(x); } },
  "catalyst-calendar": { needWatch: true, web: 6, tokens: 3500, tpl: function (x) { return "指令：/catalyst-calendar（自選股催化行事曆）\n任務：為下方自選股清單的每一檔搜尋未來催化事件（財報法說、除權息、產品與訂單、產業與政策），彙整成一份行事曆。日期不確定標「日期未定」，嚴禁編造。\n輸出：\n1. ## 事件行事曆（依日期排序的表格：日期/股票/事件/預期影響/重要度）\n2. ## 本月最該盯的三件事\n3. ## 查無近期事件的股票清單" + cmdData(x); } },
  "earnings-preview": { needCode: true, web: 5, tokens: 3000, tpl: function (x) { return "指令：/earnings-preview（財報前瞻）\n任務：為 " + x.label + " 做財報公布前的預覽。先搜尋財報／法說會的公布時間與市場預期，再結合下方數據輸出：\n1. ## 公布時間（查不到就說明推測依據）\n2. ## 市場預期與關鍵數字（共識營收/EPS，查得到才寫）\n3. ## 三個最該關注的指標與原因\n4. ## 可能的驚喜與地雷\n5. ## 財報後劇本（優於/符合/低於預期時，各自該觀察什麼）" + cmdData(x); } },
  "idea-generation": { needCode: false, screen: true, web: 5, tokens: 3500, tpl: function (x) { return "指令：/idea-generation（投資點子產生）\n主題：" + (x.arg || "未指定，請從下方全市場掃描數據找數據面異常或值得研究的方向") + "\n任務：結合下方掃描數據與網路搜尋，產出 3～5 個「研究點子」（不是建議）：\n每個點子包含：## 標的或主題 → 一句論點 → 支持數據（引用實際數字）→ 主要風險 → 下一步驗證方法。\n最後加 ## 提醒：這些是研究起點，需要進一步查證。" + cmdData(x); } },
  "model-update": { needCode: true, web: 2, tokens: 3000, tpl: function (x) { return "指令：/model-update（估值模型更新）\n任務：用下方最新數據為 " + x.label + " 更新簡易估值模型，列出所有計算過程：\n1. ## 模型輸入更新摘要（現價/EPS/月營收動能/股利/PE/PB，標日期）\n2. ## 目前估值位置（目前 PE、PB、殖利率，與合理區間的推估比較；歷史區間查不到就用產業常識推估並註明）\n3. ## 三情境合理價區間（保守/基準/樂觀：各自假設的 EPS 與倍數，算出區間）\n4. ## 與現價的隱含空間（各情境 %）\n5. ## 模型的限制與該補的資料" + cmdData(x); } },
  "morning-note": { needCode: false, screen: true, web: 6, tokens: 3500, tpl: function (x) { return "指令：/morning-note（台股晨報）\n任務：整理一份台股盤前晨報。先搜尋近 24 小時重要消息（美股收盤與科技股、半導體產業、影響台股的國際與政策新聞、自選股個股新聞），結合下方大盤與掃描數據，輸出：\n1. ## 今日盤前三重點（一句一點）\n2. ## 國際市場與大盤回顧（附數字）\n3. ## 自選股速覽（每檔一句最新狀況；沒消息就寫「無重大消息」）\n4. ## 今日觀察清單（事件與數據）\n5. ## 風險提示（一兩句）\n風格：像晨會紀要，精簡可讀。" + cmdData(x); } }
};

async function runCommand(env, body) {
  const cmdName = String(body.command || "").toLowerCase();
  const def = CMD[cmdName];
  if (!def) throw new Error("未知的指令：" + cmdName);
  const code = (body.code || "").toString().trim().toUpperCase();
  const arg = (body.arg || "").toString().slice(0, 200).trim();
  const context = (body.context || "").toString().slice(0, 9000);
  const watchlist = Array.isArray(body.watchlist) ? body.watchlist.slice(0, 20) : [];
  if (def.needCode && !/^\d{4,6}[A-Z]?$/.test(code)) throw new Error("此指令需要有效的股票代號");
  if (def.needArg && !arg) throw new Error("此指令需要輸入主題（例如產業名稱）");
  if (def.needContext && !context) throw new Error("找不到先前的投資論點，請先執行 /thesis");
  if (def.needWatch && !watchlist.length) throw new Error("此指令需要自選股清單，請先加入自選股");

  let snap = null, extra = null, screen = null;
  if (def.needCode) {
    // 上市／上櫃只判斷一次，行情與基本面共用（結果一致，也少抓一次上市收盤檔）
    const rtP = fetchRealtime(code).catch(() => null);
    const mkP = marketOf(code, rtP);
    const pair = await Promise.all([buildSnapshot(code, mkP, rtP).catch(() => null), buildExtra(code, mkP).catch(() => null)]);
    snap = compactSrv(pair[0]); extra = pair[1];
    if (extra) { delete extra.notes; }
  }
  if (def.screen) screen = await buildScreen().catch(() => null);
  const nm = (snap && snap.name) || (body.name || "").toString() || "";
  const label = nm ? (nm + "（" + code + "）") : code;
  const watchTxt = watchlist.map((s) => (s.n ? s.n + "（" + s.c + "）" : s.c)).join("、");

  const userMsg = def.tpl({ label, code, arg, context, snap, extra, screen, watchTxt: (def.needWatch || cmdName === "morning-note") ? (watchTxt || "（無自選股）") : "" });

  const payload = {
    model: ANTHROPIC_MODEL,
    max_tokens: def.tokens,
    system: RESEARCH_SYS,
    messages: [{ role: "user", content: userMsg }]
  };
  if (def.web) payload.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: def.web }];

  const r = await callClaude(env, payload);
  return { text: r.text, sources: r.sources, truncated: r.stopReason === "max_tokens",
    command: cmdName, code: def.needCode ? code : null, name: nm || null, model: ANTHROPIC_MODEL, usage: r.usage };
}

// ---- 呼叫 Claude 做分析 ----
async function analyze(env, body) {
  const code = (body.code || "").toString();
  const name = (body.name || "").toString();
  const scenario = (body.scenario || "overview").toString();
  const snapshot = body.snapshot || null;

  const SCEN = {
    overview:  "綜合研判（技術面、基本面、籌碼面）",
    technical: "技術面走勢（近期價格、均線、RSI／KD／MACD、量能、支撐與壓力）",
    chips:     "法人籌碼（三大法人買賣超與資金流向）",
    dividend:  "股利與殖利率（配息、殖利率、除權息）",
    value:     "價值評估（本益比、股價淨值比、EPS、營收）",
    market_scan: "全市場雷達（跨榜單挑出值得留意的觀察標的）"
  };
  const focus = SCEN[scenario] || SCEN.overview;

  const system =
    "你是專業、精準的台股分析助理，服務對象是想快速看懂個股的一般投資人。\n" +
    "我已經先幫你抓好『臺灣證券交易所／證券櫃檯買賣中心公開資料』的最新數據（market 欄位標示上市或上櫃），直接放在使用者訊息裡。請【以這些數字為主】做分析，不要自行編造或用印象填補；資料裡沒有的就明說沒有，不要臆測。\n" +
    "輸出用繁體中文、台灣慣用語，語氣淺顯易懂（必須用到專有名詞時用括號補一句白話）。用精簡的結構化 Markdown：\n" +
    "1. 開頭一到兩句「結論」。\n" +
    "2. 「## 關鍵數據」：引用我給你的數字並標明日期。\n" +
    "3. 針對指定分析角度的重點解讀，偏多與偏空並陳。\n" +
    "4. 「## 風險提醒」。\n" +
    "保持中立客觀，只做分析與說明，不要下『一定要買』或『一定要賣』這類指令式建議。結尾加一行：本分析僅供參考，投資有風險，請自行評估並為自己的決策負責。";

  let userMsg;
  if (scenario === "market_scan") {
    userMsg =
      "任務：台股市場雷達解讀（進場前的觀察名單）\n\n" +
      "以下是剛從證交所掃描的上市全市場數據（JSON），含漲跌家數與五份榜單：三大法人買超、高殖利率、低本益比、今日強勢、成交爆量。榜單內每筆資料的欄位格式請見 legend：\n```json\n" +
      JSON.stringify(snapshot) + "\n```\n\n" +
      "請輸出：\n" +
      "1. 開頭一到兩句用漲跌家數總結今日盤面氣氛。\n" +
      "2. 「## 值得留意」：跨不同榜單挑 3 到 5 檔，每檔一行，說明它上榜的數據亮點（引用實際數字）。優先挑「同時出現在多份榜單」或「數據特別突出」者。\n" +
      "3. 「## 對應要留意的風險」：對上面每一檔各提一點。\n" +
      "4. 「## 整體提醒」。\n" +
      "只做觀察與依據說明，不指示買賣；這是觀察名單，不是進場名單。";
  } else {
    // 前端只送最近 30 筆走勢；這裡再擋一次，避免舊版或異常請求把整段歷史塞進提示
    const h = snapshot && snapshot.history;
    if (h && Array.isArray(h.points) && h.points.length > 30) h.points = h.points.slice(-30);
    else if (Array.isArray(h) && h.length > 30) snapshot.history = h.slice(-30);
    userMsg =
      "股票：" + (name ? (name + "（" + code + "）") : code) + "\n" +
      "分析角度：" + focus + "\n\n" +
      "以下是剛抓取的證交所／櫃買中心資料（JSON）。price／valuation／institutional／history 為行情、估值、三大法人與走勢；" +
      "technical（若有）為依每日行情算好的技術指標（均線、RSI、KD、MACD、量比與訊號），技術面請直接引用這些數值、不要自行重算；" +
      "extra（若有）為月營收、最新季 EPS、股利、融資融券、外資持股、重大訊息與大盤：\n```json\n" + JSON.stringify(snapshot, null, 2) + "\n```\n\n" +
      "請根據上面的數據，產出精簡、精準的分析。";
  }

  const r = await callClaude(env, {
    model: ANTHROPIC_MODEL,
    max_tokens: ANALYSIS_MAX_TOKENS,
    system: system,
    messages: [{ role: "user", content: userMsg }]
  });
  return { text: r.text, model: ANTHROPIC_MODEL, usage: r.usage };
}

// ---- 自選股新聞彙整（Claude + 網路搜尋）----
async function newsDigest(env, body) {
  const stocks = Array.isArray(body.stocks) ? body.stocks.slice(0, 12) : [];
  if (!stocks.length) throw new Error("沒有提供自選股清單");
  const listTxt = stocks.map((s) => (s.n ? s.n + "（" + s.c + "）" : s.c)).join("、");

  const system =
    "你是台股新聞彙整助理，使用網路搜尋查詢每一檔股票的近期新聞（以最近一週為主，重大事件可放寬到一個月）。\n" +
    "輸出規則：\n" +
    "- 繁體中文、台灣慣用語，淺顯易懂。\n" +
    "- Markdown 格式：每檔股票一個「## 公司名（代號）」小節，底下 1 到 3 條列，每條一句話講重點，句尾用括號標註來源媒體與日期。\n" +
    "- 消息要區分事實與市場傳聞；查不到近期新聞就寫「近期無重大新聞」，不要編造。\n" +
    "- 保持中立，只整理消息，不加任何買賣建議。開頭不要客套話，直接輸出第一個小節。";

  const userMsg = "我的自選股：" + listTxt + "。\n請搜尋並彙整每一檔的最新新聞近況。";

  const r = await callClaude(env, {
    model: ANTHROPIC_MODEL,
    max_tokens: 2500,
    system: system,
    messages: [{ role: "user", content: userMsg }],
    tools: [{ type: "web_search_20250305", name: "web_search" }]
  });
  return { text: r.text, sources: r.sources, model: ANTHROPIC_MODEL };
}

// ---- 資料源健康檢查（/api/debug）----
const RWD_SOURCES = { t86: fetchT86, qfiis: fetchQFIIS };

const NO_DATA = "近 10 個交易日都查無資料，或連線受限";

// code＝上市檢查用代號、otcCode＝上櫃檢查用代號
async function sourceStatus(code, otcCode) {
  const timed = async (name, fn) => {
    const t0 = Date.now();
    try {
      const info = await fn();
      return Object.assign({ name, ok: !!(info && info.ok !== false) }, info, { ms: Date.now() - t0 });
    } catch (e) {
      return { name, ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 };
    }
  };
  const openapiCheck = (prefix, keys, fetchKey) => keys.map((k) => timed(prefix + k, async () => {
    const j = await fetchKey(k, 600);
    if (!Array.isArray(j)) return { ok: false, error: "回傳格式不是陣列" };
    const r0 = j[0] || {};
    const d = pick(r0, ["Date", "出表日期"]);
    // 重大訊息當天沒有公告時本來就可能是空陣列
    return { ok: j.length > 0 || k === "news", rows: j.length, date: d ? anyDateToISO(d) : null };
  }));
  const instCheck = (name, fn, c) => timed(name, async () => {
    const r = await fn();
    if (!r) return { ok: false, error: NO_DATA };
    return { rows: Object.keys(r.byCode).length, date: r.date, hasCode: !!r.byCode[c] };
  });
  const rtCheck = (c) => timed("mis:realtime(" + c + ")", async () => {
    const rt = await fetchRealtime(c);
    // 盤前／休市沒有即時成交是正常的，不算失敗
    return rt ? { date: rt.date, time: rt.time, close: rt.close } : { ok: true, note: "目前沒有當盤成交（盤前或休市屬正常）" };
  });

  // 上市（證交所）
  const twse = openapiCheck("openapi:", Object.keys(OPENAPI), oa);
  for (const k of Object.keys(RWD_SOURCES)) twse.push(instCheck("rwd:" + k, RWD_SOURCES[k], code));
  twse.push(timed("rwd:stockDay(" + code + ")", async () => {
    const h = await fetchHistory(code);
    return { ok: h.length > 0, rows: h.length, date: h.length ? h[h.length - 1].date : null };
  }));
  twse.push(rtCheck(code));
  // 上櫃（櫃買中心）
  const tpex = openapiCheck("tpex:openapi:", Object.keys(TPEX_OPENAPI).filter((k) => k !== "pe"), tpOa);
  tpex.push(timed("tpex:pe", async () => {
    const r = await fetchTpexPe();
    if (!r) return { ok: false, error: "OpenAPI 與網站端點都抓不到" };
    return { source: r.source, rows: Object.keys(r.byCode).length, date: r.date || null, hasCode: !!r.byCode[otcCode] };
  }));
  tpex.push(instCheck("tpex:www:inst", fetchTpexInst, otcCode));
  tpex.push(timed("tpex:www:tradingStock(" + otcCode + ")", async () => {
    const h = (await fetchTpexHistory(otcCode)).rows;
    return { ok: h.length > 0, rows: h.length, date: h.length ? h[h.length - 1].date : null };
  }));
  tpex.push(rtCheck(otcCode));

  const [a, b] = await Promise.all([Promise.all(twse), Promise.all(tpex)]);
  const twseOk = a.every((s) => s.ok), tpexOk = b.every((s) => s.ok);
  return { ok: twseOk && tpexOk, twseOk, tpexOk, code, otcCode, checkedAt: new Date().toISOString(), sources: a.concat(b) };
}

// /api/debug?ds=t86&code=2330 → 看欄位名稱與該代號那一列原始資料（欄位改版時用）
async function sourceSample(ds, code) {
  if (OPENAPI[ds] || (ds.indexOf("tp_") === 0 && TPEX_OPENAPI[ds.slice(3)])) {
    const j = OPENAPI[ds] ? await oa(ds, 60) : await tpOa(ds.slice(3), 60);
    if (!Array.isArray(j)) return { error: "fetch failed", type: typeof j };
    return { ds, rows: j.length, keys: j[0] ? Object.keys(j[0]) : [], sample: j.find((x) => codeOf(x) === code) || null };
  }
  if (ds === "t86" || ds === "qfiis") {
    const r = await twseLatest(ds === "t86" ? "fund/T86" : "fund/MI_QFIIS", { selectType: "ALLBUT0999" });
    if (!r) return { ds, error: NO_DATA };
    return { ds, date: r.date, rows: r.data.length, fields: r.fields,
      sample: r.data.find((row) => String(row[0] || "").trim() === code) || null, parsed: (await RWD_SOURCES[ds]() || { byCode: {} }).byCode[code] || null };
  }
  if (ds === "tpexPe") {
    const r = await fetchTpexPe();
    return r ? { ds, source: r.source, date: r.date || null, rows: Object.keys(r.byCode).length, parsed: r.byCode[code] || null } : { ds, error: NO_DATA };
  }
  if (ds === "tpexInst") {
    const r = await tpexLatest("insti/dailyTrade", { type: "Daily", sect: "EW" });
    if (!r) return { ds, error: NO_DATA };
    return { ds, date: r.date, rows: r.data.length, fields: r.fields,
      sample: r.data.find((row) => String(row[0] || "").trim() === code) || null, parsed: ((await fetchTpexInst()) || { byCode: {} }).byCode[code] || null };
  }
  if (ds === "stockDay") return { ds, history: await fetchHistory(code) };
  if (ds === "tpexDay") return { ds, history: await fetchTpexHistory(code) };
  if (ds === "realtime") return { ds, realtime: await fetchRealtime(code) };
  return { error: "ds 可用值：" + Object.keys(OPENAPI).concat(Object.keys(TPEX_OPENAPI).map((k) => "tp_" + k),
    ["t86", "qfiis", "tpexPe", "tpexInst", "stockDay", "tpexDay", "realtime"]).join("|") };
}

// ---- 路由 ----
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/stock") {
        const code = (url.searchParams.get("code") || "").trim().toUpperCase();
        if (!/^\d{4,6}[A-Z]?$/.test(code)) return json({ error: "請提供有效的股票代號（例如 2330）" }, 400);
        return json(await buildSnapshot(code));
      }

      if (url.pathname === "/api/quotes") {
        const p = parseCodes(url.searchParams.get("codes"));
        if (p.error) return json({ error: p.error }, 400);
        return json(await fetchQuotes(p.codes));
      }

      if (url.pathname === "/api/screen") {
        return json(await buildScreen());
      }

      if (url.pathname === "/api/extra") {
        const code = (url.searchParams.get("code") || "").trim().toUpperCase();
        if (!/^\d{4,6}[A-Z]?$/.test(code)) return json({ error: "請提供有效的股票代號（例如 2330）" }, 400);
        return json(await buildExtra(code));
      }

      if (url.pathname === "/api/command" && request.method === "POST") {
        if (!env.ANTHROPIC_API_KEY) return json({ error: "伺服器尚未設定 ANTHROPIC_API_KEY 密鑰" }, 500);
        const body = await request.json().catch(() => ({}));
        return json(await runCommand(env, body));
      }

      if (url.pathname === "/api/debug") {
        const ds = url.searchParams.get("ds") || "";
        const dcode = (url.searchParams.get("code") || "2330").trim().toUpperCase();
        const ocode = (url.searchParams.get("otc") || "6488").trim().toUpperCase();
        if (!/^\d{4,6}[A-Z]?$/.test(dcode) || !/^\d{4,6}[A-Z]?$/.test(ocode)) return json({ error: "請提供有效的股票代號（例如 2330）" }, 400);
        if (!ds) return json(await sourceStatus(dcode, ocode));
        // 上櫃樣本（tp_*、tpexInst、tpexDay）沒指定 code 時改用 otc 代號
        const tpexDs = ds.indexOf("tp_") === 0 || ds.indexOf("tpex") === 0;
        return json(await sourceSample(ds, tpexDs && !url.searchParams.get("code") ? ocode : dcode));
      }

      if (url.pathname === "/api/analyze" && request.method === "POST") {
        if (!env.ANTHROPIC_API_KEY) return json({ error: "伺服器尚未設定 ANTHROPIC_API_KEY 密鑰" }, 500);
        const body = await request.json().catch(() => ({}));
        return json(await analyze(env, body));
      }

      if (url.pathname === "/api/news" && request.method === "POST") {
        if (!env.ANTHROPIC_API_KEY) return json({ error: "伺服器尚未設定 ANTHROPIC_API_KEY 密鑰" }, 500);
        const body = await request.json().catch(() => ({}));
        return json(await newsDigest(env, body));
      }

      if (url.pathname === "/" || url.pathname === "/api") {
        return json({ name: "台股天際線 API", routes: ["GET /api/stock?code=2330", "GET /api/extra?code=2330", "GET /api/quotes?codes=2330,6488,0050", "GET /api/screen", "GET /api/debug[?code=2330&otc=6488 | ?ds=t86&code=2330]", "POST /api/analyze", "POST /api/news", "POST /api/command"] });
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  }
};
