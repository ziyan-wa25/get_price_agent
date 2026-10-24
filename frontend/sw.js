// 报价系统 PWA Service Worker v1
// 策略（v1 从简可靠）：
// - API（含 /api/ 的请求）与跨域请求（腾讯云 SCF）：一律直连，绝不缓存——登录态与库存/报价/应收/进项数据必须实时
// - 其余同源 GET（页面导航 + 静态文件）：network-first——在线时拿最新版并顺带刷新缓存，断网时回退到缓存的界面壳
// - 升级方式：改下方 CACHE 名称发布新版 SW，activate 时自动淘汰全部旧缓存
const CACHE = 'xch-quote-pwa-v1';
const SHELL = ['./', './index.html', './app.js', './styles.css', './config.js', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // POST/DELETE 等直连
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return; // 跨域（SCF API）直连
  if (url.pathname.includes('/api/')) return; // API 永不缓存
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() =>
      caches.match(req, { ignoreSearch: true }).then((cached) => {
        if (cached) return cached;
        if (req.mode === 'navigate') return caches.match('./'); // 离线打开时兜底回壳页面
        return undefined;
      })
    )
  );
});
