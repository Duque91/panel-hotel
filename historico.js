/* Histórico de precios — interactivo, sin dependencias externas.
 * Niveles: años → año → mes → semana → día.
 * En cada nivel: promedio, mínimos, máximos y noches vendidas.
 * Comparativas: año con año, cualquier mes con cualquier mes (del mismo
 * año o de otro), semana con semana y día con día de otros años.
 *
 * Fuentes: precio de cada hotel en Booking (lecturas diarias de hoy y
 * mañana), media de la competencia y precio medio de mis reservas. Se puede
 * comparar un hotel con otro en el mismo período.
 *
 * Los días sin datos se representan como HUECOS (null), nunca como 0 €.
 * Los gráficos se dibujan en píxeles reales para que las etiquetas se
 * lean bien en el móvil, y cada barra se puede tocar para ver su precio.
 */
(function () {
  'use strict';

  var MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  var MONTHS_FULL = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  var WEEKDAYS = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];

  /* Fuentes: precios de Booking por hotel y tarifa (solo alojamiento / con
   * desayuno; también los hoteles que ya no están en la lista) y,
   * aparte, el precio medio por noche de mis reservas. */
  var SOURCES = {};
  if (typeof HIST !== 'undefined' && HIST.sources) SOURCES = HIST.sources;
  else if (typeof HIST !== 'undefined' && HIST.days) SOURCES = { 'Mis reservas': { days: HIST.days, kind: 'reservas', unpriced: HIST.unpriced } };
  var SOURCE_NAMES = Object.keys(SOURCES);
  function defaultSource() {
    var mine = SOURCE_NAMES.filter(function (n) { return SOURCES[n].kind === 'booking' && /\(mi hotel\)/.test(n) && Object.keys(SOURCES[n].days).length; });
    if (mine.length) return mine[0];
    var withData = SOURCE_NAMES.filter(function (n) { return Object.keys(SOURCES[n].days).length; });
    return withData[0] || SOURCE_NAMES[0] || null;
  }
  var CURRENT = defaultSource();
  var DAYS = CURRENT ? SOURCES[CURRENT].days : {};
  var KIND = CURRENT ? SOURCES[CURRENT].kind : 'booking';
  var UNPRICED = CURRENT ? (SOURCES[CURRENT].unpriced || 0) : 0;

  var state = { level: 'years', year: null, month: null, week: null, weekYear: null, day: null, cmp: null, vs: null };

  function setSource(name) {
    CURRENT = name; DAYS = SOURCES[name].days; KIND = SOURCES[name].kind;
    UNPRICED = SOURCES[name].unpriced || 0;
    if (state.vs === name) state.vs = null;
  }
  /* ejecuta fn con la serie de otra fuente (para comparar hotel con hotel) */
  function withSource(name, fn) {
    var old = DAYS; DAYS = SOURCES[name].days;
    try { return fn(); } finally { DAYS = old; }
  }
  function countLabel(agg) {
    if (KIND === 'reservas') return agg.nights + (agg.nights === 1 ? ' noche' : ' noches');
    return agg.days + (agg.days === 1 ? ' día con precio' : ' días con precio');
  }

  /* ---------------- utilidades de fechas (todo en UTC) ---------------- */

  function parseIso(s) { var p = s.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function iso(d) { return d.toISOString().slice(0, 10); }
  function validIso(s) { return iso(parseIso(s)) === s; } // detecta 29 feb inexistente, etc.
  function addDays(d, n) { var x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
  function fmtShort(s) { var d = parseIso(s); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; }
  function fmtFull(s) {
    var d = parseIso(s);
    return WEEKDAYS[(d.getUTCDay() + 6) % 7] + ' ' + d.getUTCDate() + ' ' + MONTHS_FULL[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }

  function isoWeek(d) {
    var date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    var dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    var yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    var week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
    return { year: date.getUTCFullYear(), week: week };
  }
  function weekDates(isoYear, week) {
    var jan4 = new Date(Date.UTC(isoYear, 0, 4));
    var dayNum = jan4.getUTCDay() || 7;
    var mon = new Date(jan4); mon.setUTCDate(jan4.getUTCDate() - dayNum + 1 + (week - 1) * 7);
    var out = [];
    for (var i = 0; i < 7; i++) out.push(addDays(mon, i));
    return out;
  }

  /* ---------------- agregaciones ---------------- */

  /* valor de un día: en los precios de Booking, el precio final del día (el
     último que se vio; entra en el histórico a las 00:01); en las reservas, la media */
  function dv(d) { return d ? (d.price != null ? d.price : d.avg) : null; }
  function dayAvg(s) { return DAYS[s] ? dv(DAYS[s]) : null; }

  function aggregate(isos) {
    var vals = [], mins = [], maxs = [], nights = 0, withData = 0;
    isos.forEach(function (s) {
      var d = DAYS[s];
      if (!d) return;
      vals.push(dv(d)); mins.push(d.min); maxs.push(d.max);
      nights += d.n; withData++;
    });
    if (!vals.length) return null;
    var sum = vals.reduce(function (a, b) { return a + b; }, 0);
    return {
      avg: sum / vals.length, min: Math.min.apply(null, mins), max: Math.max.apply(null, maxs),
      nights: nights, days: withData, total: isos.length
    };
  }

  function monthIsos(y, m) {
    var out = [];
    for (var d = 1; d <= daysInMonth(y, m); d++) out.push(iso(new Date(Date.UTC(y, m, d))));
    return out;
  }
  function yearIsos(y) {
    var out = [];
    for (var m = 0; m < 12; m++) out = out.concat(monthIsos(y, m));
    return out;
  }
  function weekIsos(wy, w) { return weekDates(wy, w).map(iso); }

  function allYears() {
    var ys = {};
    Object.keys(DAYS).forEach(function (s) { ys[s.slice(0, 4)] = 1; });
    return Object.keys(ys).map(Number).sort(function (a, b) { return b - a; });
  }
  /* meses con datos: [{y, m}] del más reciente al más antiguo */
  function allMonths() {
    var seen = {};
    var out = [];
    Object.keys(DAYS).sort().reverse().forEach(function (s) {
      var key = s.slice(0, 7);
      if (seen[key]) return;
      seen[key] = 1;
      out.push({ y: +s.slice(0, 4), m: +s.slice(5, 7) - 1 });
    });
    return out;
  }
  /* semanas ISO con datos: [{y, w}] */
  function allWeeks() {
    var seen = {};
    var out = [];
    Object.keys(DAYS).sort().reverse().forEach(function (s) {
      var wk = isoWeek(parseIso(s));
      var key = wk.year + '-W' + wk.week;
      if (seen[key]) return;
      seen[key] = 1;
      out.push(wk);
    });
    return out;
  }

  /* ---------------- formato ---------------- */

  var eur2 = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var pct = new Intl.NumberFormat('es-ES', { style: 'percent', signDisplay: 'always', maximumFractionDigits: 1 });
  function fE2(v) { return eur2.format(v); }
  function diffPct(a, b) { return a === 0 ? null : (b - a) / a; }

  /* ---------------- gráficos SVG (píxeles reales) ---------------- */

  function chartWidth() {
    var v = document.getElementById('vista');
    if (!v) return 640;
    // menos el padding horizontal de la tarjeta que contiene el gráfico (2×16px)
    return Math.max(260, v.clientWidth - 34);
  }

  function svgEl(name, attrs, children) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    (children || []).forEach(function (c) { e.appendChild(c); });
    return e;
  }
  function txt(x, y, s) {
    var t = svgEl('text', { x: x, y: y, 'text-anchor': 'middle', class: 'ax' });
    t.textContent = s; return t;
  }

  /* Envuelve un SVG con una línea de pie donde se ve el precio de la barra
   * tocada. SOLO para gráficos sueltos (comparativas): dentro de una tarjeta
   * clicable, tocar una barra debe NAVEGAR, no quedarse el propio evento. */
  function withCaption(svg, bars) {
    var wrap = document.createElement('div');
    wrap.className = 'chartwrap';
    var cap = document.createElement('div');
    cap.className = 'chartcap';
    cap.textContent = 'Toca una barra para ver su precio';
    wrap.appendChild(svg);
    wrap.appendChild(cap);
    bars.forEach(function (b) {
      function show() { cap.textContent = b._title; cap.classList.add('on'); }
      b.setAttribute('tabindex', '0');
      b.setAttribute('role', 'img');
      b.setAttribute('aria-label', b._title);
      b.addEventListener('click', function (e) { e.stopPropagation(); show(); });
      b.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); show(); }
      });
    });
    return wrap;
  }

  /* Barras de una serie. items: [{label, value|null, title}]
   * opts.interactive=false: sin pie ni eventos (la tarjeta contenedora
   * navega al tocar). El título nativo (hover de escritorio) se conserva. */
  function barsSVG(items, opts) {
    opts = opts || {};
    var W = opts.width || chartWidth(), H = opts.height || 150, padB = 24, padT = 6;
    var bw = W / items.length, max = 0;
    items.forEach(function (it) { if (it.value > max) max = it.value; });
    if (!max) max = 1;
    var svg = svgEl('svg', { width: W, height: H, class: 'chart', role: 'img' });
    var bars = [];
    items.forEach(function (it, i) {
      if (it.value === null || it.value === undefined) {
        // día sin datos: marca tenue, sin altura (no es 0 €)
        svg.appendChild(svgEl('rect', {
          x: i * bw + bw * 0.3, y: H - padB - 3, width: bw * 0.4, height: 3, rx: 1, class: 'gap'
        }));
        return;
      }
      var h = (H - padB - padT) * (it.value / max);
      var bar = svgEl('rect', {
        x: i * bw + bw * 0.18, y: H - padB - h, width: bw * 0.64,
        height: Math.max(h, 2), rx: 2, class: 'bar'
      });
      var t = svgEl('title'); t.textContent = it.title || '';
      bar.appendChild(t);
      bar._title = it.title || '';
      bars.push(bar);
      svg.appendChild(bar);
      if (opts.labels !== false && bw >= 26) svg.appendChild(txt(i * bw + bw / 2, H - 7, it.label));
    });
    if (opts.interactive === false) {
      var wrap = document.createElement('div');
      wrap.className = 'chartwrap';
      wrap.appendChild(svg);
      return wrap;
    }
    return withCaption(svg, bars);
  }

  /* Barras agrupadas (dos series) para comparar; valores nulos = hueco */
  function dualBarsSVG(items, nameA, nameB) {
    var W = chartWidth(), H = 180, padB = 26, padT = 8;
    var bw = W / items.length, max = 0;
    items.forEach(function (it) {
      if (it.a > max) max = it.a; if (it.b > max) max = it.b;
    });
    if (!max) max = 1;
    var svg = svgEl('svg', { width: W, height: H, class: 'chart', role: 'img' });
    var bars = [];
    items.forEach(function (it, i) {
      var cx = i * bw;
      function mk(v, dx, cls, name) {
        if (v === null || v === undefined) return;
        var h = (H - padB - padT) * (v / max);
        var r = svgEl('rect', { x: cx + dx, y: H - padB - h, width: bw * 0.3,
          height: Math.max(h, 2), rx: 2, class: cls });
        r._title = it.label + ' — ' + name + ': ' + fE2(v);
        bars.push(r); svg.appendChild(r);
      }
      mk(it.a, bw * 0.12, 'barA', nameA);
      mk(it.b, bw * 0.52, 'barB', nameB);
      if (bw >= 22) svg.appendChild(txt(cx + bw / 2, H - 7, it.label));
    });
    return withCaption(svg, bars);
  }

  /* Dos líneas superpuestas; huecos cuando no hay dato */
  function lineOverlay(items, labelA, labelB) {
    var W = chartWidth(), H = 190, padB = 26, padT = 10;
    var bw = W / items.length, max = 0;
    items.forEach(function (it) { if (it.a > max) max = it.a; if (it.b > max) max = it.b; });
    if (!max) max = 1;
    var svg = svgEl('svg', { width: W, height: H, class: 'chart', role: 'img' });
    function seg(key, cls) {
      var pts = [], open = false;
      items.forEach(function (it, i) {
        var v = it[key];
        if (v === null || v === undefined) { open = false; return; }
        var y = H - padB - (H - padB - padT) * (v / max);
        if (!open) { pts.push([]); open = true; }
        pts[pts.length - 1].push([(i * bw + bw / 2), y]);
      });
      pts.forEach(function (p) {
        svg.appendChild(svgEl('polyline', {
          points: p.map(function (pt) { return pt[0].toFixed(1) + ',' + pt[1].toFixed(1); }).join(' '),
          class: cls
        }));
      });
    }
    seg('a', 'lineA'); seg('b', 'lineB');
    items.forEach(function (it, i) {
      if (it.label && bw >= 18) svg.appendChild(txt(i * bw + bw / 2, H - 7, it.label));
    });
    var wrap = document.createElement('div');
    wrap.className = 'chartwrap';
    wrap.appendChild(svg);
    var legend = el('div', 'legend');
    legend.appendChild(el('span', 'dotA', labelA));
    legend.appendChild(el('span', 'dotB', labelB));
    wrap.appendChild(legend);
    return wrap;
  }

  /* ---------------- render ---------------- */

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function summaryCard(title, a, extra) {
    var c = el('div', 'card');
    c.appendChild(el('h2', null, title));
    var grid = el('div', 'grid');
    if (a) {
      [['Promedio', fE2(a.avg)], ['Mínimo', fE2(a.min)], ['Máximo', fE2(a.max)]]
        .concat(KIND === 'reservas' ? [['Noches vendidas', a.nights]] : [])
        .concat([['Días con precio', a.days + (a.total ? ' de ' + a.total : '')]])
        .forEach(function (kv) {
          var k = el('div', 'kpi');
          k.appendChild(el('div', 'n', kv[1])); k.appendChild(el('div', 'l', kv[0]));
          grid.appendChild(k);
        });
    } else grid.appendChild(el('p', 'muted', 'Sin datos en este período.'));
    c.appendChild(grid);
    if (extra) c.appendChild(extra);
    return c;
  }

  /* Migas de navegación: cada tramo vuelve de verdad a su nivel */
  function goLevel(level) {
    return function () {
      state.level = level;
      state.cmp = null;
      render();
    };
  }
  function breadcrumb() {
    var parts = [['Histórico', goLevel('years')]];
    if (state.level !== 'years') parts.push([String(state.year), goLevel('year')]);
    if (state.level === 'month' || state.level === 'week' || state.level === 'day')
      parts.push([MONTHS_FULL[state.month], goLevel('month')]);
    if (state.level === 'week' || state.level === 'day')
      parts.push(['semana ' + state.week, goLevel('week')]);
    if (state.level === 'day') parts.push([fmtShort(state.day), null]);
    var nav = el('nav', 'crumbs');
    parts.forEach(function (p, i) {
      if (i) nav.appendChild(el('span', 'sep', '›'));
      if (p[1]) {
        var a = el('button', 'crumb', p[0]); a.onclick = p[1]; nav.appendChild(a);
      } else nav.appendChild(el('span', 'crumb now', p[0]));
    });
    return nav;
  }

  function compareControl(alternatives, currentLabel) {
    var wrap = el('div', 'cmp');
    if (!alternatives.length) return wrap;
    var sel = el('select');
    var opt = el('option'); opt.value = ''; opt.textContent = 'Comparar con…'; sel.appendChild(opt);
    alternatives.forEach(function (a) {
      var o = el('option'); o.value = a.value; o.textContent = a.label; sel.appendChild(o);
    });
    var btn = el('button', 'btn ghost', state.cmp ? 'Quitar comparación' : 'Comparar');
    btn.onclick = function () {
      state.cmp = state.cmp ? null : (sel.value || null);
      render();
    };
    if (state.cmp) sel.value = state.cmp; else sel.value = '';
    wrap.appendChild(el('span', 'muted', 'Comparar ' + currentLabel + ' con:'));
    wrap.appendChild(sel); wrap.appendChild(btn);
    return wrap;
  }

  function comparisonCard(labelA, aggA, labelB, aggB, items, kind) {
    var c = el('div', 'card comparativa');
    c.appendChild(el('h2', null, 'Comparativa'));
    if (!aggA || !aggB) {
      c.appendChild(el('p', 'muted', 'Uno de los dos períodos no tiene datos; no se puede comparar.'));
      return c;
    }
    var grid = el('div', 'grid');
    function side(label, agg) {
      var k = el('div', 'kpi');
      k.appendChild(el('div', 'l', label));
      k.appendChild(el('div', 'n', fE2(agg.avg)));
      k.appendChild(el('div', 'l', countLabel(agg)));
      return k;
    }
    grid.appendChild(side(labelA, aggA));
    grid.appendChild(side(labelB, aggB));
    var d = el('div', 'kpi');
    d.appendChild(el('div', 'l', 'Diferencia: ' + labelB + ' frente a ' + labelA));
    var delta = diffPct(aggA.avg, aggB.avg);
    d.appendChild(el('div', 'n ' + (delta === null ? '' : delta >= 0 ? 'pos' : 'neg'),
      delta === null ? '—' : pct.format(delta)));
    grid.appendChild(d);
    c.appendChild(grid);
    if (items && items.length) {
      c.appendChild(kind === 'line' ? lineOverlay(items, labelA, labelB)
                                   : dualBarsSVG(items, labelA, labelB));
    }
    return c;
  }

  /* ---- comparar hotel con hotel (mismo período) ---- */
  function avgOf(isos) { var a = aggregate(isos); return a ? a.avg : null; }
  function avgVs(isos) { return withSource(state.vs, function () { return avgOf(isos); }); }
  function dayVs(s) { return withSource(state.vs, function () { return dayAvg(s); }); }
  function vsCard(isos, items, kind) {
    var aggB = withSource(state.vs, function () { return aggregate(isos); });
    var c = comparisonCard(CURRENT, aggregate(isos), state.vs, aggB, items, kind);
    c.querySelector('h2').textContent = 'Comparativa entre hoteles (mismo período)';
    return c;
  }

  function sourceBar() {
    var bar = document.getElementById('fuente');
    if (!bar) return;
    bar.innerHTML = '';
    if (!SOURCE_NAMES.length) return;
    var wrap = el('div', 'cmp');
    wrap.appendChild(el('label', 'muted', 'Ver precios de:'));
    var sel = el('select'); sel.id = 'fuente-sel'; sel.setAttribute('aria-label', 'Hotel o serie de precios');
    SOURCE_NAMES.forEach(function (n) {
      var o = el('option'); o.value = n;
      o.textContent = n + (Object.keys(SOURCES[n].days).length ? '' : ' (sin datos)');
      sel.appendChild(o);
    });
    sel.value = CURRENT;
    sel.onchange = function () { setSource(sel.value); state.cmp = null; render(); };
    wrap.appendChild(sel);
    var others = SOURCE_NAMES.filter(function (n) { return n !== CURRENT && SOURCES[n].kind === SOURCES[CURRENT].kind; });
    if (others.length) {
      wrap.appendChild(el('label', 'muted', 'Comparar con:'));
      var vs = el('select'); vs.id = 'vs-sel'; vs.setAttribute('aria-label', 'Comparar con otro hotel');
      var o0 = el('option'); o0.value = ''; o0.textContent = 'ningún otro hotel'; vs.appendChild(o0);
      others.forEach(function (n) { var o = el('option'); o.value = n; o.textContent = n; vs.appendChild(o); });
      vs.value = state.vs || '';
      vs.onchange = function () { state.vs = vs.value || null; state.cmp = null; render(); };
      wrap.appendChild(vs);
    }
    bar.appendChild(wrap);
  }

  /* ---- nivel: años ---- */
  function renderYears() {
    var app = document.getElementById('vista');
    app.innerHTML = '';
    app.appendChild(breadcrumb());
    app.appendChild(el('p', 'muted intro',
      'Toca un año para verlo por meses. Desde ahí puedes bajar a semanas y días, y comparar cualquier período con otro.'));
    var years = allYears();
    if (!years.length) {
      var c = el('div', 'card');
      c.appendChild(el('div', 'empty', '<div class="big">Sin datos históricos todavía</div>'));
      app.appendChild(c); return;
    }
    years.forEach(function (y) {
      var agg = aggregate(yearIsos(y));
      var card = el('div', 'card yearcard');
      card.tabIndex = 0; card.setAttribute('role', 'button');
      card.appendChild(el('h2', null, y + ' <span class="hint">' + (agg ? countLabel(agg) : 'sin datos') + '</span>'));
      var months = [];
      for (var m = 0; m < 12; m++) {
        var ma = aggregate(monthIsos(y, m));
        months.push({ label: MONTHS[m][0], value: ma ? ma.avg : null,
          title: MONTHS_FULL[m] + ' ' + y + ': ' + (ma ? 'promedio ' + fE2(ma.avg) : 'sin datos') });
      }
      card.appendChild(barsSVG(months, { height: 90, interactive: false }));
      if (agg) {
        var row = el('div', 'yearstats');
        row.appendChild(el('span', 'big', fE2(agg.avg) + ' <span class="muted">promedio/año</span>'));
        if (state.vs) {
          var vy = avgVs(yearIsos(y));
          row.appendChild(el('div', 'muted small', state.vs + ': ' + (vy !== null ? fE2(vy) : 'sin datos')));
        }
        card.appendChild(row);
      }
      function go() { state.level = 'year'; state.year = y; state.cmp = null; render(); }
      card.onclick = go;
      card.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
      app.appendChild(card);
    });
  }

  /* ---- nivel: año (12 meses) ---- */
  function renderYear() {
    var app = document.getElementById('vista');
    app.innerHTML = '';
    app.appendChild(breadcrumb());
    var y = state.year;
    var agg = aggregate(yearIsos(y));
    app.appendChild(summaryCard('Año ' + y, agg));
    app.appendChild(compareControl(
      allYears().filter(function (o) { return o !== y; })
        .map(function (o) { return { value: String(o), label: String(o) }; }),
      String(y)));
    if (state.cmp) {
      var y2 = +state.cmp;
      var agg2 = aggregate(yearIsos(y2));
      var items = [];
      for (var m = 0; m < 12; m++) {
        var a1 = aggregate(monthIsos(y, m)), a2 = aggregate(monthIsos(y2, m));
        items.push({ label: MONTHS[m], a: a1 ? a1.avg : null, b: a2 ? a2.avg : null });
      }
      app.appendChild(comparisonCard(String(y), agg, String(y2), agg2, items, 'bars'));
      return;
    }
    if (state.vs) {
      var vItems = [];
      for (var vm = 0; vm < 12; vm++) vItems.push({ label: MONTHS[vm], a: avgOf(monthIsos(y, vm)), b: avgVs(monthIsos(y, vm)) });
      app.appendChild(vsCard(yearIsos(y), vItems, 'bars'));
    }
    for (var mm = 0; mm < 12; mm++) {
      (function (m) {
        var ma = aggregate(monthIsos(y, m));
        if (!ma) return; // meses sin datos no se muestran
        var card = el('div', 'card monthcard');
        card.tabIndex = 0; card.setAttribute('role', 'button');
        card.appendChild(el('h2', null, MONTHS_FULL[m] + ' <span class="hint">' +
          fE2(ma.avg) + ' de media</span>'));
        var days = [];
        for (var d = 1; d <= daysInMonth(y, m); d++) {
          var s = iso(new Date(Date.UTC(y, m, d)));
          var dv = dayAvg(s);
          days.push({ label: (d % 5 === 0 || d === 1) ? String(d) : '',
            value: dv, title: fmtFull(s) + ': ' + (dv !== null ? fE2(dv) : 'sin datos') });
        }
        card.appendChild(barsSVG(days, { height: 70, interactive: false }));
        card.appendChild(el('p', 'muted small',
          'Toca para ver las semanas de ' + MONTHS_FULL[m] + ' con el precio diario más grande.'));
        function go() { state.level = 'month'; state.month = m; state.cmp = null; render(); }
        card.onclick = go;
        card.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
        app.appendChild(card);
      })(mm);
    }
  }

  /* ---- nivel: mes (semanas con precio diario) ---- */
  function renderMonth() {
    var app = document.getElementById('vista');
    app.innerHTML = '';
    app.appendChild(breadcrumb());
    var y = state.year, m = state.month;
    var agg = aggregate(monthIsos(y, m));
    app.appendChild(summaryCard(MONTHS_FULL[m] + ' ' + y, agg));

    // comparar con CUALQUIER otro mes con datos (mismo año u otro año)
    var alts = allMonths()
      .filter(function (o) { return !(o.y === y && o.m === m); })
      .map(function (o) { return { value: o.y + '-' + o.m, label: MONTHS_FULL[o.m] + ' ' + o.y }; });
    app.appendChild(compareControl(alts, MONTHS_FULL[m] + ' ' + y));

    if (state.cmp) {
      var p = state.cmp.split('-');
      var y2 = +p[0], m2 = +p[1];
      var agg2 = aggregate(monthIsos(y2, m2));
      var items = [];
      var dim = Math.max(daysInMonth(y, m), daysInMonth(y2, m2));
      for (var d = 1; d <= dim; d++) {
        var s1 = iso(new Date(Date.UTC(y, m, d)));
        var s2 = iso(new Date(Date.UTC(y2, m2, d)));
        items.push({ label: (d % 2) ? '' : String(d),
          a: (validIso(s1) ? dayAvg(s1) : null),
          b: (validIso(s2) ? dayAvg(s2) : null) });
      }
      app.appendChild(comparisonCard(MONTHS_FULL[m] + ' ' + y, agg, MONTHS_FULL[m2] + ' ' + y2, agg2, items, 'line'));
      return;
    }
    if (state.vs) {
      var mIsos = monthIsos(y, m);
      app.appendChild(vsCard(mIsos, mIsos.map(function (s0, i) {
        return { label: ((i + 1) % 2) ? '' : String(i + 1), a: dayAvg(s0), b: dayVs(s0) };
      }), 'line'));
    }

    // semanas del mes
    var seen = {}, weeks = [];
    for (var d2 = 1; d2 <= daysInMonth(y, m); d2++) {
      var dt = new Date(Date.UTC(y, m, d2));
      var wk = isoWeek(dt);
      var key = wk.year + '-W' + wk.week;
      if (!seen[key]) { seen[key] = 1; weeks.push(wk); }
    }
    weeks.forEach(function (wk) {
      var wdays = weekDates(wk.year, wk.week);
      var inMonth = wdays.filter(function (dt) {
        return dt.getUTCMonth() === m && dt.getUTCFullYear() === y;
      });
      var wagg = aggregate(inMonth.map(iso));
      var card = el('div', 'card weekrow');
      card.tabIndex = 0; card.setAttribute('role', 'button');
      var rango = fmtShort(iso(wdays[0])) + ' – ' + fmtShort(iso(wdays[6]));
      card.appendChild(el('h2', null, 'Semana ' + wk.week + ' <span class="hint">' + rango +
        (wagg ? ' · ' + fE2(wagg.avg) + ' de media' : '') + '</span>'));
      var days = wdays.map(function (dt) {
        var s = iso(dt), v = dayAvg(s);
        return { label: WEEKDAYS[(dt.getUTCDay() + 6) % 7], value: v,
          title: fmtFull(s) + ': ' + (v !== null ? fE2(v) : 'sin datos') };
      });
      card.appendChild(barsSVG(days, { height: 110, interactive: false }));
      // precio diario SIEMPRE visible como texto (en el móvil no hay cursor)
      var vals = el('div', 'dayvalues');
      days.forEach(function (d, i) {
        var cell = el('span', 'dv-cell');
        cell.appendChild(el('span', 'dv-l', d.label));
        cell.appendChild(el('span', 'dv-v', d.value !== null && d.value !== undefined ? fE2(d.value) : '—'));
        vals.appendChild(cell);
      });
      card.appendChild(vals);
      function go() { state.level = 'week'; state.week = wk.week; state.weekYear = wk.year; state.cmp = null; render(); }
      card.onclick = go;
      card.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
      app.appendChild(card);
    });
  }

  /* ---- nivel: semana ---- */
  function renderWeek() {
    var app = document.getElementById('vista');
    app.innerHTML = '';
    app.appendChild(breadcrumb());
    var wk = state.week, wy = state.weekYear || state.year;
    var isos = weekIsos(wy, wk);
    var agg = aggregate(isos);
    app.appendChild(summaryCard('Semana ' + wk + ' de ' + wy + ' <span class="hint">' +
      fmtShort(isos[0]) + ' – ' + fmtShort(isos[6]) + '</span>', agg));

    // comparar con cualquier otra semana con datos de otro año
    var alts = allWeeks()
      .filter(function (o) { return o.year !== wy; })
      .map(function (o) {
        return { value: o.year + '-W' + o.week, label: 'semana ' + o.week + ' de ' + o.year };
      });
    app.appendChild(compareControl(alts, 'esta semana'));

    if (state.cmp) {
      var parts = state.cmp.split('-W');
      var y2 = +parts[0], w2 = +parts[1];
      var agg2 = aggregate(weekIsos(y2, w2));
      var items = [];
      var d1s = weekDates(wy, wk), d2s = weekDates(y2, w2);
      for (var i = 0; i < 7; i++) {
        items.push({ label: WEEKDAYS[i], a: dayAvg(iso(d1s[i])), b: dayAvg(iso(d2s[i])) });
      }
      app.appendChild(comparisonCard('Semana ' + wk + ' ' + wy, agg, 'Semana ' + w2 + ' ' + y2, agg2, items, 'bars'));
      return;
    }
    if (state.vs) {
      app.appendChild(vsCard(isos, isos.map(function (s0, i) {
        return { label: WEEKDAYS[i], a: dayAvg(s0), b: dayVs(s0) };
      }), 'bars'));
    }

    var grid = el('div', 'grid days7');
    isos.forEach(function (s) {
      var d = DAYS[s];
      var cell = el('div', 'daycell');
      cell.tabIndex = 0; cell.setAttribute('role', 'button');
      cell.appendChild(el('div', 'dl', fmtFull(s)));
      if (d) {
        cell.appendChild(el('div', 'dv', fE2(dv(d))));
        if (d.price == null)  // en los precios de Booking hay un solo precio por día: el final
          cell.appendChild(el('div', 'dm', d.min === d.max ? fE2(d.min) : fE2(d.min) + ' – ' + fE2(d.max)));
      } else cell.appendChild(el('div', 'dv muted', 'sin datos'));
      function go() { state.level = 'day'; state.day = s; state.cmp = null; render(); }
      cell.onclick = go;
      cell.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
      grid.appendChild(cell);
    });
    app.appendChild(grid);
    app.appendChild(el('p', 'muted small', 'Toca un día para ver su detalle.'));
  }

  /* ---- nivel: día ---- */
  function renderDay() {
    var app = document.getElementById('vista');
    app.innerHTML = '';
    app.appendChild(breadcrumb());
    var s = state.day, d = DAYS[s];
    // mantener coherentes año/mes/semana con el día mostrado
    var pd = parseIso(s);
    state.year = pd.getUTCFullYear();
    state.month = pd.getUTCMonth();
    var wk = isoWeek(pd);
    state.week = wk.week; state.weekYear = wk.year;

    var card = el('div', 'card');
    card.appendChild(el('h2', null, fmtFull(s)));
    if (d) {
      var grid = el('div', 'grid');
      (d.price != null
        ? [['Precio final del día', fE2(d.price)], ['Última lectura en Booking', d.at || '—']]
        : [['Precio medio', fE2(d.avg)], ['Más barato', fE2(d.min)], ['Más caro', fE2(d.max)],
           [KIND === 'reservas' ? 'Noches vendidas' : 'Lecturas de Booking', d.n]])
        .forEach(function (kv) {
          var k = el('div', 'kpi');
          k.appendChild(el('div', 'n', kv[1])); k.appendChild(el('div', 'l', kv[0]));
          grid.appendChild(k);
        });
      card.appendChild(grid);
    } else {
      card.appendChild(el('p', 'muted', KIND === 'reservas' ? 'Ese día no tiene reservas registradas.' : 'Sin precio ese día: no se consultó o el hotel no aparecía en Booking (completo o sin oferta).'));
    }
    app.appendChild(card);
    if (state.vs) app.appendChild(vsCard([s], [], 'none'));

    // comparar este día con el mismo día de otros años (solo fechas válidas)
    var y = state.year;
    var alts = allYears().filter(function (o) { return o !== y; })
      .map(function (o) { return s.replace(String(y), String(o)); })
      .filter(validIso)
      .map(function (s2) { return { value: s2, label: fmtFull(s2) }; });
    app.appendChild(compareControl(alts, 'este día'));
    if (state.cmp) {
      var s2 = state.cmp, d2 = DAYS[s2];
      app.appendChild(comparisonCard(
        fmtFull(s), d ? { avg: dv(d), min: d.min, max: d.max, nights: d.n, days: 1 } : null,
        fmtFull(s2), d2 ? { avg: dv(d2), min: d2.min, max: d2.max, nights: d2.n, days: 1 } : null,
        [], 'none'));
    }

    // navegación día anterior / siguiente
    var nav = el('div', 'daynav');
    function dayBtn(offset, label) {
      var b = el('button', 'btn ghost', label);
      b.onclick = function () { state.day = iso(addDays(parseIso(s), offset)); state.cmp = null; render(); };
      return b;
    }
    nav.appendChild(dayBtn(-1, '‹ Día anterior'));
    nav.appendChild(dayBtn(1, 'Día siguiente ›'));
    app.appendChild(nav);
  }

  function render() {
    sourceBar();
    try {
      if (state.level === 'years') renderYears();
      else if (state.level === 'year') renderYear();
      else if (state.level === 'month') renderMonth();
      else if (state.level === 'week') renderWeek();
      else if (state.level === 'day') renderDay();
    } catch (e) {
      var app = document.getElementById('vista');
      if (app) app.innerHTML = '<div class="aviso error">No se pudo dibujar el histórico: ' + e.message + '</div>';
    }
    if (document.getElementById('unpriced')) document.getElementById('unpriced').textContent = '';
    if (UNPRICED && KIND === 'reservas' && document.getElementById('unpriced')) {
      document.getElementById('unpriced').textContent =
        UNPRICED + ' reserva(s) sin importe o con noches incoherentes no entran en el histórico.';
    }
  }

  if (typeof document !== 'undefined' && document.getElementById('vista')) {
    render();
    var rt = null;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(render, 200);
    });
  }

  /* exportación de funciones puras para las pruebas */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { aggregate: aggregate, isoWeek: isoWeek, weekDates: weekDates,
      parseIso: parseIso, iso: iso, validIso: validIso, monthIsos: monthIsos, yearIsos: yearIsos,
      dayAvg: dayAvg, allYears: allYears, allMonths: allMonths, allWeeks: allWeeks, render: render };
  }
})();
