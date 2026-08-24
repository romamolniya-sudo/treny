/* Кэш приложения: без него в зале без интернета видео не откроются. */
const CACHE = "trn-v1";
const SHELL = ["./", "./index.html", "./icon-180.png", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* Safari запрашивает видео кусками (Range). Отдать целый файл в ответ на Range нельзя —
   плеер такой ответ не примет. Поэтому режем сами. */
async function sliceForRange(req, cached) {
  const range = req.headers.get("range");
  if (!range) return cached;
  const buf = await cached.arrayBuffer();
  const m = /bytes=(\d+)-(\d*)/.exec(range);
  if (!m) return cached;
  const start = +m[1];
  const end = m[2] ? Math.min(+m[2], buf.byteLength - 1) : buf.byteLength - 1;
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": cached.headers.get("Content-Type") || "video/mp4",
      "Content-Range": "bytes " + start + "-" + end + "/" + buf.byteLength,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes"
    }
  });
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(url.pathname, { ignoreSearch: true });
    if (hit) return sliceForRange(req, hit);
    try {
      const net = await fetch(req);
      // Частичный ответ (206) в кэш класть нельзя — положим потом целиком, при скачивании
      if (net.ok && net.status === 200 && /\.(mp4|m4a|png|html|js)$/.test(url.pathname)) {
        cache.put(url.pathname, net.clone());
      }
      return net;
    } catch (err) {
      const shell = await cache.match("./index.html");
      if (shell && req.mode === "navigate") return shell;
      throw err;
    }
  })());
});

/* Массовое скачивание всех видео по кнопке из приложения */
self.addEventListener("message", e => {
  const d = e.data || {};
  if (d.type !== "precache") return;
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    let done = 0, failed = 0;
    for (const u of d.urls) {
      try {
        if (!(await cache.match(u))) {
          const r = await fetch(u, { cache: "no-store" });
          if (r.ok) await cache.put(u, r); else failed++;
        }
      } catch (err) { failed++; }
      done++;
      (await self.clients.matchAll()).forEach(c =>
        c.postMessage({ type: "precache-progress", done, total: d.urls.length, failed }));
    }
    (await self.clients.matchAll()).forEach(c =>
      c.postMessage({ type: "precache-done", failed }));
  })());
});
