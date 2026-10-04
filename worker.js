/**
 * 台股天際線 · 後端 Worker (Cloudflare Workers)
 * ------------------------------------------------------------------
 * 路由：
 *   GET  /api/stock?code=2330   → 行情＋估值＋三大法人＋近兩月走勢（秒讀）
 *   GET  /api/extra?code=2330   → 基本面與籌碼：月營收、季 EPS、股利、融資融券、外資持股、重大訊息、大盤
 *   GET  /api/screen            → 全市場掃描（市場雷達五份榜單）
 *   GET  /api/debug             → 逐一檢查每個證交所資料源是否正常（部署後先打這支確認）
 *   POST /api/analyze | /api/news | /api/command → 呼叫 Claude
 *
 * 證交所資料來源：
 *   - OpenAPI（openapi.twse.com.tw/v1）：每日收盤、估值、月營收、EPS、股利、融資融券、重大訊息、大盤
 *   - 證交所網站 RWD 端點（www.twse.com.tw/rwd/zh）：OpenAPI 沒提供的「三大法人 T86」「外資持股 MI_QFIIS」
 *     與「個股日成交 STOCK_DAY」。這組端點有頻率限制（約每 5 秒 3 次），所以全部加了快取與交易日回推。
 *   - 即時行情（mis.twse.com.tw）：盤中約 5 秒延遲的快照
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
function pick(obj, patterns) {
  const keys = Object.keys(obj || {});
  for (const p of patterns) {
    const k = keys.find((k) => k.indexOf(p) !== -1);
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

// ---- 同一個 Worker 實例內的記憶體快取（合併同時發出的請求，也減少打到證交所的次數）----
const MEMO = new Map();
function memo(key, ttlSec, fn) {
  const now = Date.now(), hit = MEMO.get(key);
  if (hit && hit.exp > now) return hit.p;
  if (MEMO.size > 400) for (const [k, v] of MEMO) if (v.exp <= now) MEMO.delete(k);
  const p = Promise.resolve().then(fn);
  MEMO.set(key, { p, exp: now + ttlSec * 1000 });
  const drop = () => { const cur = MEMO.get(key); if (cur && cur.p === p) MEMO.delete(key); };
  p.then((v) => { if (v == null) drop(); }, drop);
  return p;
}

// ---- 抓證交所資料（伺服器端 + Cloudflare 邊緣快取）----
const FETCH_TIMEOUT_MS = 12000;
// www.twse.com.tw 約每 5 秒 3 次就可能暫時封鎖 IP：同一實例內把請求錯開，避免冷快取時一次爆量
const WWW_GAP_MS = 450;
let wwwNext = 0;
async function wwwSlot() {
  const now = Date.now(), at = Math.max(now, wwwNext);
  wwwNext = at + WWW_GAP_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}
function twFetch(u, ttl) {
  return memo(u, ttl || 600, async () => {
    if (u.indexOf("https://www.twse.com.tw/") === 0) await wwwSlot();
    const res = await fetch(u, {
      headers: { "User-Agent": UA, "Accept": "application/json" },
      cf: { cacheTtl: ttl || 600, cacheEverything: true },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error("TWSE " + res.status + " " + new URL(u).pathname);
    // 被限流時證交所會回 HTML 而不是 JSON
    return res.json().catch(() => { throw new Error("TWSE 回傳非 JSON（可能被限流）" + new URL(u).pathname); });
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

// 盤後資料約 15:00 後公布：從最近一個交易日往回找（跳過週末；遇連假多試幾天）
async function twseLatest(path, params) {
  const now = twNow(), today = ymdOf(now);
  const d = new Date(now.getTime());
  if (now.getUTCHours() < 15) d.setUTCDate(d.getUTCDate() - 1);
  for (let tries = 0, guard = 0; tries < 5 && guard < 12; guard++, d.setUTCDate(d.getUTCDate() - 1)) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const ymd = ymdOf(d);
    let r;
    try { r = await twseRwd(path, Object.assign({ date: ymd }, params), ymd === today ? 300 : 43200); }
    catch (e) { return null; } // 連線失敗或被限流就停，不要繼續狂打
    if (r) return Object.assign(r, { date: r.date || anyDateToISO(ymd) });
    tries++;
  }
  return null;
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

// ---- 盤中／當日即時快照（TWSE MIS，約 5 秒延遲）----
async function fetchRealtime(code) {
  const urls = [
    "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_" + code + ".tw&json=1&delay=0",
    "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=otc_" + code + ".tw&json=1&delay=0"
  ];
  for (const u of urls) {
    try {
      const res = await fetch(u, {
        headers: {
          "User-Agent": UA,
          "Accept": "application/json",
          "Referer": "https://mis.twse.com.tw/stock/index.jsp"
        },
        cf: { cacheTtl: 30, cacheEverything: true }
      });
      if (!res.ok) continue;
      const j = await res.json().catch(() => null);
      const m = j && Array.isArray(j.msgArray) && j.msgArray[0];
      if (!m || !m.c) continue;
      const y = num(m.y);
      let z = num(m.z), approx = false;
      // 這 5 秒內剛好沒成交時 z 會是 "-"：開盤後改用最佳買價（沒有就最佳賣價）暫代
      if (z == null && num(m.o) != null) {
        const first = (s) => num(String(s || "").split("_")[0]);
        z = first(m.b);
        if (z == null) z = first(m.a);
        approx = z != null;
      }
      if (z == null) continue; // 尚無當盤成交（如未開盤），交給收盤資料處理
      const iso = anyDateToISO(m.d) || null;
      return {
        name: m.n || null,
        market: m.ex === "otc" ? "上櫃 (TPEx)" : "上市 (TWSE)",
        date: /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null, time: m.t || null, approx,
        close: z, open: num(m.o), high: num(m.h), low: num(m.l),
        prevClose: y,
        change: y != null ? +(z - y).toFixed(2) : null,
        changePct: (y != null && y !== 0) ? +((z - y) / y * 100).toFixed(2) : null,
        volumeLots: num(m.v)
      };
    } catch (e) { /* 換下一個來源 */ }
  }
  return null;
}

async function fetchHistory(code) {
  // 抓「上月 + 當月」個股日成交，取收盤序列（給走勢圖與技術分析用）
  const now = twNow();
  const months = [
    { ymd: ymdOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))), ttl: 43200 }, // 上月已定案，快取久一點
    { ymd: ymdOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))), ttl: 1800 }
  ];
  let rows = [];
  for (const m of months) {
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
    for (const d of r.data) {
      // d: [日期, 成交股數, 成交金額, 開盤, 最高, 最低, 收盤, 漲跌價差, 成交筆數]
      const close = num(d[6]);
      const vol = num(d[1]);
      if (close != null) rows.push({ date: rocToISO(d[0]), close, volumeLots: vol != null ? Math.round(vol / 1000) : null });
    }
  }
  const seen = {};
  rows = rows.filter((x) => (seen[x.date] ? false : (seen[x.date] = 1)));
  return rows.slice(-40);
}

async function buildSnapshot(code) {
  const [dayAll, bwibbu, t86, hist, rt] = await Promise.all([
    oa("dayAll", 600).catch(() => null),
    oa("bwibbu", 600).catch(() => null),
    fetchT86().catch(() => null),
    fetchHistory(code).catch(() => null),
    fetchRealtime(code).catch(() => null)
  ]);

  const snap = {
    code, name: null, market: "上市 (TWSE)", asOf: new Date().toISOString(),
    source: "臺灣證券交易所 OpenAPI", price: null, priceDate: null, priceLabel: null, priceTime: null,
    valuation: null, institutional: null, history: null, notes: []
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
  // 盤中／當日即時快照優先（解決全市場收盤檔更新延遲的問題）
  if (rt && rt.close != null) {
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
    snap.source = "臺灣證券交易所 OpenAPI ＋ 即時行情快照";
    if (rt.approx) snap.notes.push("最近 5 秒內沒有成交，現價暫以最佳買價（或賣價）顯示。");
  }

  if (!snap.price) snap.notes.push("查無此代號的上市每日收盤資料（可能為上櫃／興櫃，或當日非交易日）。");

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

  // 盤中／今日即時價還沒進日成交檔：補到走勢最後一點，讓走勢圖與技術面看到今天
  if (hist && rt && rt.date && rt.close != null) {
    const last = hist[hist.length - 1];
    if (!last || last.date < rt.date) hist.push({ date: rt.date, close: rt.close, volumeLots: rt.volumeLots, live: true });
  }

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
function codeOf(r) { return String(r.Code || r["公司代號"] || r["證券代號"] || r["股票代號"] || "").trim(); }

async function buildExtra(code) {
  const [basic, rev, fin, div, margn, qfiis, qfii20, news, mkt] = await Promise.all([
    oa("basic", 3600).catch(() => null),
    oa("rev", 3600).catch(() => null),
    oa("fin", 3600).catch(() => null),
    oa("div", 3600).catch(() => null),
    oa("margn", 1800).catch(() => null),
    fetchQFIIS().catch(() => null),
    oa("qfii20", 1800).catch(() => null),
    oa("news", 600).catch(() => null),
    oa("mkt", 1800).catch(() => null)
  ]);
  const out = { code, asOf: new Date().toISOString(),
    source: "臺灣證券交易所 OpenAPI（基本資料／月營收／季報／股利／信用交易／重大訊息／大盤）＋ 證交所外資持股統計",
    profile: null, monthlyRevenue: null, quarterly: null, dividend: null,
    margin: null, foreign: null, announcements: null, marketIndex: null, notes: [] };

  // 公司基本資料 → 產業別、股本
  if (Array.isArray(basic)) {
    const r = basic.find((x) => codeOf(x) === code);
    if (r) {
      const shares = num(pick(r, ["已發行普通股數"]));
      const capital = num(pick(r, ["實收資本額"]));
      out.profile = {
        industry: INDUSTRY[String(pick(r, ["產業別"]) || "").trim()] || null,
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
      const mb = num(pick(r, ["MarginBalanceToday", "融資今日餘額", "TodayBalance", "MarginBalance"]));
      const mp = num(pick(r, ["MarginBalancePreviousDay", "融資前日餘額", "PreviousDayBalance"]));
      const sb = num(pick(r, ["ShortBalanceToday", "融券今日餘額", "ShortBalance"]));
      out.margin = {
        unit: "張",
        marginBalanceLots: mb,
        marginChangeLots: (mb != null && mp != null) ? mb - mp : null,
        shortBalanceLots: sb
      };
    }
  }
  // 外資及陸資持股比率（%）：完整名單優先，抓不到再看 OpenAPI 前 20 名
  if (qfiis && qfiis.byCode[code]) {
    out.foreign = Object.assign({ date: qfiis.date }, qfiis.byCode[code]);
  } else if (Array.isArray(qfii20)) {
    const r = qfii20.find((x) => codeOf(x) === code);
    if (r) out.foreign = { holdingPct: num(pick(r, ["全體外資及陸資持股比率", "外資及陸資持股比率", "持股比率", "Shareholding"])) };
  }
  if (!out.foreign && !qfiis) out.notes.push("外資持股資料暫時無法取得（證交所尚未公布或連線受限）。");
  // 當日重大訊息（最多 3 則）
  if (Array.isArray(news)) {
    const rows = news.filter((x) => codeOf(x) === code);
    if (rows.length) {
      out.announcements = rows.slice(-3).reverse().map((r) => ({
        date: anyDateToISO(pick(r, ["發言日期"])),
        subject: String(pick(r, ["主旨"]) || "").trim().slice(0, 80)
      }));
    }
  }
  // 大盤（加權指數）最新一日
  if (Array.isArray(mkt) && mkt.length) {
    const r = mkt[mkt.length - 1];
    out.marketIndex = {
      date: anyDateToISO(pick(r, ["Date", "日期"])),
      index: num(pick(r, ["TAIEX", "發行量加權股價指數"])),
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

// ---- 研究指令（Slash Commands）----
const RESEARCH_SYS =
  "你是台股資深研究員助理，為想深入研究的一般投資人產出專業、精準但淺顯的研究內容。原則：\n" +
  "- 繁體中文、台灣慣用語；專有名詞第一次出現時用括號補一句白話。\n" +
  "- 數據紀律：我方提供的證交所數據以其為準並標註日期；網路搜尋到的資訊標註來源與日期；查不到就明說「查無資料」，嚴禁編造數字。\n" +
  "- 區分「事實」與「推論」；多空並陳、保持中立；不下『一定買／一定賣』等指令式建議。\n" +
  "- 用結構化 Markdown（##標題、表格、條列），開頭不要客套話。\n" +
  "- 結尾固定加一行：本內容由 AI 彙整，僅供研究參考，不構成投資建議，投資有風險，請自行評估並為自己的決策負責。";

function compactSrv(s) {
  if (!s) return null;
  const c = { code: s.code, name: s.name, market: s.market, asOf: s.asOf, price: s.price,
    priceDate: s.priceDate || null, valuation: s.valuation, institutional: s.institutional, notes: s.notes };
  if (s.history && s.history.length) c.history = { desc: "每日收盤 [日期,收盤]", points: s.history.slice(-30).map((x) => [x.date, x.close]) };
  return c;
}
function cmdData(x) {
  let s = "";
  if (x.snap || x.extra) s += "\n\n【個股最新數據（臺灣證交所，JSON）】\n```json\n" + JSON.stringify({ snapshot: x.snap, extra: x.extra }) + "\n```";
  if (x.screen) s += "\n\n【全市場掃描（臺灣證交所，JSON；lists 為五份榜單）】\n```json\n" + JSON.stringify(x.screen) + "\n```";
  if (x.watchTxt) s += "\n\n【使用者自選股清單】" + x.watchTxt;
  if (x.context) s += "\n\n【使用者先前建立的投資論點（原文）】\n" + x.context;
  return s;
}

const CMD = {
  "earnings-analysis": { needCode: true, web: 8, tokens: 8000, tpl: function (x) { return "指令：/earnings-analysis（財報深度研究報告）\n任務：撰寫 " + x.label + " 的完整財報研究報告，目標 3000～5000 字。\n步驟：先用網路搜尋找出最近一次財報與法說會重點（營收、毛利率、EPS、財測、管理層說法、法人問答焦點、市場預期比較），再結合下方證交所數據撰寫。\n輸出結構：\n1. 標題（公司、季度、撰寫日期）＋ 3～5 點摘要結論\n2. ## 本季關鍵數字（表格，附季增/年增，查得到市場預期就比較）\n3. ## 營運亮點與隱憂\n4. ## 管理層展望與財測\n5. ## 法說會問答重點\n6. ## 估值與同業比較\n7. ## 多空論點整理\n8. ## 風險\n9. ## 後續觀察指標與時點" + cmdData(x); } },
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
    const pair = await Promise.all([buildSnapshot(code).catch(() => null), buildExtra(code).catch(() => null)]);
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

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || ("Anthropic " + res.status);
    throw new Error(msg);
  }
  const text = Array.isArray(data.content)
    ? data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim()
    : "";
  return { text, command: cmdName, model: ANTHROPIC_MODEL, usage: data.usage || null };
}

// ---- 呼叫 Claude 做分析 ----
async function analyze(env, body) {
  const code = (body.code || "").toString();
  const name = (body.name || "").toString();
  const scenario = (body.scenario || "overview").toString();
  const snapshot = body.snapshot || null;

  const SCEN = {
    overview:  "綜合研判（技術面、基本面、籌碼面）",
    technical: "技術面走勢（近期價格、均線、量能、支撐與壓力）",
    chips:     "法人籌碼（三大法人買賣超與資金流向）",
    dividend:  "股利與殖利率（配息、殖利率、除權息）",
    value:     "價值評估（本益比、股價淨值比、EPS、營收）",
    market_scan: "全市場雷達（跨榜單挑出值得留意的觀察標的）"
  };
  const focus = SCEN[scenario] || SCEN.overview;

  const system =
    "你是專業、精準的台股分析助理，服務對象是想快速看懂個股的一般投資人。\n" +
    "我已經先幫你抓好『臺灣證券交易所公開資料』的最新數據，直接放在使用者訊息裡。請【以這些數字為主】做分析，不要自行編造或用印象填補；資料裡沒有的就明說沒有，不要臆測。\n" +
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
    userMsg =
      "股票：" + (name ? (name + "（" + code + "）") : code) + "\n" +
      "分析角度：" + focus + "\n\n" +
      "以下是剛抓取的證交所資料（JSON）。price／valuation／institutional／history 為行情、估值、三大法人與走勢；" +
      "extra（若有）為月營收、最新季 EPS、股利、融資融券、外資持股、重大訊息與大盤：\n```json\n" + JSON.stringify(snapshot, null, 2) + "\n```\n\n" +
      "請根據上面的數據，產出精簡、精準的分析。";
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: ANALYSIS_MAX_TOKENS,
      system: system,
      messages: [{ role: "user", content: userMsg }]
    })
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || ("Anthropic " + res.status);
    throw new Error(msg);
  }
  const text = Array.isArray(data.content)
    ? data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim()
    : "";
  return { text, model: ANTHROPIC_MODEL, usage: data.usage || null };
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

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2500,
      system: system,
      messages: [{ role: "user", content: userMsg }],
      tools: [{ type: "web_search_20250305", name: "web_search" }]
    })
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || ("Anthropic " + res.status);
    throw new Error(msg);
  }
  const text = Array.isArray(data.content)
    ? data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim()
    : "";
  return { text, model: ANTHROPIC_MODEL };
}

// ---- 資料源健康檢查（/api/debug）----
const RWD_SOURCES = { t86: fetchT86, qfiis: fetchQFIIS };

async function sourceStatus(code) {
  const timed = async (name, fn) => {
    const t0 = Date.now();
    try {
      const info = await fn();
      return Object.assign({ name, ok: !!(info && info.ok !== false) }, info, { ms: Date.now() - t0 });
    } catch (e) {
      return { name, ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 };
    }
  };
  const checks = Object.keys(OPENAPI).map((k) => timed("openapi:" + k, async () => {
    const j = await oa(k, 600);
    if (!Array.isArray(j)) return { ok: false, error: "回傳格式不是陣列" };
    const r0 = j[0] || {};
    // 重大訊息當天沒有公告時本來就可能是空陣列
    return { ok: j.length > 0 || k === "news", rows: j.length, date: r0.Date ? anyDateToISO(r0.Date) : (r0["出表日期"] ? anyDateToISO(r0["出表日期"]) : null) };
  }));
  for (const k of Object.keys(RWD_SOURCES)) checks.push(timed("rwd:" + k, async () => {
    const r = await RWD_SOURCES[k]();
    if (!r) return { ok: false, error: "近 5 個交易日都查無資料，或連線受限" };
    return { rows: Object.keys(r.byCode).length, date: r.date, hasCode: !!r.byCode[code] };
  }));
  checks.push(timed("rwd:stockDay(" + code + ")", async () => {
    const h = await fetchHistory(code);
    return { ok: h.length > 0, rows: h.length, date: h.length ? h[h.length - 1].date : null };
  }));
  checks.push(timed("mis:realtime(" + code + ")", async () => {
    const rt = await fetchRealtime(code);
    // 盤前／休市沒有即時成交是正常的，不算失敗
    return rt ? { date: rt.date, time: rt.time, close: rt.close } : { ok: true, note: "目前沒有當盤成交（盤前或休市屬正常）" };
  }));
  const sources = await Promise.all(checks);
  return { ok: sources.every((s) => s.ok), code, checkedAt: new Date().toISOString(), sources };
}

// /api/debug?ds=t86&code=2330 → 看欄位名稱與該代號那一列原始資料（欄位改版時用）
async function sourceSample(ds, code) {
  if (OPENAPI[ds]) {
    const j = await oa(ds, 60);
    if (!Array.isArray(j)) return { error: "fetch failed", type: typeof j };
    return { ds, rows: j.length, keys: j[0] ? Object.keys(j[0]) : [], sample: j.find((x) => codeOf(x) === code) || null };
  }
  if (ds === "t86" || ds === "qfiis") {
    const r = await twseLatest(ds === "t86" ? "fund/T86" : "fund/MI_QFIIS", { selectType: "ALLBUT0999" });
    if (!r) return { ds, error: "近 5 個交易日都查無資料，或連線受限" };
    return { ds, date: r.date, rows: r.data.length, fields: r.fields,
      sample: r.data.find((row) => String(row[0] || "").trim() === code) || null, parsed: (await RWD_SOURCES[ds]() || { byCode: {} }).byCode[code] || null };
  }
  if (ds === "stockDay") return { ds, history: await fetchHistory(code) };
  if (ds === "realtime") return { ds, realtime: await fetchRealtime(code) };
  return { error: "ds 可用值：" + Object.keys(OPENAPI).concat(["t86", "qfiis", "stockDay", "realtime"]).join("|") };
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
        if (!/^\d{4,6}[A-Z]?$/.test(dcode)) return json({ error: "請提供有效的股票代號（例如 2330）" }, 400);
        if (!ds) return json(await sourceStatus(dcode));
        return json(await sourceSample(ds, dcode));
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
        return json({ name: "台股天際線 API", routes: ["GET /api/stock?code=2330", "GET /api/extra?code=2330", "GET /api/screen", "GET /api/debug[?ds=t86&code=2330]", "POST /api/analyze", "POST /api/news", "POST /api/command"] });
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  }
};
