// The only file that touches the DOM. It reads the registered data, asks RTR for
// HTML strings, fills the containers in index.html, and wires up the pinned
// track, the engine picker and the Episode 1 player.
(function () {
  var RT = window.RT, RTU = window.RTU, RTR = window.RTR;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var observer = null;

  function $(id) { return document.getElementById(id); }
  function hex(c, fallback) { return /^#[0-9a-f]{3,8}$/i.test(String(c)) ? String(c) : fallback; }

  function currentPair() {
    var ids = RTU.pickPair(location.search, RT);
    var a = RT.engines[ids[0]], b = RT.engines[ids[1]];
    if (!a || !b) return null;
    var pair = RT.pairs[a.id + '--' + b.id] || RT.pairs[b.id + '--' + a.id] || null;
    return { a: a, b: b, pair: pair, compare: RT.compare, bench: RT.bench };
  }

  // ---- track ------------------------------------------------------------

  function setActive(chapter, stageId) {
    var groups = chapter.querySelectorAll('[data-stage]');
    for (var i = 0; i < groups.length; i++) {
      if (groups[i].getAttribute('data-stage') === stageId) groups[i].setAttribute('data-active', 'true');
      else groups[i].removeAttribute('data-active');
    }
  }

  // Each chapter highlights the stage whose heading was last scrolled past the
  // upper part of the screen. Queries stay inside the chapter: every chapter has
  // its own track, so the same data-stage ids repeat down the page.
  function watchChapters(ctx) {
    if (observer) observer.disconnect();
    observer = null;
    if (!('IntersectionObserver' in window)) return;
    var questions = ctx.compare.questions;
    var chapters = document.querySelectorAll('#chapters .chapter');
    observer = new IntersectionObserver(function (entries) {
      var seen = [];
      entries.forEach(function (en) {
        var chapter = en.target.closest('.chapter');
        if (chapter && seen.indexOf(chapter) < 0) seen.push(chapter);
      });
      seen.forEach(function (chapter) {
        var q = chapter.__question;
        var heads = chapter.querySelectorAll('.stage-h');
        var line = window.innerHeight * 0.45;
        var active = q.stages[0];
        for (var i = 0; i < heads.length && i < q.stages.length; i++) {
          if (heads[i].getBoundingClientRect().top < line) active = q.stages[i];
        }
        setActive(chapter, active);
      });
    }, { rootMargin: '0px 0px -55% 0px' });
    chapters.forEach(function (chapter, i) {
      chapter.__question = questions[i];
      if (questions[i].stages.length < 2) return;
      chapter.querySelectorAll('.stage-h').forEach(function (h) { observer.observe(h); });
    });
  }

  function goToStage(stageId) {
    var row = $('stage-' + stageId);
    if (!row) return;
    var details = row.querySelector('details');
    if (details) details.open = true;
    row.setAttribute('tabindex', '-1');
    row.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    try { row.focus({ preventScroll: true }); } catch (e) { row.focus(); }
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
    var host = $('chapters');
    host.innerHTML = ctx.compare.questions.map(function (q, i) { return RTR.chapter(q, i, ctx); }).join('');
    // Below 1100px the vertical track is hidden; each chapter gets a strip instead.
    host.querySelectorAll('.chapter').forEach(function (chapter, i) {
      var q = ctx.compare.questions[i];
      var strip = '<div class="track-strip">' + RTR.track(ctx, q.stages[0], { horizontal: true }) + '</div>';
      chapter.firstElementChild.insertAdjacentHTML('afterbegin', strip);
    });
    watchChapters(ctx);
  }

  function renderHero(ctx) {
    var root = document.documentElement.style;
    root.setProperty('--a', hex(ctx.a.color, '#d9662a'));
    root.setProperty('--b', hex(ctx.b.color, '#2b54d0'));
    var h1 = document.querySelector('.hero h1');
    h1.querySelector('.a').textContent = ctx.a.name;
    h1.querySelector('.b').textContent = ctx.b.name;
    // The verdict comes from the pair file. Until it is written, nothing is shown.
    var v = ctx.pair && ctx.pair.verdict;
    var html = '';
    if (v && ((v.a && v.a.length) || (v.b && v.b.length))) {
      [[ctx.a, v.a], [ctx.b, v.b]].forEach(function (p) {
        if (!p[1] || !p[1].length) return;
        html += '<div><h3 style="color:' + hex(p[0].color, '#121212') + '">Reach for ' + RTU.esc(p[0].name) + ' if</h3><ul>' +
          p[1].map(function (t) { return '<li>' + RTU.esc(t) + '</li>'; }).join('') + '</ul></div>';
      });
    }
    var host = $('verdict');
    host.className = html ? 'verdict' : '';
    host.innerHTML = html;
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
      var ids = RTU.pickPair(location.search, RT);
      var next = { a: ids[0], b: ids[1] };
      var which = sel.getAttribute('data-pick'), other = which === 'a' ? 'b' : 'a';
      // Picking the engine already shown on the other side swaps the two.
      if (sel.value === next[other]) next[other] = next[which];
      next[which] = sel.value;
      history.replaceState(null, '', '?a=' + encodeURIComponent(next.a) + '&b=' + encodeURIComponent(next.b) + location.hash);
      render();
    });
  }

  // ---- render -----------------------------------------------------------

  function render() {
    var ctx = currentPair();
    if (!ctx) return;
    renderHero(ctx);
    renderPicker(ctx);
    renderChapters(ctx);
    $('every-stage-rows').innerHTML = RTR.everyStage(ctx);
    renderMethod();
  }

  // ---- Episode 1 player -------------------------------------------------

  function wirePlayer() {
    var dlg = $('player');
    var vid = dlg.querySelector('video');
    function open(e) {
      e.preventDefault();
      if (!dlg.showModal) { location.href = 'video/llama-cpp-request-trace.mp4'; return; }
      dlg.showModal();
      vid.play().catch(function () {});
    }
    document.querySelectorAll('[data-play]').forEach(function (el) { el.addEventListener('click', open); });
    dlg.querySelector('[data-close]').addEventListener('click', function () { dlg.close(); });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', function () { vid.pause(); });
  }

  if (RT.errors && RT.errors.length && window.console) console.warn('Data problems:', RT.errors);
  wireTrack($('chapters'));
  wirePicker();
  wirePlayer();
  render();
})();
