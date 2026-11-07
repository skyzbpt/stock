// 台股天際線 Service Worker
// 只快取同網域的介面檔案，讓 App 秒開、離線也能打開畫面；
// 股價、AI 分析等後端 API（Cloudflare Worker，不同網域）一律直接走網路，不會拿到舊資料。
var CACHE = "skyline-v1";
var SHELL = ["./", "index.html", "manifest.webmanifest", "favicon.svg",
  "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"];

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
  if(url.origin !== self.location.origin) return; // 後端 API、字型：不攔截

  // 網頁本身：先抓最新版，沒網路才用快取（更新後馬上生效）
  if(req.mode === "navigate"){
    e.respondWith(fetch(req).then(function(res){
      var copy = res.clone(); caches.open(CACHE).then(function(c){ c.put("index.html", copy); });
      return res;
    }).catch(function(){ return caches.match("index.html"); }));
    return;
  }
  // 圖示等靜態檔：先用快取，背景再更新
  e.respondWith(caches.match(req).then(function(hit){
    var net = fetch(req).then(function(res){
      if(res.ok){ var copy = res.clone(); caches.open(CACHE).then(function(c){ c.put(req, copy); }); }
      return res;
    }).catch(function(){ return hit; });
    return hit || net;
  }));
});
