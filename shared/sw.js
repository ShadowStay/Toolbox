// Service worker (served at /sw.js). Downloaded tracks and artwork live in the "music-dl" cache; everything else
// about the library is fetched from the server. Audio is answered with Range support so seeking works offline (iOS needs it).
const DL = "music-dl", SHELL = "shell-v1";
const MEDIA = /^\/api\/music\/(file|art)\/\d+$/;
const SHELL_PATHS = /^\/(music(\.js|\.css)?|shared\/.*|images\/.*)$/;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(clients.claim()));

self.addEventListener("fetch", (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== location.origin) return;
  if (MEDIA.test(u.pathname)) e.respondWith(media(r, u));
  else if (SHELL_PATHS.test(u.pathname)) e.respondWith(shell(r));
});

async function media(r, u) {
  const hit = await (await caches.open(DL)).match(u.pathname);
  if (!hit) return fetch(r);                                   // not downloaded: stream from the server
  const range = r.headers.get("range");
  if (!range) return hit;
  const blob = await hit.blob(), size = blob.size, m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) return hit;
  const start = m[1] ? +m[1] : Math.max(0, size - +m[2]);
  const end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
  if (start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": hit.headers.get("Content-Type") || "audio/mpeg",
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
    },
  });
}

async function shell(r) {                                      // network first, cached copy when offline
  const c = await caches.open(SHELL);
  try {
    const n = await fetch(r);
    if (n.ok) c.put(r, n.clone());
    return n;
  } catch {
    return (await c.match(r, { ignoreVary: true })) || Response.error();
  }
}
