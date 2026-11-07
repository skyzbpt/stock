// 台股天際線 Service Worker
// 只快取「網頁本身」和「圖示／manifest」，讓 App 秒開、離線也能打開畫面。
// 股價、AI 分析等後端 API 一律直接走網路、不快取，不會拿到舊資料：
//   - GitHub Pages 版：後端在別的網域（Cloudflare Worker），本來就不攔截
//   - Worker 版：網頁和 /api/ 在同一個網域，靠下面的白名單只處理網頁與圖示
var CACHE = "skyline-v3";
// 圖示網址的 ?v= 要和 index.html、manifest.webmanifest 裡的一致（換圖示時三個地方一起改）
var SHELL = ["./", "index.html", "manifest.webmanifest",
  "favicon.svg?v=3", "icon-192.png?v=3", "icon-512.png?v=3", "icon-maskable-512.png?v=3", "apple-touch-icon.png?v=3"];

self.addEventListener("install", function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(SHELL); }).then(function(){ return self.skipWaiting(); }));
});

self.addEventListener("activate", function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});

self.addEventListener("fetch", function(e){
  var req = e.request;
  if(req.method !== "GET") return;
  var url = new URL(req.url);
  if(url.origin !== self.location.origin) return;           // 字型、別網域的後端 API：不攔截
  var root = new URL("./", self.registration.scope).pathname; // GitHub Pages 是 /stock/，Worker 是 /

  // 網頁本身：先抓最新版，沒網路才用快取（更新後馬上生效）
  // 只認首頁；同網域的其他網址（例如 Worker 版的 /api/debug）照常走網路，也不會蓋掉快取的首頁
  if(req.mode === "navigate"){
    if(url.pathname !== root && url.pathname !== root + "index.html") return;
    e.respondWith(fetch(req).then(function(res){
      if(res.ok){ var copy = res.clone(); caches.open(CACHE).then(function(c){ c.put("index.html", copy); }); }
      return res;
    }).catch(function(){ return caches.match("index.html"); }));
    return;
  }

  // 圖示與 manifest：先用快取，背景再更新；其他請求（包含 /api/）一律不攔截
  if(!/\.(png|svg|webmanifest)$/.test(url.pathname)) return;
  e.respondWith(caches.match(req).then(function(hit){
    var net = fetch(req).then(function(res){
      if(res.ok){ var copy = res.clone(); caches.open(CACHE).then(function(c){ c.put(req, copy); }); }
      return res;
    }).catch(function(){ return hit; });
    return hit || net;
  }));
});
