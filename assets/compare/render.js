// Section renderers for the comparison page. Pure functions: data in, HTML or
// SVG string out. Nothing here touches the DOM; page.js inserts the strings.
//
// ctx = {a, b, pair, compare, bench}
//   a, b     engine objects from RT.engines
//   pair     pair file or null
//   compare  RT.compare (stages, questions, features)
//   bench    RT.bench, keyed by engine id (may be empty)
//
// Needs RTU (util.js, stage-times.js) and RTC (chart.js) loaded first.
// Class names follow mockups/v4-polished.html. The page stylesheet styles them.
(function () {
  var RTU = window.RTU, RTC = window.RTC;
  var RTR = window.RTR = window.RTR || {};

  var EMPTY = 'Benchmark running, results soon';
  var NOT_COVERED = 'Not covered yet';
  var NO_PAIR = 'No write-up for this pair yet';
  var INK = '#121212', INK2 = '#4b4b48', INK3 = '#4b4b48', RULE = '#e2dfd6', BG = '#f7f6f2';
  var FONT = 'Archivo, system-ui, sans-serif';

  function esc(s) { return RTU.esc(s); }
  // Prose from data files (titles, values, sentences). The design rules ban
  // arrows and middle dots in running text, so they are spelled out here.
  // Code (fn strings) goes through esc() instead and is left verbatim.
  function txt(s) {
    return esc(String(s === undefined || s === null ? '' : s)
      .replace(/\s*→\s*/g, ' to ').replace(/\s+·\s+/g, ', ').replace(/↓/g, ''));
  }
  function isNum(n) { return typeof n === 'number' && isFinite(n); }
  function col(c) { return /^#[0-9a-f]{3,8}$/i.test(String(c)) ? String(c) : INK; }
  function r1(n) { return Math.round(n * 10) / 10; }
  function pair(ctx) { return [ctx.a, ctx.b]; }
  function stagesOf(ctx) { return (ctx.compare && ctx.compare.stages) || []; }
  function stageById(ctx, id) {
    var st = stagesOf(ctx);
    for (var i = 0; i < st.length; i++) if (st[i].id === id) return st[i];
    return null;
  }
  function stepsOf(engine, stageId) {
    var l = engine && engine.steps && engine.steps[stageId];
    return Array.isArray(l) ? l : [];
  }
  function med(m) { return m && typeof m === 'object' ? (isNum(m.median) ? m.median : null) : (isNum(m) ? m : null); }
  function benchOf(ctx, engine) { return ctx.bench && ctx.bench[engine.id] || null; }
  function empty() { return '<p class="empty">' + EMPTY + '</p>'; }
  function none() { return '<span class="none">' + NOT_COVERED + '</span>'; }
  function heading(engine, extra) {
    return '<h4 style="color:' + col(engine.color) + '">' + esc(engine.name) +
      (extra ? ' <em>' + esc(extra) + '</em>' : '') + '</h4>';
  }
  function srcLink(engine, file, line) {
    return '<a class="src" href="' + esc(RTU.srcURL(engine, file, line)) + '" title="' + esc(file + ':' + line) + '">' +
      esc(RTU.shortPath(file) + ':' + line) + '</a>';
  }
  function figure(title, sub, inner) {
    return '<figure><div class="fig-h"><h3>' + esc(title) + '</h3>' + (sub ? '<p>' + esc(sub) + '</p>' : '') + '</div>' + inner + '</figure>';
  }

  // ---- code paths -------------------------------------------------------

  function stepHtml(engine, s) {
    return '<div class="step"><b>' + txt(s.title) + '</b>' + srcLink(engine, s.file, s.line) +
      '<code>' + esc(s.fn) + '</code></div>';
  }

  // Lists steps in order. With onlyKey set, hidden steps are skipped, but a hop
  // that sits on a hidden step still shows, ahead of the next step that is shown.
  function stepsHtml(engine, list, onlyKey) {
    var out = '', pending = [];
    function flush() {
      pending.forEach(function (t) { out += '<div class="cross">' + txt(t) + '</div>'; });
      pending = [];
    }
    list.forEach(function (s) {
      if (s.hop && s.hopText) pending.push(s.hopText);
      if (!onlyKey || s.key) { flush(); out += stepHtml(engine, s); }
    });
    flush();
    return out;
  }

  RTR.codeList = function (engine, stageId, opts) {
    var list = stepsOf(engine, stageId);
    var head = heading(engine, engine.lang);
    if (!list.length) return '<div class="path">' + head + '<p class="none">' + NOT_COVERED + '</p></div>';
    var keys = list.filter(function (s) { return s.key; });
    var showAll = (opts && opts.all) || !keys.length || keys.length === list.length;
    var html = '<div class="path">' + head + stepsHtml(engine, list, showAll ? false : true);
    if (!showAll) {
      html += '<details><summary>Show all ' + list.length + ' steps</summary>' + stepsHtml(engine, list, false) + '</details>';
    }
    return html + '</div>';
  };

  function paths(stageId, ctx) {
    return '<div class="paths">' + pair(ctx).map(function (e) { return RTR.codeList(e, stageId); }).join('') + '</div>';
  }

  // ---- feature rows -----------------------------------------------------

  RTR.featureRows = function (stageId, ctx) {
    var feats = ((ctx.compare && ctx.compare.features) || []).filter(function (f) {
      return stageId === null || stageId === undefined ? (f.stage === null || f.stage === undefined) : f.stage === stageId;
    });
    if (!feats.length) return '';
    var html = '<div class="facts"><div class="r h"><span></span><span>' + esc(ctx.a.name) + '</span><span>' + esc(ctx.b.name) + '</span></div>';
    feats.forEach(function (f) {
      html += '<div class="r"><b>' + esc(f.label) + '</b>';
      pair(ctx).forEach(function (e) {
        var v = e.features && e.features[f.key];
        html += (v && v.value) ? '<span>' + txt(v.value) + ' ' + srcLink(e, v.file, v.line) + '</span>' : '<span>' + none() + '</span>';
      });
      html += '</div>';
    });
    return html + '</div>';
  };

  // ---- stage-time bars --------------------------------------------------

  var STAGE_BAR = { wait: 'Time spent waiting for a turn', think: 'Time spent reading the prompt before the first token' };
  var NOTE = { reported: 'reported by the server', derived: 'derived', 'queue + overhead': 'queue + overhead' };

  // The difference between the two engines for one stage, from bench numbers only.
  // Within 10% of the larger value counts as even.
  function gapText(ctx, msA, msB) {
    var diff = Math.abs(msA - msB);
    if (diff <= 0.1 * Math.max(msA, msB)) return 'About even';
    return (msA < msB ? ctx.a : ctx.b).name + ' ' + RTU.fmtMs(diff) + ' faster';
  }

  RTR.stageBar = function (stageId, ctx) {
    if (!STAGE_BAR[stageId]) return '';
    var blocks = '';
    [1, 32].forEach(function (users) {
      var ta = RTU.stageTimes(benchOf(ctx, ctx.a), users), tb = RTU.stageTimes(benchOf(ctx, ctx.b), users);
      if (!ta || !tb || !ta[stageId] || !tb[stageId]) return;
      var max = Math.max(ta[stageId].ms, tb[stageId].ms, 1);
      var notes = [[ctx.a, ta], [ctx.b, tb]].map(function (p) {
        return p[0].name + ': ' + (NOTE[p[1][stageId].note] || p[1][stageId].note);
      }).join('; ');
      blocks += '<div class="stagebar"><div class="hd"><span>' + esc(STAGE_BAR[stageId] + ', at ' + users + (users === 1 ? ' user' : ' users')) +
        '</span><span>' + esc(notes) + '</span></div>';
      [[ctx.a, ta], [ctx.b, tb]].forEach(function (p) {
        var ms = p[1][stageId].ms;
        blocks += '<span class="lbl" style="color:' + col(p[0].color) + '">' + esc(p[0].name) + '</span>' +
          '<span class="track"><i style="width:' + r1(Math.min(100, Math.max(1, ms / max * 100))) + '%;background:' + col(p[0].color) + '"></i></span>' +
          '<span class="v">' + esc(RTU.fmtMs(ms)) + '</span>';
      });
      blocks += '<span class="gap">' + esc(gapText(ctx, ta[stageId].ms, tb[stageId].ms)) + '</span></div>';
    });
    return blocks || empty();
  };

  // ---- evidence ---------------------------------------------------------

  function runSub(ctx) {
    var b = benchOf(ctx, ctx.a) || benchOf(ctx, ctx.b);
    var run = b && b.run;
    if (!run) return '';
    return [run.model, run.gpu].filter(Boolean).join(', ');
  }

  function summary(label, unit, series) {
    var parts = series.filter(function (s) { return s.points.length; }).map(function (s) {
      var p = s.points[s.points.length - 1];
      return s.label + ' reaches ' + RTU.fmtNum(p[1]) + ' at ' + RTU.fmtNum(p[0]) + ' ' + unit;
    });
    return label + '. ' + parts.join('. ') + '.';
  }

  function levelSeries(ctx, metric) {
    return pair(ctx).map(function (e) {
      var b = benchOf(ctx, e);
      var pts = [];
      ((b && b.levels) || []).forEach(function (lv) {
        var m = lv && lv[metric];
        var v = med(m);
        if (v === null || !isNum(lv.users)) return;
        pts.push([lv.users, v, m && isNum(m.min) ? m.min : undefined, m && isNum(m.max) ? m.max : undefined]);
      });
      return { label: e.name, color: e.color, points: pts };
    });
  }

  function throughput(q, ctx) {
    var series = levelSeries(ctx, 'tok_s');
    if (!series[0].points.length || !series[1].points.length) return figure('Output tokens per second', '', empty());
    var xs = [];
    series.forEach(function (s) { s.points.forEach(function (p) { if (xs.indexOf(p[0]) < 0) xs.push(p[0]); }); });
    xs.sort(function (a, b) { return a - b; });
    var specs = (ctx.pair && ctx.pair.annotations && ctx.pair.annotations[q.id]) || [];
    var anns = specs.map(function (sp) { return RTU.annotate(sp, ctx); }).filter(Boolean);
    var chart = RTC.lineChart({
      series: series, xTicks: xs, xLabel: 'concurrent users', yLabel: 'tokens per second',
      annotations: anns, ariaLabel: summary('Output tokens per second by concurrent users', 'users', series)
    });
    return figure('Output tokens per second', runSub(ctx), chart);
  }

  function reuse(q, ctx) {
    var vals = pair(ctx).map(function (e) {
      var b = benchOf(ctx, e);
      var r = b && b.reuse;
      return { e: e, cold: r ? med(r.cold_ttft_ms) : null, warm: r ? med(r.warm_ttft_ms) : null };
    });
    if (vals.some(function (v) { return v.cold === null || v.warm === null; })) {
      return figure('Time to first token', '', empty());
    }
    function group(label, key) {
      return { label: label, values: vals.map(function (v) { return { label: v.e.name, color: v.e.color, v: v[key] }; }) };
    }
    var chart = RTC.barPairs({
      groups: [group('First message', 'cold'), group('Repeat with the same system prompt', 'warm')],
      unit: 'ms', ariaLabel: 'Time to first token for a first message and for a repeat with the same system prompt'
    });
    return figure('Time to first token', runSub(ctx), chart);
  }

  function kvFull(q, ctx) {
    var data = pair(ctx).map(function (e) {
      var b = benchOf(ctx, e);
      return (b && Array.isArray(b.kvFull)) ? b.kvFull.filter(function (r) { return r && isNum(r.max_tokens); }) : [];
    });
    if (!data[0].length || !data[1].length) return figure('Throughput as the KV cache fills', '', empty());
    var series = pair(ctx).map(function (e, i) {
      return {
        label: e.name, color: e.color,
        points: data[i].filter(function (r) { return isNum(r.tok_s); }).map(function (r) { return [r.max_tokens, r.tok_s]; })
      };
    });
    var xs = [];
    data.forEach(function (d) { d.forEach(function (r) { if (xs.indexOf(r.max_tokens) < 0) xs.push(r.max_tokens); }); });
    xs.sort(function (a, b) { return a - b; });
    var chart = RTC.lineChart({
      series: series, xTicks: xs, xLabel: 'max tokens per reply', yLabel: 'tokens per second', xUnit: 'max tokens',
      ariaLabel: summary('Output tokens per second as replies get longer', 'max tokens', series)
    });
    function cell(rows, n) {
      var r = rows.filter(function (x) { return x.max_tokens === n; })[0];
      if (!r) return none();
      var parts = [];
      if (isNum(r.failed)) parts.push('Failed requests ' + RTU.fmtNum(r.failed));
      if (isNum(r.preemptions)) parts.push('Preemptions ' + RTU.fmtNum(r.preemptions));
      if (isNum(r.kv_retries)) parts.push('Decode retries ' + RTU.fmtNum(r.kv_retries));
      return parts.length ? esc(parts.join(', ')) : none();
    }
    var table = '<div class="facts"><div class="r h"><span></span><span>' + esc(ctx.a.name) + '</span><span>' + esc(ctx.b.name) + '</span></div>';
    xs.forEach(function (n) {
      table += '<div class="r"><b>' + esc('Replies up to ' + RTU.fmtNum(n) + ' tokens') + '</b><span>' + cell(data[0], n) + '</span><span>' + cell(data[1], n) + '</span></div>';
    });
    table += '</div>';
    return figure('Throughput as the KV cache fills', runSub(ctx), chart + table);
  }

  // Two lanes, one per engine. Stage columns are shared; each engine's steps are
  // spread across its columns and each hop is placed at the step where it happens.
  function boundaries(q, ctx) {
    var W = 760, stages = stagesOf(ctx), n = Math.max(stages.length, 1), cw = W / n;
    var laneTop = [52, 172];
    var s = '<svg viewBox="0 0 ' + W + ' 268" width="100%" role="group" aria-label="Where each engine hands the request to another thread or process" ' +
      'font-family="' + FONT + '" font-size="14" fill="' + INK2 + '" style="display:block;max-width:100%;height:auto">';
    stages.forEach(function (st, i) {
      s += '<text x="' + r1(i * cw + 8) + '" y="16" fill="' + INK + '" font-weight="600">' + esc(st.name) + '</text>';
      if (i) s += '<line x1="' + r1(i * cw) + '" x2="' + r1(i * cw) + '" y1="28" y2="268" stroke="' + RULE + '" stroke-width="1"/>';
    });
    pair(ctx).forEach(function (e, li) {
      var c = col(e.color), labelY = laneTop[li], lineY = labelY + 24;
      s += '<text x="0" y="' + labelY + '" fill="' + c + '" font-weight="600" font-size="15" paint-order="stroke" stroke="' + BG + '" stroke-width="4">' + esc(e.name) + '</text>';
      var total = 0;
      stages.forEach(function (st) { total += stepsOf(e, st.id).length; });
      if (!total) { s += '<text x="0" y="' + (lineY + 4) + '">' + NOT_COVERED + '</text>'; return; }
      s += '<line x1="0" x2="' + W + '" y1="' + lineY + '" y2="' + lineY + '" stroke="' + c + '" stroke-width="3"/>';
      var hops = [];
      stages.forEach(function (st, i) {
        var list = stepsOf(e, st.id);
        list.forEach(function (stp, j) {
          var x = r1(i * cw + 8 + (j + 0.5) / list.length * (cw - 16));
          s += '<circle cx="' + x + '" cy="' + lineY + '" r="3" fill="' + BG + '" stroke="' + c + '" stroke-width="2"/>';
          if (stp.hop && stp.hopText) hops.push({ x: x, text: stp.hopText });
        });
      });
      var rows = [[], []];
      hops.forEach(function (hp) {
        var tw = hp.text.length * 7.2;
        var atEnd = hp.x + 8 + tw > W - 4;
        var x0 = atEnd ? hp.x - 8 - tw : hp.x + 8, x1 = x0 + tw;
        var row = 0;
        while (row < 1 && rows[row].some(function (iv) { return x0 < iv[1] + 12 && x1 > iv[0] - 12; })) row++;
        rows[row].push([x0, x1]);
        s += '<line x1="' + hp.x + '" x2="' + hp.x + '" y1="' + (lineY - 14) + '" y2="' + (lineY + 14 + row * 22) + '" stroke="' + INK + '" stroke-width="1.5" stroke-dasharray="3 3"/>';
        s += '<text x="' + r1(atEnd ? hp.x - 8 : hp.x + 8) + '" y="' + (lineY + 30 + row * 22) + '" text-anchor="' + (atEnd ? 'end' : 'start') + '">' + txt(hp.text) + '</text>';
      });
    });
    s += '</svg>';
    var cap = '<figcaption>' + pair(ctx).map(function (e) {
      return '<b style="color:' + col(e.color) + '">' + esc(e.name) + '</b>: ' + esc(e.shape);
    }).join(' ') + '</figcaption>';
    return '<figure><div class="fig-h"><h3>Where the request changes thread or process</h3></div>' + s + cap + '</figure>';
  }

  RTR.evidence = function (q, ctx) {
    if (!q) return '';
    if (q.chart === 'throughput') return throughput(q, ctx);
    if (q.chart === 'reuse') return reuse(q, ctx);
    if (q.chart === 'kvFull') return kvFull(q, ctx);
    if (q.chart === 'boundaries') return boundaries(q, ctx);
    return '';
  };

  // ---- chapters and stage rows -----------------------------------------

  RTR.chapter = function (q, index, ctx) {
    var total = ((ctx.compare && ctx.compare.questions) || []).length;
    var qs = (ctx.compare && ctx.compare.questions) || [];
    var stageIds = q.stages || [];
    var html = '<article class="chapter" id="' + esc(q.id) + '"><div>';
    html += '<span class="num">' + (index + 1) + ' of ' + total + '</span>';
    html += '<h2>' + txt(q.text) + '</h2>';
    if (!ctx.pair) html += '<p class="ans">' + NO_PAIR + '</p>';
    else {
      var ans = ctx.pair.answers && ctx.pair.answers[q.id];
      if (ans) html += '<p class="ans">' + txt(ans) + '</p>';
    }
    html += RTR.evidence(q, ctx);
    var barStage = stageIds.filter(function (id) { return STAGE_BAR[id]; })[0];
    if (barStage) html += RTR.stageBar(barStage, ctx);
    stageIds.forEach(function (id) {
      var st = stageById(ctx, id);
      html += '<div class="fig-h stage-h"><h3>' + esc(st ? st.name : id) + '</h3>' + (st && st.subtitle ? '<p>' + esc(st.subtitle) + '</p>' : '') + '</div>';
      html += paths(id, ctx) + RTR.featureRows(id, ctx);
    });
    html += '<div class="links">' +
      pair(ctx).map(function (e) { return '<a href="' + esc(e.tracer) + '">Open the ' + esc(e.name) + ' tracer</a>'; }).join('');
    if (index < qs.length - 1) html += '<a href="#' + esc(qs[index + 1].id) + '">Next question</a>';
    html += '</div></div>';
    html += '<aside class="track">' + RTR.track(ctx, stageIds[0]) + '</aside></article>';
    return html;
  };

  RTR.stageRow = function (stageId, ctx) {
    var st = stageById(ctx, stageId);
    if (!st) return '';
    var sums = (ctx.pair && ctx.pair.stageSummaries && ctx.pair.stageSummaries[stageId]) || {};
    var html = '<section class="stage-row" id="stage-' + esc(stageId) + '">';
    html += '<div class="fig-h"><h3>' + esc(st.name) + '</h3><p>' + esc(st.subtitle) + '</p></div>';
    html += '<div class="sums">';
    pair(ctx).forEach(function (e) {
      var n = stepsOf(e, stageId).length;
      html += '<div class="sum">' + heading(e, n + (n === 1 ? ' step' : ' steps')) + (sums[e.id] ? '<p>' + txt(sums[e.id]) + '</p>' : '') + '</div>';
    });
    html += '</div>' + RTR.stageBar(stageId, ctx);
    html += '<details><summary>Show code path and features</summary>' + paths(stageId, ctx) + RTR.featureRows(stageId, ctx) + '</details>';
    return html + '</section>';
  };

  RTR.everyStage = function (ctx) {
    var html = '<div class="every-stage">' + stagesOf(ctx).map(function (s) { return RTR.stageRow(s.id, ctx); }).join('');
    var general = RTR.featureRows(null, ctx);
    if (general) {
      html += '<section class="stage-row" id="stage-general"><div class="fig-h"><h3>General</h3><p>Not tied to one stage</p></div>' + general + '</section>';
    }
    return html + '</div>';
  };

  // ---- pinned track -----------------------------------------------------

  var TRACK_CSS =
    '.rtr-st{cursor:pointer}' +
    '.rtr-st .rtr-name{font-weight:500;fill:' + INK3 + '}' +
    '.rtr-st .rtr-dot{fill:' + BG + ';r:4}' +
    '.rtr-st[data-active="true"] .rtr-name{font-weight:700;fill:' + INK + '}' +
    '.rtr-st[data-active="true"] .rtr-dot{fill:var(--c);r:7}' +
    '.rtr-st:focus-visible{outline:2px solid ' + INK + ';outline-offset:2px}';

  // One <g data-stage="<id>"> per stage. The page toggles data-active on them.
  // opts.horizontal draws a strip instead of two vertical lanes.
  RTR.track = function (ctx, activeStageId, opts) {
    var stages = stagesOf(ctx), n = stages.length;
    var horizontal = !!(opts && opts.horizontal);
    var engines = pair(ctx);
    var w, h, laneAt, stagePos;
    // Strip geometry: a lane-name gutter, then one column per stage. Kept narrow so
    // the text stays near 12px when the strip is scaled into a 358px phone column.
    var x0 = 80, cw = 88;
    if (horizontal) {
      w = x0 + n * cw; h = 168;
      laneAt = function (i) { return 52 + i * 48; };
      stagePos = function (i) { return x0 + i * cw + cw / 2; };
    } else {
      var row = 112;
      w = 280; h = n * row + 64;
      laneAt = function (i) { return i ? 224 : 56; };
      stagePos = function (i) { return 56 + i * row; };
    }
    var s = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" font-family="' + FONT + '" role="group" aria-label="Request stages for both engines" style="display:block;max-width:100%;height:auto">';
    s += '<style>' + TRACK_CSS + '</style>';
    // lanes
    engines.forEach(function (e, i) {
      var c = col(e.color), p = laneAt(i);
      if (horizontal) {
        s += '<text x="0" y="' + (p + 5) + '" font-weight="600" font-size="14" fill="' + c + '">' + esc(e.name) + '</text>';
        s += '<line x1="' + x0 + '" x2="' + (w - 8) + '" y1="' + p + '" y2="' + p + '" stroke="' + c + '" stroke-width="2"/>';
      } else {
        s += '<text x="' + p + '" y="14" text-anchor="middle" font-weight="600" font-size="14" fill="' + c + '">' + esc(e.name) + '</text>';
        s += '<line x1="' + p + '" x2="' + p + '" y1="32" y2="' + (h - 36) + '" stroke="' + c + '" stroke-width="2"/>';
      }
    });
    stages.forEach(function (st, i) {
      var sp = stagePos(i), on = st.id === activeStageId;
      s += '<g class="rtr-st" data-stage="' + esc(st.id) + '"' + (on ? ' data-active="true"' : '') + ' tabindex="0" role="link" aria-label="' + esc(st.name) + '">';
      if (horizontal) {
        s += '<rect x="' + (x0 + i * cw) + '" y="0" width="' + cw + '" height="' + (h - 24) + '" fill="transparent"/>';
        s += '<text x="' + sp + '" y="14" text-anchor="middle" font-size="14" class="rtr-name">' + esc(st.name) + '</text>';
      } else {
        s += '<rect x="0" y="' + (sp - 40) + '" width="' + w + '" height="96" fill="transparent"/>';
        s += '<text x="' + (w / 2) + '" y="' + (sp + 5) + '" text-anchor="middle" font-size="15" class="rtr-name">' + esc(st.name) + '</text>';
      }
      engines.forEach(function (e, li) {
        var list = stepsOf(e, st.id), lp = laneAt(li);
        var cx = horizontal ? sp : lp, cy = horizontal ? lp : sp;
        s += '<circle class="rtr-dot" cx="' + cx + '" cy="' + cy + '" r="4" stroke="' + col(e.color) + '" stroke-width="2" style="--c:' + col(e.color) + '"/>';
        s += '<text x="' + cx + '" y="' + (cy + 24) + '" text-anchor="middle" font-size="12" fill="' + INK3 + '" paint-order="stroke" stroke="' + BG + '" stroke-width="4">' + list.length + (list.length === 1 ? ' step' : ' steps') + '</text>';
        if (list.some(function (x) { return x.hop; })) {
          s += '<line x1="' + (cx - 14) + '" x2="' + (cx + 14) + '" y1="' + (cy + 36) + '" y2="' + (cy + 36) + '" stroke="' + INK + '" stroke-width="1.5" stroke-dasharray="3 3"/>';
        }
      });
      s += '</g>';
    });
    s += '<text x="' + (horizontal ? 0 : w / 2) + '" y="' + (h - 4) + '" text-anchor="' + (horizontal ? 'start' : 'middle') + '" font-size="12" fill="' + INK3 + '">dashed: crosses a thread or process</text>';
    return s + '</svg>';
  };
})();
