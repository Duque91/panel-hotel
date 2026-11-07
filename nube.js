/* App del hotel en la nube (GitHub Pages).
 *
 * Todo lo que se publica va cifrado. Este script:
 *  - En la pantalla de entrada: abre la llave de datos con la contraseña
 *    (acceso.json) o con la huella (llave guardada solo en este móvil) y
 *    descifra la página.
 *  - Dentro de la app: comprueba que se ven los precios de hoy y mañana,
 *    activa la huella, descarga el Excel y hace funcionar «Actualizar
 *    ahora» y buscar/cambiar hoteles: sin llave, la app deja un aviso en un
 *    canal secreto (ntfy.sh) y el vigilante gratuito de la nube lo recoge en
 *    unos minutos; con llave de GitHub, la consulta empieza al momento (y
 *    también se puede cambiar la contraseña).
 * La contraseña no se guarda nunca. La llave de datos se recuerda solo
 * mientras la app esté abierta (máximo 12 horas). */
(function () {
  'use strict';
  var root = document.documentElement;
  var SES = 'bs-nube-sesion';
  var SESSION_MS = 12 * 3600 * 1000;
  var PEDIDO = 'bs-nube-pedido';
  var LLAVE = 'bs-nube-llave';
  var FALLOS = 'bs-nube-fallos';
  var HUELLA_NO = 'bs-nube-huella-no';
  var FRESCA = 'bs-nube-fresca';
  var DB_NAME = 'booking-sync-nube';
  var PEDIDO_MS = 15 * 60 * 1000;        // con llave de GitHub
  var PEDIDO_AVISO_MS = 40 * 60 * 1000;  // con aviso: el vigilante mira cada 5 minutos
  var NTFY = 'https://ntfy.sh/';
  var API = 'https://api.github.com';
  var subtle = window.crypto && window.crypto.subtle;
  var enc = new TextEncoder();
  var dec = new TextDecoder();

  // ---------- utilidades ----------
  function b64ToBytes(s) {
    var bin = atob(s), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function bytesToB64(b) {
    var u = new Uint8Array(b), s = '';
    for (var i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function rnd(n) { var u = new Uint8Array(n); crypto.getRandomValues(u); return u; }
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function setMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text || '';
    el.className = el.className.replace(/\s*\b(error|ok)\b/g, '') + (kind ? ' ' + kind : '');
  }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { /* nada */ } }
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* nada */ } }
  function hoyMadrid() {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date()); }
    catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  function es(iso) { return iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : ''; }
  function pagina() { var p = location.pathname.split('/').pop(); return /^[a-z]+\.html$/.test(p) ? p : 'index.html'; }

  // ---------- sesión (solo mientras la app está abierta) ----------
  function sesion() {
    var memory = window.__hrV3Session;
    if (memory && memory.exp > Date.now() && memory.k) return memory;
    try {
      var s = JSON.parse(sessionStorage.getItem(SES) || 'null');
      if (s && s.exp > Date.now() && s.k) return s;
      sessionStorage.removeItem(SES);
    } catch (e) { /* nada */ }
    return null;
  }
  function abrirSesion(raw, metodo) {
    var s = { k: bytesToB64(raw), exp: Date.now() + SESSION_MS, m: metodo };
    window.__hrV3Session = s;
    try { sessionStorage.setItem(SES, JSON.stringify(s)); }
    catch (e) { window.__hrV3MemoryOnly = true; }
  }
  function cerrarSesion() {
    window.__hrV3Session = null;
    try { sessionStorage.removeItem(SES); } catch (e) { /* nada */ }
  }
  function claveDatos(raw) { return subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']); }
  function claveSesion() { var s = sesion(); return s ? claveDatos(b64ToBytes(s.k)) : Promise.reject(new Error('sin sesión')); }

  function descifrar(key, blob) {
    return subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(blob.iv) }, key, b64ToBytes(blob.ct));
  }
  function cifrar(key, bytes) {
    var iv = rnd(12);
    return subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, bytes).then(function (ct) {
      return { iv: bytesToB64(iv), ct: bytesToB64(ct) };
    });
  }
  function kek(password, salt, iterations) {
    return subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']).then(function (k) {
      return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: iterations },
        k, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    });
  }
  function leerAcceso(intento) {
    intento = intento || 0;
    return fetch('acceso.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('No se pudo leer el acceso (' + r.status + ').');
      return r.json();
    }).catch(function (e) {
      if (intento < 2) return new Promise(function (ok) { setTimeout(ok, 1500 * (intento + 1)); })
        .then(function () { return leerAcceso(intento + 1); });
      throw new Error(navigator.onLine === false ? 'Sin conexión: conéctate a internet y vuelve a intentarlo.'
        : 'No se pudo comprobar la contraseña (la conexión falló). Vuelve a intentarlo.');
    });
  }
  function abrirConContrasena(acceso, password) {
    return kek(password, b64ToBytes(acceso.salt), acceso.iterations).then(function (k) {
      return descifrar(k, acceso);
    }).then(function (raw) { return new Uint8Array(raw); });
  }

  // ---------- huella: llave guardada solo en este móvil ----------
  function db() {
    return new Promise(function (ok, ko) {
      var r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('llaves'); };
      r.onsuccess = function () { ok(r.result); };
      r.onerror = function () { ko(r.error); };
    });
  }
  function dbOp(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (ok, ko) {
        var tx = d.transaction('llaves', mode), st = tx.objectStore('llaves'), req = fn(st);
        tx.oncomplete = function () { ok(req && req.result); d.close(); };
        tx.onerror = function () { ko(tx.error); d.close(); };
      });
    });
  }
  function huellaGuardada() {
    if (!window.indexedDB) return Promise.resolve(null);
    return dbOp('readonly', function (st) { return st.get('huella'); }).catch(function () { return null; });
  }
  function motivoSinHuella() {
    if (!window.isSecureContext) return 'La huella solo funciona en una dirección segura (https).';
    if (!window.PublicKeyCredential || !navigator.credentials || !window.indexedDB) return 'Este navegador no permite usar la huella. Usa Chrome.';
    return null;
  }
  function huellaDisponible() {
    if (motivoSinHuella()) return Promise.resolve(false);
    try {
      return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }
  function explicar(err, registrando) {
    var n = err && err.name;
    if (n === 'NotAllowedError') return 'Cancelado o se agotó el tiempo. Vuelve a intentarlo.';
    if (n === 'InvalidStateError') return registrando ? 'Este móvil ya tiene la huella activada.' : 'No se pudo usar la huella.';
    if (n === 'SecurityError') return 'La huella necesita la dirección segura de la app (https).';
    if (n === 'NotSupportedError') return 'Este navegador no permite usar la huella.';
    if (n === 'OperationError') return 'La huella guardada ya no sirve: entra con la contraseña y vuelve a activarla.';
    return (err && err.message) ? err.message : 'No se pudo usar la huella.';
  }
  function uvOk(cred) {
    try { return (new Uint8Array(cred.response.authenticatorData)[32] & 0x04) !== 0; } catch (e) { return true; }
  }
  function activarHuella() {
    var s = sesion();
    if (!s) return Promise.reject(new Error('Vuelve a entrar con la contraseña.'));
    var raw = b64ToBytes(s.k);
    return navigator.credentials.create({ publicKey: {
      challenge: rnd(32), rp: { name: 'Panel del hotel' },
      user: { id: rnd(16), name: 'director', displayName: 'Director · HR' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      attestation: 'none', timeout: 60000 } }).then(function (cred) {
      return subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']).then(function (dev) {
        return cifrar(dev, raw).then(function (w) {
          var rec = { credId: bytesToB64(cred.rawId), dev: dev, iv: w.iv, ct: w.ct, created: new Date().toISOString() };
          return dbOp('readwrite', function (st) { return st.put(rec, 'huella'); });
        });
      });
    });
  }
  function entrarConHuella() {
    return huellaGuardada().then(function (rec) {
      if (!rec) throw new Error('Primero entra con la contraseña y activa la huella.');
      return navigator.credentials.get({ publicKey: {
        challenge: rnd(32), allowCredentials: [{ type: 'public-key', id: b64ToBytes(rec.credId) }],
        userVerification: 'required', timeout: 60000 } }).then(function (cred) {
        if (!uvOk(cred)) throw new Error('El móvil no confirmó la huella.');
        return descifrar(rec.dev, rec);
      }).then(function (raw) { return new Uint8Array(raw); });
    });
  }
  function quitarHuella() { return dbOp('readwrite', function (st) { return st.delete('huella'); }); }

  // ---------- pantalla de entrada ----------
  var REINTENTO = 'bs-nube-reintento';
  function esperarCarga(ms) {
    // Antes de sustituir la página se espera a que la de entrada termine de
    // cargar (letras, iconos): si no, el navegador a veces dejaba a medias
    // el script del histórico. Como mucho `ms`, para no esperar a una red lenta.
    return new Promise(function (ok) {
      if (document.readyState === 'complete') { ok(); return; }
      var t = setTimeout(ok, ms);
      window.addEventListener('load', function () { clearTimeout(t); ok(); }, { once: true });
    });
  }
  function escribir(html) {
    // Los <script src> se quitan y se cargan después, en orden: así nunca
    // quedan pendientes mientras se escribe la página.
    var srcs = [];
    html = html.replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/gi, function (m, src) { srcs.push(src); return ''; });
    document.open(); document.write(html); document.close();
    var donde = document.body || document.documentElement;
    var pendientes = srcs.length;
    window.__bsScriptsOk = pendientes === 0;
    srcs.forEach(function (src) {
      var sc = document.createElement('script'); sc.src = src; sc.async = false;
      sc.onload = function () {
        if (--pendientes === 0) { window.__bsScriptsOk = true; ssSet(REINTENTO, null); }
      };
      sc.onerror = function () { setTimeout(reintentarOAvisar, 1500); };
      donde.appendChild(sc);
    });
  }
  function vigilar(ms) {
    // Si en `ms` la app no ha terminado de abrirse, se recarga sola (2 veces
    // como mucho); después se ofrece un botón para volver a intentarlo.
    setTimeout(reintentarOAvisar, ms);
  }
  var avisado = false, recargando = false;
  function reintentarOAvisar() {
    // Lista = nube.js ha arrancado y todos los scripts de la página han cargado.
    if (avisado || recargando || (window.__bsListo && window.__bsScriptsOk)) return;
    var n = +(ssGet(REINTENTO) || 0);
    if (n < 2) { recargando = true; ssSet(REINTENTO, String(n + 1)); location.reload(); return; }
    ssSet(REINTENTO, null);
    avisado = true;
    var d = document.createElement('div');
    d.setAttribute('role', 'alert');
    d.style.cssText = 'position:fixed;left:12px;right:12px;top:12px;z-index:99;background:#fff4e5;color:#5c3b00;' +
      'border:1px solid #e0b26b;border-radius:12px;padding:14px 16px;font:15px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.12)';
    d.innerHTML = '<strong>La app no terminó de abrirse.</strong> Suele ser la conexión. ';
    var b = document.createElement('button'); b.type = 'button'; b.textContent = 'Volver a intentar';
    b.style.cssText = 'display:block;margin-top:10px;min-height:44px;padding:0 18px;border:0;border-radius:10px;background:#0d5c63;color:#fff;font:600 15px system-ui,sans-serif';
    b.addEventListener('click', function () { location.reload(); });
    d.appendChild(b);
    (document.body || document.documentElement).appendChild(d);
  }
  function mostrar(raw, blob, metodo) {
    return claveDatos(raw).then(function (k) { return descifrar(k, blob); }).then(function (buf) {
      abrirSesion(raw, metodo);
      window.__bsShell = { built: root.getAttribute('data-built'), pagina: root.getAttribute('data-pagina') };
      var html = dec.decode(buf);
      return esperarCarga(2000).then(function () { vigilar(12000); escribir(html); });
    });
  }
  function puerta() {
    registrarCopia();
    var blob = JSON.parse($('#cifrado').textContent);
    var s = sesion();
    if (s) {
      mostrar(b64ToBytes(s.k), blob, s.m).catch(function () { cerrarSesion(); enseñarPuerta(blob); });
      return;
    }
    enseñarPuerta(blob);
  }
  function bloqueo() {
    var f = lsGet(FALLOS) || { n: 0, hasta: 0 };
    return f.hasta > Date.now() ? Math.ceil((f.hasta - Date.now()) / 60000) : 0;
  }
  function fallo() {
    var f = lsGet(FALLOS) || { n: 0, hasta: 0 };
    f.n += 1;
    if (f.n >= 5) { f.hasta = Date.now() + 5 * 60000; f.n = 0; }
    lsSet(FALLOS, f);
  }
  function enseñarPuerta(blob) {
    $('#abriendo').hidden = true;
    $('#puerta').hidden = false;
    var btn = $('#entrar-huella'), hmsg = $('#huella-msg');
    Promise.all([huellaDisponible(), huellaGuardada()]).then(function (r) {
      if (r[0] && r[1]) { btn.hidden = false; $('#huella-sep').hidden = false; }
    });
    btn.addEventListener('click', function () {
      setMsg(hmsg, 'Pon el dedo en el lector…');
      btn.disabled = true;
      entrarConHuella().then(function (raw) { return mostrar(raw, blob, 'huella'); })
        .catch(function (e) { btn.disabled = false; setMsg(hmsg, explicar(e, false), 'error'); });
    });
    var form = $('#entrar-form'), pmsg = $('#pw-msg');
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (!subtle) { setMsg(pmsg, 'Este navegador no puede abrir la app. Usa Chrome.', 'error'); return; }
      var espera = bloqueo();
      if (espera) { setMsg(pmsg, 'Demasiados intentos. Espera ' + espera + ' min.', 'error'); return; }
      var pw = form.password.value, b = form.querySelector('button');
      b.disabled = true; setMsg(pmsg, 'Comprobando…');
      leerAcceso().then(function (acc) {
        return abrirConContrasena(acc, pw).then(function (raw) {
          lsSet(FALLOS, null);
          return mostrar(raw, blob, 'password');
        }, function () { fallo(); throw new Error('Contraseña incorrecta.'); });
      }).catch(function (e) {
        b.disabled = false; setMsg(pmsg, e.message || 'No se pudo entrar.', 'error');
        form.password.select();
      });
    });
    setTimeout(function () { if (form.password && btn.hidden) form.password.focus(); }, 50);
  }

  // ---------- GitHub (botones opcionales) ----------
  function repo() { return root.getAttribute('data-repo') || ''; }
  function leerLlave() {
    var w = lsGet(LLAVE);
    if (!w) return Promise.resolve(null);
    return claveSesion().then(function (k) { return descifrar(k, w); })
      .then(function (b) { return dec.decode(b); }).catch(function () { return null; });
  }
  function dueno() { return repo().split('/')[0] || ''; }
  function nombreRepo() { return repo().split('/')[1] || repo(); }
  function urlCrearLlave() {
    // Página de GitHub ya rellenada: nombre, permisos (Actions y Contents) y sin caducidad.
    return 'https://github.com/settings/personal-access-tokens/new?name=Panel+del+hotel' +
      '&description=Botones+de+la+app+del+hotel+%28Actualizar+ahora%2C+cambiar+hoteles%29' +
      '&target_name=' + encodeURIComponent(dueno()) + '&expires_in=none&actions=write&contents=write';
  }
  function gh(token, method, path, body) {
    return fetch(API + path, {
      method: method, cache: 'no-store',
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      var e;
      if (r.status === 401) { e = new Error('La llave de GitHub no es válida o ha caducado. Crea otra (son 2 minutos).'); e.llave = 'mala'; throw e; }
      if (r.status === 403 || r.status === 404) {
        e = new Error('La llave no tiene permiso sobre ' + nombreRepo() + ': al crearla, en «Repository access» elige «Only select repositories» y marca ' + nombreRepo() + '.');
        e.llave = 'permiso'; throw e;
      }
      if (!r.ok) throw new Error('GitHub respondió ' + r.status + '. Prueba en un minuto.');
      return r.status === 204 ? {} : r.json();
    }, function () { throw new Error('Sin conexión con GitHub. Revisa la cobertura y vuelve a intentarlo.'); });
  }
  function guardarLlave(t) {
    t = String(t || '').trim();
    if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(t)) return Promise.reject(new Error('Eso no parece una llave de GitHub: debe empezar por github_pat_. Cópiala entera.'));
    return gh(t, 'GET', '/repos/' + repo() + '/actions/workflows').then(function () {
      return claveSesion().then(function (k) { return cifrar(k, enc.encode(t)); });
    }).then(function (w) { lsSet(LLAVE, w); return t; });
  }
  // Canal de avisos: la app deja el pedido y el vigilante de la nube lo recoge (sin llave).
  function canal() { return root.getAttribute('data-avisos') || ''; }
  function avisar(inputs) {
    var datos = { app: 1 };
    Object.keys(inputs).forEach(function (k) { datos[k] = inputs[k]; });
    return fetch(NTFY + encodeURIComponent(canal()), { method: 'POST', body: JSON.stringify(datos), cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('No se pudo enviar el aviso a la nube (' + r.status + '). Vuelve a intentarlo en un minuto.');
        return r.json().catch(function () { return {}; });
      }, function () { throw new Error('Sin conexión. Revisa la cobertura y vuelve a intentarlo.'); })
      .then(function (m) { return { via: 'aviso', id: (m && m.id) || '' }; });
  }
  // ---- Aviso en el móvil al terminar (notificación con sonido y vibración) ----
  // La primera vez que se pulsa un botón, el móvil pregunta si se permiten las
  // notificaciones. Con permiso, el pedido lleva la «suscripción» de este móvil
  // y la nube manda el aviso al terminar, aunque la app esté cerrada.
  function claveMovil() { return root.getAttribute('data-movil') || ''; }
  function movilPosible() {
    return !!(claveMovil() && window.isSecureContext && 'serviceWorker' in navigator &&
      'PushManager' in window && 'Notification' in window);
  }
  function bytesB64(t) {
    var b = atob((t + '==='.slice((t.length + 3) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    var a = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
    return a;
  }
  function mismaClave(sub) {
    try {
      var k = sub.options && sub.options.applicationServerKey;
      if (!k) return true;
      var a = new Uint8Array(k), b = bytesB64(claveMovil());
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    } catch (e) { return true; }
  }
  function conTiempo(p, ms) {
    return Promise.race([p, new Promise(function (r) { setTimeout(function () { r(null); }, ms); })]);
  }
  function suscripcionMovil(preguntar) {
    // → { estado: 'si' | 'bloqueado' | 'no' | 'fallo' | '', sub: texto JSON o '' }
    if (!movilPosible()) return Promise.resolve({ estado: 'no', sub: '' });
    var perm = Notification.permission;
    // (si el móvil no contesta a la pregunta en 25 s, el pedido sale igual, sin aviso)
    var p = perm === 'default' && preguntar
      ? conTiempo(new Promise(function (res) {
          var r = Notification.requestPermission(res); if (r && r.then) r.then(res, function () { res('default'); });
        }), 25000)
      : Promise.resolve(perm);
    return p.then(function (r) {
      if (r === 'denied') return { estado: 'bloqueado', sub: '' };
      if (r !== 'granted') return { estado: '', sub: '' };
      return conTiempo(navigator.serviceWorker.register('sw.js').then(function () { return navigator.serviceWorker.ready; })
        .then(function (reg) {
          return reg.pushManager.getSubscription().then(function (s) {
            if (s && !mismaClave(s)) return s.unsubscribe().then(function () { return null; });
            return s;
          }).then(function (s) {
            return s || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytesB64(claveMovil()) });
          });
        }), 12000).then(function (s) {
        if (!s) return { estado: 'fallo', sub: '' };
        var j = s.toJSON();
        return { estado: 'si', sub: JSON.stringify({ endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } }) };
      });
    }).catch(function () { return { estado: 'fallo', sub: '' }; });
  }

  function pedir(inputs, aviso, movil) {
    if (root.getAttribute('data-v3-preview') === '1') {
      return Promise.reject(new Error('Vista de pruebas 3.0: no envía pedidos ni modifica la app estable.'));
    }
    var m = { estado: '', sub: '' };
    return Promise.resolve(movil).then(function (r) {
      if (r) m = r;
      if (m.sub) inputs.movil = m.sub;
      return leerLlave();
    }).then(function (t) {
      if (!t) {
        if (canal()) return avisar(inputs);
        var e = new Error('sin-llave'); e.sinLlave = true; throw e;
      }
      return gh(t, 'POST', '/repos/' + repo() + '/actions/workflows/precios.yml/dispatches',
        { ref: 'main', inputs: inputs }).then(function () { return { via: 'llave' }; }, function (e) {
        if (e && e.llave === 'mala') {
          lsSet(LLAVE, null);                    // caducada o borrada: se olvida
          if (canal()) return avisar(inputs);    // y el pedido va por el canal de avisos
        }
        throw e;
      });
    }).then(function (r) {
      lsSet(PEDIDO, { accion: inputs.accion, at: Date.now(), built: (window.__bsShell || {}).built || '', aviso: aviso,
        via: r.via, id: r.id || '', movil: m.estado });
      estadoPedido();
    });
  }
  function limite(p) { return p && p.via === 'aviso' ? PEDIDO_AVISO_MS : PEDIDO_MS; }

  // ---------- última lectura de Booking (la anota la nube en cada consulta) ----------
  function lectura() { return { at: root.getAttribute('data-lectura') || '', res: root.getAttribute('data-lectura-res') || '' }; }
  function diaDe(iso) {
    var t = new Date(iso); if (isNaN(t)) return '';
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(t); } catch (e) { return iso.slice(0, 10); }
  }
  function horaDe(iso) {
    var t = new Date(iso); if (isNaN(t)) return '';
    try { return t.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' }); } catch (e) { return iso.slice(11, 16); }
  }
  function mananaDe(iso) { var m = new Date(iso + 'T12:00:00Z'); m.setUTCDate(m.getUTCDate() + 1); return m.toISOString().slice(0, 10); }
  function cuandoLectura() {
    var l = lectura(); if (!l.at) return '';
    var d = diaDe(l.at), h = horaDe(l.at);
    return d === hoyMadrid() ? 'hoy a las ' + h : 'el ' + es(d) + ' a las ' + h;
  }
  function horario() {
    var m = root.getAttribute('data-manana') || '08:45', r = root.getAttribute('data-horas') || '';
    return r ? m + ', ' + r : m;
  }

  // ---------- conectar la llave desde el propio botón ----------
  function llaveHTML(box, cabecera, problema) {
    box.innerHTML = '';
    if (cabecera) {
      var c = document.createElement('div'); c.className = 'aviso ok'; c.setAttribute('role', 'status');
      c.innerHTML = cabecera; box.appendChild(c);
    }
    var d = document.createElement('div'); d.className = 'aviso info activar';
    d.innerHTML = '<strong>Activa «Actualizar ahora» (se hace una sola vez).</strong> Para pedir a Booking una consulta nueva en el momento, ' +
      'la app necesita una llave de tu cuenta de GitHub' + (dueno() ? ' (<strong>' + dueno() + '</strong>)' : '') + '. Solo la puedes crear tú; son 2 minutos.' +
      '<ol><li>Pulsa «Crear la llave en GitHub» y entra con tu cuenta si te lo pide.</li>' +
      '<li>En «Repository access» elige «Only select repositories» y marca <strong>' + nombreRepo() + '</strong>. Los permisos ya vienen puestos.</li>' +
      '<li>Abajo del todo pulsa «Generate token» y copia la llave (empieza por <code>github_pat_</code>).</li>' +
      '<li>Vuelve aquí, pégala y pulsa «Guardar y actualizar».</li></ol>' +
      '<p><a class="btn ghost" target="_blank" rel="noopener" data-crear-llave>Crear la llave en GitHub</a></p>' +
      '<form data-llave-rapida autocomplete="off"><label for="llave-rapida">Llave de GitHub</label>' +
      '<input id="llave-rapida" name="llave" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="github_pat_…" required>' +
      '<button class="btn" type="submit">Guardar y actualizar</button></form>' +
      '<p class="huella-msg" data-llave-rapida-msg></p>' +
      '<p class="nota-activar">Mientras tanto, la app sigue consultando Booking sola cada día a las ' + horario() + '.</p>';
    $('[data-crear-llave]', d).href = urlCrearLlave();
    box.appendChild(d);
    var form = $('[data-llave-rapida]', d), msg = $('[data-llave-rapida-msg]', d);
    if (problema) setMsg(msg, problema, 'error');
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var b = form.querySelector('button');
      b.disabled = true; setMsg(msg, 'Comprobando la llave…');
      guardarLlave(form.llave.value).then(function () {
        form.reset(); setMsg(msg, 'Llave guardada (cifrada) en este móvil. Pidiendo la consulta…', 'ok');
        return pedir({ accion: 'precios' }, 'Consultando Booking de nuevo…');
      }).catch(function (e) { b.disabled = false; setMsg(msg, e.message || 'No se pudo guardar la llave.', 'error'); });
    });
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function textoAlDia() {
    var cu = cuandoLectura();
    return '<strong>Comprobado: no hay nada más nuevo publicado.</strong> ' +
      (cu ? 'Los precios que ves se leyeron en Booking ' + cu + '.' : 'Ya ves la última versión de la app.');
  }
  function errorHTML(box, msg, reintentar) {
    box.innerHTML = '';
    var d = document.createElement('div'); d.className = 'aviso error'; d.textContent = msg;
    if (reintentar) d.appendChild(botonReintentar());
    box.appendChild(d);
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function botonReintentar() {
    var w = document.createElement('div'); w.style.marginTop = '.6rem';
    var b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = 'Volver a intentar';
    b.setAttribute('data-nube-accion', 'precios'); b.style.minHeight = '44px';
    w.appendChild(b); return w;
  }

  // ---------- seguimiento de la consulta pedida ----------
  var sondeo = null, MARGEN = 2 * 60 * 1000, SONDEO_MS = 15000;
  function masNueva(a, b) { var x = Date.parse(a), y = Date.parse(b); return !isNaN(x) && (isNaN(y) || x > y); }
  function irAVersion(v) { location.replace(pagina() + '?v=' + encodeURIComponent(v)); }
  function pedidoHecho(p) {
    if (p.accion === 'precios') {  // hecho = hay una lectura de Booking posterior a pulsar el botón
      var t = Date.parse(lectura().at);
      return !isNaN(t) && t >= p.at - MARGEN;
    }
    return masNueva((window.__bsShell || {}).built, p.built);
  }
  function verificado(box, p) {
    var l = lectura(), h = horaDe(l.at), hoy = hoyMadrid(), visto = root.getAttribute('data-hoy');
    var d = document.createElement('div'); d.setAttribute('role', 'status');
    if (l.res === 'error') {
      d.className = 'aviso warn';
      d.innerHTML = '<strong>Booking no respondió en la consulta de las ' + h + '.</strong> Siguen a la vista los últimos precios buenos (nunca se inventa ninguno). Prueba otra vez en unos minutos.';
      d.appendChild(botonReintentar());
    } else if (visto !== hoy || diaDe(l.at) !== hoy) {
      d.className = 'aviso warn';
      d.innerHTML = '<strong>Consulta hecha, pero la app no muestra la fecha de hoy (' + es(hoy) + ').</strong> Vuelve a pulsar «Actualizar ahora».';
    } else {
      var que = l.res === 'sin_cambios' ? 'Los precios no han cambiado desde la consulta anterior. ' :
        l.res === 'cambios' ? 'Algún precio ha cambiado y ya ves el nuevo. ' : '';
      d.className = 'aviso ok';
      d.innerHTML = '<strong>Listo: Booking consultado de nuevo hoy a las ' + h + '.</strong> ' + que +
        'Verificado: son los precios más recientes de hoy (' + es(hoy) + ') y mañana (' + es(mananaDe(hoy)) + ').';
    }
    box.appendChild(d);
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function recogido(p) {
    // ¿Ha recogido ya el vigilante este aviso? (hora en que lo recogió, o null)
    var desde = Math.floor((p.at - MARGEN) / 1000);
    return fetch(NTFY + encodeURIComponent(canal()) + '/json?poll=1&since=' + desde, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : ''; }).then(function (txt) {
        var cuando = null;
        String(txt || '').split('\n').forEach(function (l) {
          try {
            var m = JSON.parse(l), d = JSON.parse(m.message || 'null');
            if (d && d.recogido && (d.recogido.indexOf(p.id) >= 0 || (!p.id && d.lanzado === p.accion))) cuando = m.time;
          } catch (e) { /* línea vacía */ }
        });
        return cuando;
      }).catch(function () { return null; });
  }
  function etapa(p) {
    // Cómo va la consulta en la nube (si GitHub no contesta, simplemente no se muestra).
    if (p.via === 'aviso') {
      return recogido(p).then(function (t) { return { aviso: true, recogido: t }; });
    }
    return leerLlave().then(function (t) {
      if (!t) return null;
      return gh(t, 'GET', '/repos/' + repo() + '/actions/workflows/precios.yml/runs?event=workflow_dispatch&per_page=5').then(function (r) {
        var runs = (r.workflow_runs || []).filter(function (x) { return Date.parse(x.created_at) >= p.at - MARGEN; });
        return runs.length ? runs[runs.length - 1] : null;
      });
    }).catch(function () { return null; });
  }
  function textoEtapa(run) {
    if (run && run.aviso) {
      return run.recogido ? 'La nube lo recogió a las ' + horaDe(new Date(run.recogido * 1000).toISOString()) + ': leyendo los precios en Booking…'
        : 'Aviso enviado. La nube lo recoge en unos minutos…';
    }
    if (!run || run.status === 'queued' || run.status === 'waiting' || run.status === 'pending' || run.status === 'requested') return 'En cola en la nube…';
    if (run.status !== 'completed') return 'Leyendo los precios en Booking…';
    if (run.conclusion === 'success') return 'Booking leído. Publicando en la app…';
    return '';
  }
  function parar() { if (sondeo) { clearInterval(sondeo); sondeo = null; } }
  function mirar() {
    var q = lsGet(PEDIDO); if (!q) { parar(); return; }
    fetch('version.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (v) {
      q = lsGet(PEDIDO); if (!q) { parar(); return; }
      if (v.built_at && masNueva(v.built_at, (window.__bsShell || {}).built)) {
        if (q.accion !== 'precios') lsSet(PEDIDO, null);  // la de precios se verifica al abrir la versión nueva
        parar(); irAVersion(v.built_at); return;
      }
      if (Date.now() - q.at > limite(q)) { parar(); estadoPedido(); return; }
      return etapa(q).then(function (run) {
        if (!lsGet(PEDIDO)) return;
        if (run && run.status === 'completed' && run.conclusion === 'failure') {
          lsSet(PEDIDO, null); parar(); estadoPedido();
          errorHTML($('#nube-pedido'), 'La consulta en la nube no pudo terminar. Siguen a la vista los últimos precios buenos.', true);
          return;
        }
        var el = $('[data-etapa]'), txt = textoEtapa(run);
        if (el && txt) el.textContent = txt;
      });
    }).catch(function () { /* sin conexión: se vuelve a mirar */ });
  }
  function estadoPedido() {
    var box = $('#nube-pedido');
    if (!box) return;
    var p = lsGet(PEDIDO), hecho = null;
    if (p && pedidoHecho(p)) { lsSet(PEDIDO, null); hecho = p; p = null; }
    box.innerHTML = '';
    $$('[data-nube-accion], form[action^="/precios/hoteles/"] button').forEach(function (b) { b.disabled = !!p; });
    if (hecho) { parar(); if (hecho.accion === 'precios') verificado(box, hecho); return; }
    if (!p) { parar(); return; }
    var edad = Date.now() - p.at;
    var d = document.createElement('div');
    if (edad > limite(p)) {
      parar();
      d.className = 'aviso warn';
      d.innerHTML = '<strong>La consulta está tardando más de lo normal.</strong> Puede que Booking no respondiera; la app se reintenta sola. ';
      var w = document.createElement('div'); w.style.marginTop = '.6rem';
      var b = document.createElement('button'); b.type = 'button'; b.className = 'btn ghost'; b.textContent = 'Entendido';
      b.style.minHeight = '44px';
      b.addEventListener('click', function () { lsSet(PEDIDO, null); estadoPedido(); });
      w.appendChild(b); d.appendChild(w);
      box.appendChild(d);
      return;
    }
    d.className = 'aviso warn'; d.setAttribute('role', 'status');
    d.innerHTML = '<strong>' + (p.aviso || 'Consultando Booking en la nube…') + '</strong> ' +
      '<span data-etapa>Pedido enviado a las ' + horaDe(new Date(p.at).toISOString()) + '.</span> ' +
      (p.via === 'aviso' ? 'Tarda entre 5 y 15 minutos' : 'Tarda unos 5 minutos') +
      '; no tienes que hacer nada más: esta página se actualiza sola' + (p.accion === 'precios' ? ' y te dice cuándo ya son los precios más recientes' : '') + '. ' +
      'Puedes cerrar la app: la consulta sigue y se guarda en el Histórico.' +
      (p.movil === 'si' ? ' <strong>Cuando termine te llegará un aviso al móvil.</strong>'
        : p.movil === 'bloqueado' ? ' (Las notificaciones de esta app están bloqueadas en el móvil: si quieres que te avise al terminar, actívalas en «Huella y contraseña».)' : '');
    box.appendChild(d);
    if (!sondeo) { sondeo = setInterval(mirar, SONDEO_MS); setTimeout(mirar, 3000); }
  }

  // ---------- comprobaciones de fecha y versión ----------
  function comprobarFecha() {
    var box = $('#nube-fecha'); if (!box) return;
    var visto = root.getAttribute('data-hoy'), hoy = hoyMadrid();
    if (!visto || visto >= hoy) return;
    var d = document.createElement('div'); d.className = 'aviso warn';
    var manana = new Date(hoy + 'T12:00:00Z'); manana.setUTCDate(manana.getUTCDate() + 1);
    d.innerHTML = '<strong>Ojo: estás viendo los precios del ' + es(visto) + '.</strong> Hoy es ' + es(hoy) +
      ' (mañana ' + es(manana.toISOString().slice(0, 10)) + '). La consulta de hoy se hace sola a las ' + (root.getAttribute('data-manana') || '08:45') + '; ' +
      'en cuanto esté lista aparece aquí. ';
    var w = document.createElement('div'); w.style.marginTop = '.6rem';
    var b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = 'Consultar ahora';
    b.setAttribute('data-nube-accion', 'precios'); b.style.minHeight = '44px';
    w.appendChild(b); d.appendChild(w);
    box.appendChild(d);
  }
  function comprobarVersion() {
    var mia = (window.__bsShell || {}).built;
    if (!mia) return;
    fetch('version.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (v) {
      if (v.built_at && masNueva(v.built_at, mia)) irAVersion(v.built_at);
    }).catch(function () { /* nada */ });
  }

  // ---------- dentro de la app ----------
  function enlazarBotones() {
    var estado = $('#nube-estado');
    function onError(e) {
      var box = $('#nube-pedido');
      if (e && e.sinLlave) llaveHTML(box, textoAlDia());
      else if (e && e.llave) llaveHTML(box, '', e.message);
      else errorHTML(box, (e && e.message) || 'No se pudo pedir la consulta.', true);
    }
    function actualizar(b, movil) {
      // 1) ¿Hay ya algo más nuevo publicado? Se abre.  2) Se pide a Booking una lectura nueva
      //    y, al terminar, se verifica que lo que se ve es lo más reciente.
      b.disabled = true;
      var mia = (window.__bsShell || {}).built;
      leerLlave().then(function (t) {
        if (t || canal()) return pedir({ accion: 'precios' }, 'Consultando Booking de nuevo…', movil);
        return fetch('version.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.json(); }, function () { return {}; })
          .then(function (v) {
            if (v && v.built_at && masNueva(v.built_at, mia)) { ssSet(FRESCA, '1'); irAVersion(v.built_at); return; }
            b.disabled = false;
            var e = new Error('sin-llave'); e.sinLlave = true; throw e;
          });
      }).catch(function (e) { b.disabled = false; onError(e); });
    }
    document.addEventListener('click', function (ev) {
      var b = ev.target.closest && ev.target.closest('[data-nube-accion]');
      if (!b) return;
      ev.preventDefault();
      if (lsGet(PEDIDO)) return;
      actualizar(b, suscripcionMovil(true));   // el permiso se pide con el toque (una sola vez)
    });
    $$('form[action="/precios/hoteles/buscar"]').forEach(function (f) {
      f.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var q = (f.q && f.q.value || '').trim();
        if (q.length < 3) { errorHTML($('#nube-pedido'), 'Escribe al menos 3 letras del hotel o del pueblo.'); return; }
        var destino = f.dest_id ? [f.dest_id.value, f.dest_type ? f.dest_type.value : 'city', f.city ? f.city.value : ''].join('|') : '';
        pedir({ accion: 'buscar', texto: q.slice(0, 120), destino: destino }, 'Buscando «' + q.slice(0, 60) + '» en Booking…',
          suscripcionMovil(true)).catch(onError);
      });
    });
    $$('form[action="/precios/hoteles/cambiar"]').forEach(function (f) {
      f.addEventListener('submit', function (ev) {
        if (ev.defaultPrevented) return;  // «¿Quitar…?» cancelado
        ev.preventDefault();
        var v = function (n) { return f.elements[n] ? String(f.elements[n].value || '').trim() : ''; };
        var cambio = v('action'), old = v('old_slug');
        if (cambio === 'replace' && !old) cambio = 'add';
        var aviso = cambio === 'remove' ? 'Quitando el hotel de la comparativa…' : 'Cambiando la lista y consultando el hotel nuevo…';
        pedir({ accion: 'cambiar', cambio: cambio, texto: v('url') || v('slug'), hotel_actual: old,
          nombre: v('name'), ciudad: v('city') }, aviso, suscripcionMovil(true)).catch(onError);
      });
    });
    // Excel del histórico (va cifrado)
    $$('a[href="historico-precios.xlsx"]').forEach(function (a) {
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        Promise.all([claveSesion(), fetch('historico-precios.xlsx.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.json(); })])
          .then(function (r) { return descifrar(r[0], r[1]); }).then(function (buf) {
            var blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            var u = URL.createObjectURL(blob), x = document.createElement('a');
            x.href = u; x.download = 'historico-precios-' + hoyMadrid() + '.xlsx';
            document.body.appendChild(x); x.click(); x.remove();
            setTimeout(function () { URL.revokeObjectURL(u); }, 4000);
          }).catch(function () { errorHTML($('#nube-pedido'), 'No se pudo descargar el Excel. Vuelve a entrar y prueba otra vez.'); });
      });
    });
    $$('[data-salir]').forEach(function (a) {
      a.addEventListener('click', function (ev) { ev.preventDefault(); cerrarSesion(); location.replace('index.html'); });
    });
    if (estado) estado.hidden = false;
  }

  function enlazarHuella() {
    var s = sesion();
    var aviso = $('#huella-aviso');
    Promise.all([huellaDisponible(), huellaGuardada()]).then(function (r) {
      var disp = r[0], rec = r[1];
      if (aviso && disp && !rec && s && s.m === 'password' && !lsGet(HUELLA_NO)) aviso.hidden = false;
      var sit = $('[data-huella-situacion]');
      if (sit) sit.textContent = rec ? 'En este móvil: huella activada el ' + es(rec.created.slice(0, 10)) + '/' + rec.created.slice(0, 4) + '.' : 'En este móvil: huella sin activar.';
      var quitar = $('[data-huella-quitar]'); if (quitar) quitar.hidden = !rec;
      $$('[data-huella-activar]').forEach(function (b) { if (rec && b.closest('.card')) b.textContent = 'Volver a activar la huella'; });
      var why = $('[data-huella-motivo]');
      if (why && !disp) {
        why.hidden = false;
        why.textContent = motivoSinHuella() || 'Este móvil no tiene lector de huella o bloqueo de pantalla configurado.';
        $$('[data-huella-activar]').forEach(function (b) { b.disabled = true; });
      }
    });
    $$('[data-huella-activar]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var box = btn.closest('[data-huella-box]') || document, msg = $('[data-huella-estado]', box);
        btn.disabled = true; setMsg(msg, 'Pon el dedo en el lector cuando el móvil te lo pida…');
        activarHuella().then(function () {
          setMsg(msg, 'Huella activada en este móvil. La próxima vez pulsa «Entrar con huella».', 'ok');
          if (aviso && box !== aviso) aviso.hidden = true;
          setTimeout(function () { if (box === aviso) aviso.hidden = true; else enlazarHuellaEstado(); }, 1800);
        }).catch(function (e) { setMsg(msg, explicar(e, true), 'error'); }).then(function () { btn.disabled = false; });
      });
    });
    var no = aviso && $('[data-huella-no]', aviso);
    if (no) no.addEventListener('click', function () { lsSet(HUELLA_NO, 1); aviso.hidden = true; });
    var q = $('[data-huella-quitar]');
    if (q) q.addEventListener('click', function () {
      if (!confirm('¿Quitar la huella de este móvil? Tendrás que entrar con la contraseña.')) return;
      quitarHuella().then(function () { setMsg($('[data-huella-estado]'), 'Huella quitada de este móvil.', 'ok'); enlazarHuellaEstado(); });
    });
  }
  function enlazarHuellaEstado() {
    huellaGuardada().then(function (rec) {
      var sit = $('[data-huella-situacion]');
      if (sit) sit.textContent = rec ? 'En este móvil: huella activada el ' + es(rec.created.slice(0, 10)) + '/' + rec.created.slice(0, 4) + '.' : 'En este móvil: huella sin activar.';
      var quitar = $('[data-huella-quitar]'); if (quitar) quitar.hidden = !rec;
    });
  }

  function enlazarMovil() {
    var box = $('[data-movil-box]'); if (!box) return;
    var sit = $('[data-movil-situacion]', box), msg = $('[data-movil-msg]', box), btn = $('[data-movil-activar]', box);
    function pintar() {
      if (!movilPosible()) {
        sit.textContent = 'Este navegador no permite avisos. Abre la app con Chrome en el móvil.'; btn.hidden = true; return;
      }
      var p = Notification.permission;
      sit.innerHTML = p === 'granted' ? 'Avisos: <strong>activados</strong> en este móvil.'
        : p === 'denied' ? 'Avisos: <strong>bloqueados</strong> en este móvil. Para activarlos: Ajustes del móvil › Aplicaciones › Chrome (o Panel HR) › Notificaciones › Permitir.'
        : 'Avisos: sin activar.';
      btn.textContent = p === 'granted' ? 'Probar el aviso' : 'Activar y probar el aviso';
    }
    pintar();
    btn.addEventListener('click', function () {
      btn.disabled = true; setMsg(msg, 'Activando…');
      suscripcionMovil(true).then(function (r) {
        pintar();
        if (r.estado === 'bloqueado') { setMsg(msg, 'El móvil tiene bloqueadas las notificaciones de esta app (arriba pone cómo activarlas).', 'error'); return; }
        if (r.estado !== 'si') { setMsg(msg, 'No se pudieron activar los avisos en este móvil. Prueba otra vez con buena cobertura.', 'error'); return; }
        return navigator.serviceWorker.ready.then(function (reg) {
          return reg.showNotification('Panel HR', { body: 'Así te avisaré cuando terminen de actualizarse los precios.',
            icon: 'icono-192.png', badge: 'insignia-96.png', vibrate: [300, 120, 300], tag: 'panel-hr-prueba', renotify: true });
        }).then(function () { setMsg(msg, 'Listo: te acaba de llegar un aviso de prueba. Así te avisaré al terminar «Actualizar ahora».', 'ok'); });
      }).catch(function () { setMsg(msg, 'No se pudo mostrar el aviso de prueba.', 'error'); })
        .then(function () { btn.disabled = false; });
    });
  }

  function enlazarLlave() {
    var box = $('[data-llave-box]'); if (!box) return;
    var sit = $('[data-llave-situacion]', box), form = $('[data-llave-form]', box), msg = $('[data-llave-msg]', box);
    var quitar = $('[data-llave-quitar]', box);
    $$('[data-crear-llave]', box).forEach(function (a) { a.href = urlCrearLlave(); });
    function pintar() {
      leerLlave().then(function (t) {
        sit.innerHTML = t ? 'Llave: <strong>conectada</strong> en este móvil. Los botones funcionan.' : 'Llave: sin conectar.';
        quitar.hidden = !t;
      });
    }
    pintar();
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var b = form.querySelector('button');
      b.disabled = true; setMsg(msg, 'Comprobando la llave…');
      guardarLlave(form.llave.value).then(function () {
        form.reset();
        setMsg(msg, 'Llave guardada (cifrada) en este móvil. Ya funcionan «Actualizar ahora» y el cambio de hoteles.', 'ok');
        pintar();
      }).catch(function (e) { setMsg(msg, e.message, 'error'); }).then(function () { b.disabled = false; });
    });
    quitar.addEventListener('click', function () {
      lsSet(LLAVE, null); setMsg(msg, 'Llave quitada de este móvil.', 'ok'); pintar();
    });
  }

  function enlazarContrasena() {
    var form = $('form[data-nube-contrasena]'); if (!form) return;
    var msg = $('[data-pw-msg]');
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var a = form.actual.value, n = form.nueva.value, r = form.repetir.value, b = form.querySelector('button');
      if (n.length < 8) { setMsg(msg, 'La contraseña nueva debe tener al menos 8 caracteres.', 'error'); return; }
      if (n !== r) { setMsg(msg, 'Las dos contraseñas nuevas no coinciden.', 'error'); return; }
      b.disabled = true; setMsg(msg, 'Comprobando…');
      var token;
      leerLlave().then(function (t) {
        if (!t) throw new Error('Para cambiar la contraseña conecta antes la llave de GitHub (tarjeta «Botones de la app»).');
        token = t;
        return leerAcceso();
      }).then(function (acc) {
        return abrirConContrasena(acc, a).catch(function () { throw new Error('La contraseña actual no es correcta.'); });
      }).then(function (raw) {
        var salt = rnd(16), it = 600000;
        return kek(n, salt, it).then(function (k) { return cifrar(k, raw); }).then(function (w) {
          return { v: 1, kdf: 'PBKDF2-SHA256', iterations: it, salt: bytesToB64(salt), iv: w.iv, ct: w.ct,
            changed: new Date().toISOString() };
        });
      }).then(function (nuevo) {
        setMsg(msg, 'Guardando…');
        var path = '/repos/' + repo() + '/contents/datos/acceso_nube.json';
        return gh(token, 'GET', path).then(function (f) {
          return gh(token, 'PUT', path, { message: 'Cambio de contraseña de la app', sha: f.sha,
            content: bytesToB64(enc.encode(JSON.stringify(nuevo, null, 1))) });
        });
      }).then(function () {
        return gh(token, 'POST', '/repos/' + repo() + '/actions/workflows/precios.yml/dispatches',
          { ref: 'main', inputs: { accion: 'publicar' } });
      }).then(function () {
        form.reset();
        setMsg(msg, 'Contraseña cambiada. En unos 3 minutos la nueva sirve para entrar (hasta entonces, la anterior). La huella sigue igual.', 'ok');
      }).catch(function (e) { setMsg(msg, e.message || 'No se pudo cambiar la contraseña.', 'error'); })
        .then(function () { b.disabled = false; });
    });
  }

  function registrarCopia() {
    // Copia sin conexión (sw.js): siempre se pide lo último a internet y,
    // si no hay cobertura, se abre lo último que se vio. Todo sigue cifrado.
    try {
      if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(function () {});
    } catch (e) { /* sin copia */ }
  }
  function avisoRed() {
    var box = $('#nube-red'); if (!box) return;
    box.innerHTML = '';
    if (navigator.onLine !== false) return;
    var d = document.createElement('div'); d.className = 'aviso warn';
    var b = (window.__bsShell || {}).built, cuando = '';
    if (b) { var t = new Date(b); if (!isNaN(t)) cuando = ' (' + t.toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ')'; }
    d.innerHTML = '<strong>Sin conexión.</strong> Estás viendo la última copia guardada en este móvil' + cuando +
      '. Al volver la cobertura se actualiza sola.';
    box.appendChild(d);
  }
  function dentro() {
    if (!sesion()) { location.replace(pagina()); return; }
    window.__bsListo = true;
    var estado = $('#nube-estado');
    if (estado) {
      estado.innerHTML = '<div id="nube-red"></div><div id="nube-fecha"></div><div id="nube-pedido"></div>';
    }
    avisoRed();
    window.addEventListener('offline', avisoRed);
    window.addEventListener('online', function () { avisoRed(); comprobarVersion(); });
    registrarCopia();
    comprobarFecha();
    enlazarBotones();
    estadoPedido();
    if (ssGet(FRESCA)) { ssSet(FRESCA, null); if ($('#nube-pedido')) llaveHTML($('#nube-pedido'), textoAlDia()); }
    enlazarHuella();
    if (root.getAttribute('data-v3-preview') === '1') {
      var nota = document.createElement('div'); nota.className = 'aviso warn';
      nota.textContent = 'Versión 3.0 · vista de pruebas independiente. Datos de la última consulta indicada. No actualiza automáticamente ni modifica la app estable.';
      if (estado) estado.prepend(nota);
      $$('[data-nube-accion], form[action] button[type="submit"]').forEach(function (b) {
        b.disabled = true; b.title = 'No disponible en esta vista de pruebas independiente.';
      });
      $$('[data-llave-box], [data-movil-box]').forEach(function (b) { b.hidden = true; });
      // El visor privado puede bloquear sessionStorage. La llave queda solo
      // en memoria y se navega sin salir del documento; al recargar se pide
      // otra vez la contraseña. No se pone ninguna llave en URLs ni archivos.
      if (window.__hrV3MemoryOnly) {
        $$('a[href]').forEach(function (a) {
          var href = a.getAttribute('href');
          if (!/^(index|historico|hoteles|seguridad)\.html$/.test(href)) return;
          a.addEventListener('click', function (ev) {
            ev.preventDefault();
            fetch(href, { cache: 'no-store' }).then(function (r) {
              if (!r.ok) throw new Error('No se pudo abrir la página.');
              return r.text();
            }).then(function (html) {
              var doc = new DOMParser().parseFromString(html, 'text/html');
              var blob = doc.querySelector('#cifrado');
              if (!blob || !sesion()) throw new Error('Vuelve a entrar con la contraseña.');
              root.setAttribute('data-built', doc.documentElement.getAttribute('data-built') || '');
              root.setAttribute('data-pagina', href);
              return mostrar(b64ToBytes(sesion().k), JSON.parse(blob.textContent), sesion().m);
            }).catch(function (e) { setMsg(estado, e.message, 'error'); });
          });
        });
      }
    } else {
      enlazarLlave();
      enlazarMovil();
      enlazarContrasena();
    }
    comprobarVersion();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') { if (!sesion()) location.replace(pagina()); else comprobarVersion(); }
    });
  }

  function init() {
    if ($('#cifrado') && root.getAttribute('data-puerta') === '1') puerta();
    else if (root.getAttribute('data-nube') === '1') dentro();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
