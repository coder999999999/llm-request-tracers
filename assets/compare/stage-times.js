// Bench maths for the comparison page: stage times and chart annotations.
// Extends the existing window.RTU. Pure functions, no DOM access.
(function () {
  var RTU = window.RTU = window.RTU || {};

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function med(m) { return m && typeof m === 'object' ? num(m.median) : num(m); }
  function round1(n) { return Math.round(n * 10) / 10; }

  // 2700 -> "2,700", 55.34 -> "55.3". Thousands separators are built by hand
  // so the output does not depend on the host's locale data.
  RTU.fmtNum = function (n) {
    if (typeof n !== 'number' || !isFinite(n)) return 'n/a';
    var r = Math.abs(n) >= 100 ? Math.round(n) : round1(n);
    var parts = String(r).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  };

  function levelAt(bench, users) {
    var levels = bench && Array.isArray(bench.levels) ? bench.levels : [];
    for (var i = 0; i < levels.length; i++) if (levels[i] && levels[i].users === users) return levels[i];
    return null;
  }
  RTU.levelAt = levelAt;

  // Spec 5.5. vLLM reports queue and prefill, so the remainder is derived.
  // llama.cpp reports prefill only, so everything else is "queue + overhead".
  RTU.stageTimes = function (bench, users) {
    var lv = levelAt(bench, users);
    if (!lv) return null;
    var ttft = med(lv.ttft_ms), prefill = med(lv.prefill_ms), queue = med(lv.queue_ms);
    if (ttft === null || prefill === null) return null;
    if (queue !== null) {
      var other = round1(ttft - queue - prefill);
      return {
        think: { ms: round1(prefill), note: 'reported' },
        wait: { ms: round1(queue), note: 'reported' },
        other: other >= 0 ? { ms: other, note: 'derived' } : null
      };
    }
    var wait = round1(ttft - prefill);
    if (wait < 0) return null;
    return {
      think: { ms: round1(prefill), note: 'reported' },
      wait: { ms: wait, note: 'queue + overhead' },
      other: null
    };
  };

  function engineFor(spec, ctx) {
    var e = spec.engine;
    if (e === 'b' || (e && ctx.b && e === ctx.b.id)) return ctx.b;
    return ctx.a;
  }

  // Turns a pair-file annotation spec into {x, y, text}, with numbers read
  // from bench data. Returns null when a needed point is missing.
  //   ratio: b divided by a at x, one decimal. y is midway between the two medians.
  //   value: the named engine's median at x (default engine a).
  RTU.annotate = function (spec, ctx) {
    if (!spec || !ctx || !ctx.a || !ctx.b) return null;
    var bench = ctx.bench || {};
    var metric = spec.metric;
    function at(engine) {
      var lv = levelAt(bench[engine.id], spec.x);
      return lv ? med(lv[metric]) : null;
    }
    var text = String(spec.text === undefined || spec.text === null ? '' : spec.text);
    if (spec.kind === 'ratio') {
      var av = at(ctx.a), bv = at(ctx.b);
      if (av === null || bv === null || av === 0) return null;
      return { x: spec.x, y: (av + bv) / 2, text: text.replace(/\{v\}/g, String(round1(bv / av))) };
    }
    if (spec.kind === 'value') {
      var v = at(engineFor(spec, ctx));
      if (v === null) return null;
      return { x: spec.x, y: v, text: text.replace(/\{v\}/g, RTU.fmtNum(v)) };
    }
    return null;
  };
})();
