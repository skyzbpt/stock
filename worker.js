/**
 * 台股天際線 · 後端 Worker (Cloudflare Workers)
 * ------------------------------------------------------------------
 * 兩個路由：
 *   GET  /api/stock?code=2330   → 直接抓證交所公開資料，整理成精簡 JSON（秒讀）
 *   POST /api/analyze           → 用你抓到的數據，呼叫 Claude 做「一次到位」的精準分析
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

// ---- 抓證交所資料（伺服器端 + Cloudflare 邊緣快取）----
async function twFetch(u, ttl) {
  const res = await fetch(u, {
    headers: { "User-Agent": UA, "Accept": "application/json" },
    cf: { cacheTtl: ttl || 600, cacheEverything: true }
  });
  if (!res.ok) throw new Error("TWSE " + res.status);
  return res.json();
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
      const z = num(m.z), y = num(m.y);
      if (z == null) continue; // 尚無當盤成交（如未開盤），交給收盤資料處理
      const d = String(m.d || "");
      const iso = /^\d{8}$/.test(d) ? d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8) : null;
      return {
        name: m.n || null,
        market: m.ex === "otc" ? "上櫃 (TPEx)" : "上市 (TWSE)",
        date: iso, time: m.t || null,
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
  const now = new Date();
  const ym = (dt) => dt.getFullYear() + String(dt.getMonth() + 1).padStart(2, "0") + "01";
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const urls = [
    "https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=" + ym(prev) + "&stockNo=" + code,
    "https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=" + ym(now) + "&stockNo=" + code
  ];
  let rows = [];
  for (const u of urls) {
    try {
      const j = await twFetch(u, 1800);
      if (j && j.stat === "OK" && Array.isArray(j.data)) {
        for (const r of j.data) {
          // r: [日期, 成交股數, 成交金額, 開盤, 最高, 最低, 收盤, 漲跌價差, 成交筆數]
          const close = num(r[6]);
          const vol = num(r[1]);
          if (close != null) rows.push({ date: rocToISO(r[0]), close, volumeLots: vol != null ? Math.round(vol / 1000) : null });
        }
      }
    } catch (e) { /* 略過單月失敗 */ }
  }
  const seen = {};
  rows = rows.filter((x) => (seen[x.date] ? false : (seen[x.date] = 1)));
  return rows.slice(-40);
}

async function buildSnapshot(code) {
  const [dayAll, bwibbu, t86, hist, rt] = await Promise.all([
    twFetch("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL", 600).catch(() => null),
    twFetch("https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL", 600).catch(() => null),
    twFetch("https://openapi.twse.com.tw/v1/fund/T86", 600).catch(() => null),
    fetchHistory(code).catch(() => null),
    fetchRealtime(code).catch(() => null)
  ]);

  const snap = {
    code, name: null, market: "上市 (TWSE)", asOf: new Date().toISOString(),
    source: "臺灣證券交易所 OpenAPI", price: null, valuation: null,
    institutional: null, history: null, notes: []
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
    snap.priceLabel = rt.time === "13:30:00" ? "收盤" : "盤中即時";
    snap.source = "臺灣證券交易所 OpenAPI ＋ 即時行情快照";
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

  // 三大法人買賣超（單位：張＝股數/1000；正為買超、負為賣超）
  if (Array.isArray(t86)) {
    const row = t86.find((r) => (r.Code || r["證券代號"]) === code);
    if (row) {
      snap.name = snap.name || row.Name || row["證券名稱"];
      const toLots = (v) => (v == null ? null : Math.round(v / 1000));
      const foreign = num(pick(row, ["外陸資買賣超股數(不含外資自營商)", "外資買賣超股數", "外資及陸資", "Foreign"]));
      const trust   = num(pick(row, ["投信買賣超股數", "投信", "Investment Trust", "InvestmentTrust"]));
      const dealer  = num(pick(row, ["自營商買賣超股數", "自營商", "Dealer"]));
      const total   = num(pick(row, ["三大法人買賣超股數", "Total"]));
      snap.institutional = {
        unit: "張",
        foreignLots: toLots(foreign),
        trustLots: toLots(trust),
        dealerLots: toLots(dealer),
        totalLots: total != null ? toLots(total)
          : ((foreign || trust || dealer) != null ? toLots((foreign || 0) + (trust || 0) + (dealer || 0)) : null)
      };
    }
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
function codeOf(r) { return String(r.Code || r["公司代號"] || r["證券代號"] || "").trim(); }

async function buildExtra(code) {
  const [basic, rev, fin, div, margn, qfiis, news, mkt] = await Promise.all([
    twFetch("https://openapi.twse.com.tw/v1/opendata/t187ap03_L", 3600).catch(() => null),
    twFetch("https://openapi.twse.com.tw/v1/opendata/t187ap05_L", 3600).catch(() => null),
    twFetch("https://openapi.twse.com.tw/v1/opendata/t187ap14_L", 3600).catch(() => null),
    twFetch("https://openapi.twse.com.tw/v1/opendata/t187ap45_L", 3600).catch(() => null),
    twFetch("https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN", 1800).catch(() => null),
    twFetch("https://openapi.twse.com.tw/v1/fund/MI_QFIIS", 1800).catch(() => null),
    twFetch("https://openapi.twse.com.tw/v1/opendata/t187ap04_L", 600).catch(() => null),
    twFetch("https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK", 1800).catch(() => null)
  ]);
  const out = { code, asOf: new Date().toISOString(),
    source: "臺灣證券交易所 OpenAPI（基本資料／月營收／季報／股利／信用交易／外資持股／重大訊息／大盤）",
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
    const rows = fin.filter((x) => codeOf(x) === code);
    const r = rows.length ? rows[rows.length - 1] : null;
    if (r) {
      const rv = num(pick(r, ["營業收入"]));
      const gp = num(pick(r, ["營業毛利"]));
      const ni = num(pick(r, ["本期淨利"]));
      out.quarterly = {
        period: (String(pick(r, ["年度"]) || "").trim() + " Q" + String(pick(r, ["季別"]) || "").trim()).trim(),
        eps: num(pick(r, ["基本每股盈餘"])),
        revenueB: rv != null ? +(rv / 1e5).toFixed(1) : null,
        grossMarginPct: (rv && gp != null) ? +(gp / rv * 100).toFixed(2) : null,
        netMarginPct: (rv && ni != null) ? +(ni / rv * 100).toFixed(2) : null,
        netIncomeB: ni != null ? +(ni / 1e5).toFixed(1) : null
      };
    }
  }
  // 股利分派（現金＝盈餘＋公積；股票＝盈餘轉增資＋公積轉增資，單位 元/股）
  if (Array.isArray(div)) {
    const rows = div.filter((x) => codeOf(x) === code);
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
      const mb = num(pick(r, ["MarginBalance", "融資今日餘額", "TodayBalance"]));
      const mp = num(pick(r, ["MarginBalancePreviousDay", "融資前日餘額", "PreviousDayBalance"]));
      const sb = num(pick(r, ["ShortBalance", "融券今日餘額"]));
      out.margin = {
        unit: "張",
        marginBalanceLots: mb,
        marginChangeLots: (mb != null && mp != null) ? mb - mp : null,
        shortBalanceLots: sb
      };
    }
  }
  // 外資及陸資持股比率（%）
  if (Array.isArray(qfiis)) {
    const r = qfiis.find((x) => codeOf(x) === code);
    if (r) out.foreign = { holdingPct: num(pick(r, ["持股比率"])) };
  }
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
    twFetch("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL", 600).catch(() => null),
    twFetch("https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL", 600).catch(() => null),
    twFetch("https://openapi.twse.com.tw/v1/fund/T86", 600).catch(() => null)
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
  if (Array.isArray(t86)) for (const r of t86) {
    const code = r.Code || r["證券代號"]; const it = byCode[code]; if (!it) continue;
    const total = num(pick(r, ["三大法人買賣超股數", "Total"]));
    if (total != null) it.instLots = Math.round(total / 1000);
  }

  const all = Object.values(byCode).filter((x) => x.close != null);
  let up = 0, down = 0, flat = 0;
  for (const x of all) { if (x.change > 0) up++; else if (x.change < 0) down++; else flat++; }

  const strip = (x) => ({ code: x.code, name: x.name, close: x.close, changePct: x.changePct,
    volumeLots: x.volumeLots, pe: x.pe, yield: x.yield, pb: x.pb, instLots: x.instLots });
  const topBy = (keyFn, filterFn) => all.filter(filterFn).sort((a, b) => keyFn(b) - keyFn(a)).slice(0, 12).map(strip);

  return {
    asOf: new Date().toISOString(),
    source: "臺灣證券交易所 OpenAPI（上市）",
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
      "以下是剛抓取的證交所資料（JSON）：\n```json\n" + JSON.stringify(snapshot, null, 2) + "\n```\n\n" +
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
        return json({ name: "台股天際線 API", routes: ["GET /api/stock?code=2330", "GET /api/extra?code=2330", "GET /api/screen", "POST /api/analyze", "POST /api/news"] });
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  }
};
