/* Winkify — service worker (v2)
   Va messo nella STESSA cartella di index.html (stesso indirizzo, es. https://tuo-sito/sw.js).
   Serve a:
   1) aprire l'app anche senza rete: l'index.html resta salvato nel browser e si aggiorna da solo quando sei online;
   2) riprodurre dalla cache i brani salvati dalla pagina, con barra di avanzamento e spostamento nel brano;
   3) tenere le copertine e i dati di sola lettura di Navidrome per sfogliare anche offline.
   Le credenziali (utente, token) non entrano mai nelle chiavi di cache. */
'use strict';
const VER = '2';
const SHELL  = 'winkify-shell-v' + VER;
const AUDIO  = 'winkify-audio-v1';     /* scritta dalla pagina, letta da qui */
const COVERS = 'winkify-covers-v1';
const DATA   = 'winkify-data-v1';
const SCOPE  = self.registration.scope;
let serverDown = false;                /* indicazione della pagina: serve SOLO ad accorciare l'attesa prima di usare la copia salvata, mai a rifiutare richieste */

const keep = (ev, p) => { try { ev.waitUntil(Promise.resolve(p).catch(() => {})); } catch (_) {} };
const bare = href => { const u = new URL(href); u.search = ''; u.hash = ''; return u.href; };
async function trim(cache, max, drop) {
  try { const ks = await cache.keys(); if (ks.length > max) for (const k of ks.slice(0, drop)) await cache.delete(k); } catch (_) {}
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    for (const u of [SCOPE, SCOPE + 'index.html']) {
      try { const r = await fetch(new Request(u, { cache: 'reload' })); if (r.ok) await c.put(u, r); } catch (_) {}
    }
  })());
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('winkify-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.t === 'nav') serverDown = !!d.down;
  else if (d.t === 'ver' && e.source) e.source.postMessage({ t: 'ver', v: VER, scope: SCOPE });
  else if (d.t === 'shell' && d.url) {
    e.waitUntil((async () => {
      try { const u = bare(d.url); if (new URL(u).origin !== location.origin) return;
        const r = await fetch(new Request(u, { cache: 'reload' })); if (r.ok) (await caches.open(SHELL)).put(u, r); } catch (_) {}
    })());
  }
});

/* ---------- guscio dell'app: rete per prima (cosi' si ricevono gli aggiornamenti); se e' lenta o assente, copia salvata ---------- */
async function shell(req, ev) {
  const c = await caches.open(SHELL), key = bare(req.url);
  const net = (async () => { const r = await fetch(req); if (r && r.ok) c.put(key, r.clone()); return r; })();
  const cached = (await c.match(key)) || (await c.match(SCOPE)) || (await c.match(SCOPE + 'index.html'));
  if (!cached) return net.catch(() => new Response('Winkify non è ancora salvato per l\'uso offline: aprilo una volta con la connessione attiva.',
    { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
  try {
    const r = await Promise.race([net, new Promise(res => setTimeout(() => res(null), 4000))]);
    if (r) return r;
    keep(ev, net);                       /* la rete continua e aggiorna la copia */
    return cached;
  } catch (_) { return cached; }
}

/* ---------- brani: dalla cache se ci sono (con supporto a Range), altrimenti dalla rete ---------- */
async function ranged(req, resp) {
  const type = resp.headers.get('Content-Type') || 'audio/mpeg';
  const blob = await resp.blob(), size = blob.size;
  const full = () => new Response(blob, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
  const h = req.headers.get('Range');
  if (!h) return full();
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === '' && m[2] === '')) return full();
  let start, end;
  if (m[1] === '') { start = Math.max(0, size - +m[2]); end = size - 1; }
  else { start = +m[1]; end = m[2] === '' ? size - 1 : Math.min(+m[2], size - 1); }
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
  return new Response(blob.slice(start, end + 1), { status: 206, headers: {
    'Content-Type': type, 'Content-Range': 'bytes ' + start + '-' + end + '/' + size, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' } });
}
async function audio(req, url) {
  const id = url.searchParams.get('id');
  if (id) {
    try {
      const hit = await (await caches.open(AUDIO)).match(SCOPE + '__track/' + encodeURIComponent(id));
      if (hit) return await ranged(req, hit);
    } catch (_) {}
  }
  return fetch(req);
}

/* ---------- copertine: una volta viste restano (l'id cambia quando cambia l'immagine). Mai rifiutate in anticipo. ---------- */
const corsBad = {};                    /* server che non manda le intestazioni CORS per le copertine: si mostrano ma non si salvano */
async function cover(req, url) {
  const id = url.searchParams.get('id');
  if (!id) return fetch(req);
  const key = SCOPE + '__cover/' + encodeURIComponent(id) + '/' + (url.searchParams.get('size') || '');
  const c = await caches.open(COVERS);
  const hit = await c.match(key);
  if (hit) return hit;
  if (!corsBad[url.host]) {
    try {
      const r = await fetch(url.href, { mode: 'cors', credentials: 'omit' });
      if (r.ok && /^image\//i.test(r.headers.get('Content-Type') || '')) { c.put(key, r.clone()); trim(c, 2500, 300); }
      return r;
    } catch (_) { /* niente CORS o rete assente: si prova nel modo normale */ }
  }
  try {
    const r = await fetch(req);
    if (r && r.type === 'opaque') corsBad[url.host] = true;
    return r;
  } catch (e) { return Response.error(); }
}

/* ---------- dati di sola lettura di Navidrome e testi LRCLIB: rete per prima, copia salvata come ripiego ---------- */
const DATA_EP = /\/rest\/(getAlbumList2|getAlbum|getArtist|getArtistInfo2|getArtists|getPlaylists|getPlaylist|getStarred2|getGenres|getRandomSongs|getSongsByGenre|getTopSongs|getLyricsBySongId|getLyrics|getSong|search3|getSimilarSongs2)$/;
const jsonOk = t => /"status"\s*:\s*"ok"/.test(t.slice(0, 600));
const lrcOk  = t => t.length > 2 && t[0] !== '<';
function dataKey(url, kind) {
  const q = new URLSearchParams(url.search);
  ['u', 't', 's', 'p', 'salt', 'token', '_'].forEach(k => q.delete(k));
  q.sort();
  return SCOPE + '__' + kind + '/' + encodeURIComponent(url.host) + url.pathname.replace(/^.*\//, '/') + '?' + q.toString();
}
async function data(req, url, ev, ok, kind) {
  const key = dataKey(url, kind), c = await caches.open(DATA);
  const stale = async () => {
    const hit = await c.match(key); if (!hit) return null;
    return new Response(await hit.arrayBuffer(), { status: 200, headers: {
      'Content-Type': hit.headers.get('Content-Type') || 'application/json', 'X-Winkify-Cache': '1', 'Access-Control-Allow-Origin': '*' } });
  };
  /* la richiesta di rete non viene mai interrotta: se e' lenta si aspetta (come prima della cache) */
  const net = (async () => {
    const r = await fetch(req);
    if (r.status === 200) {
      const cl = r.clone();
      keep(ev, (async () => {
        const t = await cl.text();
        if (ok(t)) { await c.put(key, new Response(t, { headers: { 'Content-Type': cl.headers.get('Content-Type') || 'application/json' } })); await trim(c, 800, 150); }
      })());
    }
    return r;
  })();
  const have = await c.match(key);
  if (!have) return net;                                   /* niente copia: si aspetta la rete, quanto serve */
  try {
    const r = await Promise.race([net, new Promise(res => setTimeout(() => res(null), serverDown ? 2500 : 15000))]);
    if (r) return r;
    keep(ev, net);                                          /* la rete continua e aggiorna la copia */
    return (await stale()) || net;
  } catch (err) { const s2 = await stale(); if (s2) return s2; throw err; }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url), p = url.pathname;
  if (req.mode === 'navigate' && url.origin === location.origin) { e.respondWith(shell(req, e)); return; }
  if (/\/rest\/(stream|download)$/.test(p)) { e.respondWith(audio(req, url)); return; }
  if (/\/rest\/getCoverArt$/.test(p)) { e.respondWith(cover(req, url)); return; }
  if (DATA_EP.test(p)) { e.respondWith(data(req, url, e, jsonOk, 'data')); return; }
  if (url.hostname === 'lrclib.net' && p.startsWith('/api/')) { e.respondWith(data(req, url, e, lrcOk, 'lrc')); return; }
});
