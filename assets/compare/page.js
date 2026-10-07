// The only file that touches the DOM. It reads the registered data, asks RTR for
// HTML strings and fills whichever containers the page has: the hero, chapters
// and method on index.html, the stage track and every stage on tracers.html. It
// also wires up the stage track and the engine picker.
(function () {
  var RT = window.RT, RTU = window.RTU, RTR = window.RTR;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function $(id) { return document.getElementById(id); }
  function hex(c, fallback) { return /^#[0-9a-f]{3,8}$/i.test(String(c)) ? String(c) : fallback; }

  // Charts and the boundary diagram are drawn 380 wide when the chapter's main
  // column is under 600px (a phone), 760 wide otherwise, so their text stays readable.
  var NARROW_BELOW = 600;
  function isNarrow() {
    var host = $('chapters');
    return !!host && host.clientWidth > 0 && host.clientWidth < NARROW_BELOW;
  }

  // pickPair already puts the two engines in the pair file's order, so verdict.a,
  // annotation ratios and the lane order do not depend on how the URL names them.
  function currentPair() {
    var ids = RTU.pickPair(location.search, RT);
    var a = RT.engines[ids[0]], b = RT.engines[ids[1]];
    if (!a || !b) return null;
    var pair = RT.pairs[a.id + '--' + b.id] || RT.pairs[b.id + '--' + a.id] || null;
    return { a: a, b: b, pair: pair, compare: RT.compare, bench: RT.bench, narrow: isNarrow() };
  }

  // ---- stage track (tracers.html) ---------------------------------------

  // Opens a stage row's code path and scrolls to it. Used by the stage track and
  // by links from the comparison page (tracers.html#stage-think).
  function goToStage(stageId, instant) {
    var row = $('stage-' + stageId);
    if (!row) return;
    var details = row.querySelector('details');
    if (details) details.open = true;
    row.setAttribute('tabindex', '-1');
    // 'auto' would follow the stylesheet's smooth scrolling; arriving from a link jumps.
    row.scrollIntoView({ behavior: reduced || instant ? 'instant' : 'smooth', block: 'start' });
    try { row.focus({ preventScroll: true }); } catch (e) { row.focus(); }
  }

  // The stage rows are drawn after load, so the browser's own jump to #stage-x
  // finds nothing; this repeats it once the rows exist, and on later hash changes.
  function followHash(instant) {
    var m = /^#stage-([\w-]+)$/.exec(location.hash);
    if (m) goToStage(m[1], instant);
  }

  function wireTrack(host) {
    host.addEventListener('click', function (e) {
      var g = e.target.closest && e.target.closest('[data-stage]');
      if (g && host.contains(g)) goToStage(g.getAttribute('data-stage'));
    });
    host.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var g = e.target.closest && e.target.closest('[data-stage]');
      if (!g) return;
      e.preventDefault();
      goToStage(g.getAttribute('data-stage'));
    });
  }

  // ---- sections ---------------------------------------------------------

  function renderChapters(ctx) {
    $('chapters').innerHTML = ctx.compare.questions.map(function (q, i) { return RTR.chapter(q, i, ctx); }).join('');
  }

  function renderHero(ctx) {
    var h1 = document.querySelector('.hero h1');
    h1.querySelector('.a').textContent = ctx.a.name;
    h1.querySelector('.b').textContent = ctx.b.name;
    // The verdict comes from the pair file. Until it is written, nothing is shown.
    var html = RTR.verdict(ctx);
    var host = $('verdict');
    if (host) {
      host.className = html ? 'verdict' : '';
      host.innerHTML = html;
    }
    var head = $('headline');
    if (head) head.innerHTML = RTR.headline(ctx);
    var chart = $('hero-chart');
    if (chart) chart.innerHTML = RTR.heroChart(ctx);
    // Each question in the list gets its stat, unit and one-line answer; a pair
    // without teasers leaves them empty, and the list drops its stat column.
    var anyTeaser = false;
    document.querySelectorAll('[data-teaser]').forEach(function (el) {
      var t = RTR.teaser(ctx, el.getAttribute('data-teaser'));
      if (t) anyTeaser = true;
      var stat = el.querySelector('.stat'), unit = el.querySelector('.unit'), text = el.querySelector('.tt');
      if (stat) { stat.innerHTML = t ? t.stat : ''; stat.style.color = t ? t.color : ''; }
      if (unit) unit.innerHTML = t ? t.unit : '';
      if (text) text.innerHTML = t ? t.text : '';
    });
    var qs = document.querySelector('.qs');
    if (qs) qs.classList.toggle('no-stats', !anyTeaser);
  }

  function renderMethod() {
    $('method-versions').innerHTML = Object.keys(RT.engines).map(function (id) {
      var e = RT.engines[id];
      return '<a href="' + RTU.esc(e.repo + '/commit/' + e.commit) + '">' + RTU.esc(e.name) + ' ' + RTU.esc(String(e.commit).slice(0, 7)) + '</a>';
    }).join(', ');
  }

  // ---- picker -----------------------------------------------------------

  function renderPicker(ctx) {
    var host = $('picker');
    var ids = Object.keys(RT.engines);
    if (ids.length < 3) { host.innerHTML = ''; return; }
    function select(which, current, label) {
      return '<select aria-label="' + label + '" data-pick="' + which + '">' + ids.map(function (id) {
        return '<option value="' + RTU.esc(id) + '"' + (id === current ? ' selected' : '') + '>' + RTU.esc(RT.engines[id].name) + '</option>';
      }).join('') + '</select>';
    }
    host.innerHTML = select('a', ctx.a.id, 'First engine') + select('b', ctx.b.id, 'Second engine');
  }

  function wirePicker() {
    $('picker').addEventListener('change', function (e) {
      var sel = e.target;
      if (!sel || !sel.getAttribute('data-pick')) return;
      var shown = currentPair();
      var next = { a: shown.a.id, b: shown.b.id };
      var which = sel.getAttribute('data-pick'), other = which === 'a' ? 'b' : 'a';
      // Picking the engine already shown on the other side swaps the two.
      if (sel.value === next[other]) next[other] = next[which];
      next[which] = sel.value;
      history.replaceState(null, '', '?a=' + encodeURIComponent(next.a) + '&b=' + encodeURIComponent(next.b) + location.hash);
      render();
    });
  }

  // ---- render -----------------------------------------------------------

  // Links between the two pages keep the engine pair the reader picked (?a=..&b=..).
  function carryPair() {
    document.querySelectorAll('a[href^="index.html"], a[href^="tracers.html"]').forEach(function (a) {
      var m = /^([\w.-]+\.html)(?:\?[^#]*)?(#.*)?$/.exec(a.getAttribute('href'));
      if (m) a.setAttribute('href', m[1] + location.search + (m[2] || ''));
    });
  }

  function render() {
    var ctx = currentPair();
    if (!ctx) return;
    var root = document.documentElement.style;
    root.setProperty('--a', hex(ctx.a.color, '#d9662a'));
    root.setProperty('--b', hex(ctx.b.color, '#2b54d0'));
    if (document.querySelector('.hero h1 .a')) renderHero(ctx);
    if ($('picker')) renderPicker(ctx);
    if ($('chapters')) renderChapters(ctx);
    if ($('stage-track')) $('stage-track').innerHTML = RTR.track(ctx, null, { horizontal: true });
    if ($('every-stage-rows')) $('every-stage-rows').innerHTML = RTR.everyStage(ctx);
    if ($('method-versions')) renderMethod();
    carryPair();
  }

  // Redraws the charts when the column crosses the phone threshold (not on every resize).
  function wireResize() {
    if (!$('chapters')) return;
    var narrow = isNarrow(), timer = null;
    window.addEventListener('resize', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var now = isNarrow();
        if (now === narrow) return;
        narrow = now;
        var ctx = currentPair();
        if (!ctx) return;
        renderChapters(ctx);
        var chart = $('hero-chart');
        if (chart) chart.innerHTML = RTR.heroChart(ctx);
        carryPair();
      }, 150);
    });
  }

  // ---- tooltips ---------------------------------------------------------

  // Anything with data-tip (chart points, source links) shows its text on hover and
  // on keyboard focus. A chart point's native <title> child is dropped on first use so only one
  // tooltip shows; source links keep their title attribute as the accessible description.
  function wireTips() {
    var tip = document.createElement('div');
    tip.className = 'tip';
    tip.id = 'tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.appendChild(tip);
    var current = null, hovered = null;
    function tipOf(t) { return t && t.closest ? t.closest('[data-tip]') : null; }
    function show(el) {
      var text = el.getAttribute('data-tip');
      if (!text) return;
      var t = el.querySelector('title');
      if (t) el.removeChild(t);
      current = el;
      tip.textContent = text;
      tip.hidden = false;
      var r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
      var left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), Math.max(8, window.innerWidth - w - 8));
      var top = r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8;
      tip.style.left = Math.round(left) + 'px';
      tip.style.top = Math.round(top) + 'px';
    }
    function hide() { current = null; tip.hidden = true; }
    document.addEventListener('mouseover', function (e) { var el = tipOf(e.target); hovered = el; if (el) show(el); else if (current) hide(); });
    document.addEventListener('focusin', function (e) {
      var el = tipOf(e.target), vis = false;
      if (el) { try { vis = el.matches(':focus-visible'); } catch (x) { vis = true; } }
      if (el && vis) show(el); else if (!(el && el === hovered)) hide();
    });
    document.addEventListener('focusout', function () { if (!(hovered && hovered === current)) hide(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
    window.addEventListener('scroll', function () { if (current && !tip.hidden) show(current); }, { passive: true });
  }

  if (RT.errors && RT.errors.length && window.console) console.warn('Data problems:', RT.errors);
  if ($('stage-track')) wireTrack($('stage-track'));
  if ($('picker')) wirePicker();
  wireTips();
  wireResize();
  render();
  followHash(true);
  window.addEventListener('hashchange', function () { followHash(false); });
})();
