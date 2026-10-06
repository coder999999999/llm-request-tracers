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

  // Spec 5.5. Both engines are split the same way so the two bars compare like
  // with like: prefill is reported by the server, and everything before it is
  // derived as first-token time minus prefill. vLLM also reports queue time, which
  // is returned as wait.queue (a part of the derived figure, shown as a note).
  RTU.stageTimes = function (bench, users) {
    var lv = levelAt(bench, users);
    if (!lv) return null;
    var ttft = med(lv.ttft_ms), prefill = med(lv.prefill_ms), queue = med(lv.queue_ms);
    if (ttft === null || prefill === null) return null;
    var before = round1(ttft - prefill);
    if (before < 0) return null;
    return {
      think: { ms: round1(prefill), note: 'reported' },
      wait: { ms: before, note: 'derived', queue: queue === null ? null : round1(queue) }
    };
  };

  function engineFor(spec, ctx) {
    var e = spec.engine;
    if (e === 'b' || (e && ctx.b && e === ctx.b.id)) return ctx.b;
    return ctx.a;
  }

  // Where an annotation's number comes from. 'levels' (default) is the row of
  // bench.levels at users === x; 'kvFull' the row of bench.kvFull at max_tokens === x;
  // 'reuse' the bench.reuse object, with x ignored. Returns the row or null.
  function rowFor(bench, spec) {
    var src = spec.source || 'levels';
    if (src === 'levels') return levelAt(bench, spec.x);
    if (src === 'reuse') return bench && bench.reuse && typeof bench.reuse === 'object' ? bench.reuse : null;
    if (src === 'kvFull') {
      var rows = bench && Array.isArray(bench.kvFull) ? bench.kvFull : [];
      for (var i = 0; i < rows.length; i++) if (rows[i] && rows[i].max_tokens === spec.x) return rows[i];
    }
    return null;
  }

  // Turns a pair-file annotation spec into {x, y, text}, with numbers read
  // from bench data. Returns null when a needed point is missing.
  //   spec: {source:'levels'|'reuse'|'kvFull', x, metric, kind:'ratio'|'value', engine?, text}
  //   ratio: b divided by a (the pair's order), one decimal. y is midway between the two medians.
  //   value: the named engine's median (default engine a).
  RTU.annotate = function (spec, ctx) {
    if (!spec || !ctx || !ctx.a || !ctx.b) return null;
    var bench = ctx.bench || {};
    var metric = spec.metric;
    var src = spec.source || 'levels';
    function at(engine) {
      var row = rowFor(bench[engine.id], spec);
      return row ? med(row[metric]) : null;
    }
    var out = { x: src === 'reuse' ? null : spec.x, source: src, metric: metric };
    var text = String(spec.text === undefined || spec.text === null ? '' : spec.text);
    if (spec.kind === 'ratio') {
      var av = at(ctx.a), bv = at(ctx.b);
      if (av === null || bv === null || av === 0) return null;
      out.y = (av + bv) / 2;
      out.text = text.replace(/\{v\}/g, String(round1(bv / av)));
      return out;
    }
    if (spec.kind === 'value') {
      var v = at(engineFor(spec, ctx));
      if (v === null) return null;
      out.y = v;
      out.text = text.replace(/\{v\}/g, RTU.fmtNum(v));
      return out;
    }
    return null;
  };
})();
