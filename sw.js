/* Copia sin conexión de la app del hotel.
 *
 * Siempre se pide primero lo último a internet; si no hay cobertura se abre
 * la última copia guardada en este móvil. Las páginas guardadas siguen
 * cifradas: sin la contraseña o la huella no se pueden leer.
 *
 * También recibe los avisos de la nube (notificación con sonido y vibración
 * cuando termina «Actualizar ahora»), aunque la app esté cerrada. */
'use strict';
var CACHE = 'panel-hotel-v1';
var BASICOS = ['./', 'index.html', 'hoteles.html', 'historico.html', 'seguridad.html',
  'nube.js', 'historico.js', 'acceso.json', 'version.json', 'historico-precios.xlsx.json',
  'logo.svg', 'icono-180.png', 'icono-192.png', 'icono-512.png', 'insignia-96.png', 'manifest.webmanifest'];

function clave(url) {
  var u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.toString();
}

self.addEventListener('install', function (ev) {
  ev.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(BASICOS.map(function (f) {
      return fetch(f, { cache: 'no-cache' }).then(function (r) {
        if (r.ok) return c.put(clave(new URL(f, self.location).toString()), r);
      }).catch(function () { /* se guardará la próxima vez */ });
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // GitHub, letras: directo
  var red = req.mode === 'navigate' ? fetch(req) : fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
  ev.respondWith(red.then(function (r) {
    if (r && r.ok && r.type === 'basic' && !r.redirected) {
      var copia = r.clone();
      caches.open(CACHE).then(function (c) { return c.put(clave(req.url), copia); }).catch(function () {});
    }
    return r;
  }).catch(function () {
    return caches.open(CACHE).then(function (c) {
      return c.match(clave(req.url)).then(function (r) {
        if (r) return r;
        if (req.mode === 'navigate') return c.match(clave(new URL('index.html', self.location).toString()));
        return undefined;
      });
    }).then(function (r) {
      return r || new Response('Sin conexión', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    });
  }));
});

// ---- Avisos al móvil -------------------------------------------------------
var VIBRAR = [300, 120, 300];
function avisar(d) {
  return self.registration.showNotification(d.titulo || 'Panel HR', {
    body: d.cuerpo || 'Ya están los precios más recientes.',
    icon: 'icono-192.png',
    badge: 'insignia-96.png',
    vibrate: VIBRAR,
    tag: d.tag || 'panel-hr',
    renotify: true,
    silent: false,
    timestamp: Date.now(),
    data: { url: d.url || 'index.html' }
  });
}
self.addEventListener('push', function (ev) {
  var d = {};
  try { d = ev.data ? ev.data.json() : {}; } catch (e) { d = { cuerpo: ev.data ? ev.data.text() : '' }; }
  ev.waitUntil(avisar(d));
});
self.addEventListener('notificationclick', function (ev) {
  ev.notification.close();
  var url = new URL((ev.notification.data && ev.notification.data.url) || 'index.html', self.location).toString();
  ev.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i];
      if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
        return c.focus().then(function (w) { return (w || c).navigate ? (w || c).navigate(url) : w; }).catch(function () {});
      }
    }
    return self.clients.openWindow(url);
  }));
});
