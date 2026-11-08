/* Winkify — service worker (v4)
   Va messo nella STESSA cartella di index.html (stesso indirizzo, es. https://tuo-sito/sw.js).
   Fa UNA cosa sola: tiene salvata l'app (index.html) per aprirla anche senza rete, e la aggiorna da sola quando sei online.

   NON tocca mai le richieste verso Navidrome (dati, copertine, brani): passano dalla pagina, come se il service worker non ci fosse.
   Cosi' funziona anche con un Navidrome in HTTP sulla rete locale, dove il browser permette le richieste alla pagina ma non al service worker.
   I brani salvati, le copertine e i dati per l'uso offline li gestisce la pagina con la Cache API. */
'use strict';
const VER = '4';
const SHELL = 'winkify-shell-v' + VER;
const SCOPE = self.registration.scope;

const keep = (ev, p) => { try { ev.waitUntil(Promise.resolve(p).catch(() => {})); } catch (_) {} };
const bare = href => { const u = new URL(href); u.search = ''; u.hash = ''; return u.href; };

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
  if (d.t === 'ver' && e.source) e.source.postMessage({ t: 'ver', v: VER, scope: SCOPE });
  else if (d.t === 'shell' && d.url) {
    e.waitUntil((async () => {
      try { const u = bare(d.url); if (new URL(u).origin !== location.origin) return;
        const r = await fetch(new Request(u, { cache: 'reload' })); if (r.ok) (await caches.open(SHELL)).put(u, r); } catch (_) {}
    })());
  }
});

/* rete per prima (cosi' si ricevono gli aggiornamenti); se e' lenta o assente, la copia salvata */
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

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  /* SOLO l'apertura dell'app (stesso indirizzo, https). Tutto il resto: nessun respondWith, la richiesta va avanti da sola. */
  if (req.mode === 'navigate' && url.origin === location.origin) e.respondWith(shell(req, e).catch(() => fetch(req)));
});
