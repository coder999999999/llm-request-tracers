// Small local SVG charts. Return strings, never touch the DOM.
// Needs RTU.esc and RTU.fmtNum (util.js, stage-times.js) loaded first.
//
// Both charts return the svg followed by a visually hidden <table class="sr-only">
// of the same values. The page stylesheet must define .sr-only.
(function () {
  var RTU = window.RTU;
  var RTC = window.RTC = window.RTC || {};

  var INK = '#121212', INK3 = '#86847d', RULE = '#e2dfd6', BG = '#f7f6f2';
  var FONT = 'Archivo, system-ui, sans-serif';
  var EN_DASH = '–';

  function esc(s) { return RTU.esc(s); }
  function fmt(n) { return RTU.fmtNum(n); }
  function isNum(n) { return typeof n === 'number' && isFinite(n); }
  function color(c) { return /^#[0-9a-f]{3,8}$/i.test(String(c)) ? String(c) : INK; }
  function r1(n) { return Math.round(n * 10) / 10; }

  // Smallest of 1, 2, 2.5, 5, 10 (times a power of ten) that is at least n.
  function niceStep(n) {
    if (!(n > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log(n) / Math.LN10));
    var steps = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) if (steps[i] * p >= n * 0.999999) return steps[i] * p;
    return 10 * p;
  }

  function srTable(caption, headers, rows) {
    var s = '<table class="sr-only"><caption>' + esc(caption) + '</caption><thead><tr>';
    headers.forEach(function (h) { s += '<th>' + esc(h) + '</th>'; });
    s += '</tr></thead><tbody>';
    rows.forEach(function (r) {
      s += '<tr>';
      r.forEach(function (c) { s += '<td>' + esc(c) + '</td>'; });
      s += '</tr>';
    });
    return s + '</tbody></table>';
  }

  function pointTitle(label, x, xUnit, y, min, max) {
    var t = label + ', ' + fmt(x) + ' ' + xUnit + ': ' + fmt(y);
    if (isNum(min) && isNum(max) && min !== max) t += ' (range ' + fmt(min) + EN_DASH + fmt(max) + ')';
    return t;
  }

  // spec: {series:[{label,color,points:[[x,y,min?,max?]]}], xTicks, xLabel, yLabel,
  //        annotations:[{x,y,text}], ariaLabel, width, height, xUnit}
  RTC.lineChart = function (spec) {
    spec = spec || {};
    var w = spec.width || 760, h = spec.height || 320;
    var pl = 8, pr = 112, pt = 32, pb = 56;
    var xUnit = spec.xUnit || 'users';
    var series = (spec.series || []).map(function (s) {
      return {
        label: s.label, color: color(s.color),
        points: (s.points || []).filter(function (p) { return p && isNum(p[0]) && isNum(p[1]); })
          .sort(function (a, b) { return a[0] - b[0]; })
      };
    });

    // x positions are evenly spaced over every distinct x, so 1, 2, 4 ... 64 reads as steps.
    var xs = [];
    function addX(x) { if (isNum(x) && xs.indexOf(x) < 0) xs.push(x); }
    (spec.xTicks || []).forEach(addX);
    series.forEach(function (s) { s.points.forEach(function (p) { addX(p[0]); }); });
    (spec.annotations || []).forEach(function (a) { addX(a && a.x); });
    xs.sort(function (a, b) { return a - b; });
    var plotR = w - pr;
    function X(x) {
      if (xs.length < 2) return pl + (plotR - pl) / 2;
      return pl + xs.indexOf(x) * (plotR - pl) / (xs.length - 1);
    }

    var top = 0;
    series.forEach(function (s) {
      s.points.forEach(function (p) {
        top = Math.max(top, p[1], isNum(p[3]) ? p[3] : 0);
      });
    });
    var step = niceStep(top / 3);
    var lines = Math.max(1, Math.min(3, Math.ceil(top / step - 1e-9)));
    var yMax = lines * step;
    function Y(v) { return pt + (1 - v / yMax) * (h - pt - pb); }

    var aria = esc(spec.ariaLabel || spec.yLabel || 'Chart');
    var s = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" role="group" aria-label="' + aria + '" ' +
      'font-family="' + FONT + '" font-size="13" fill="' + INK3 + '" style="display:block;max-width:100%;height:auto">';

    if (spec.yLabel) s += '<text x="' + pl + '" y="12">' + esc(spec.yLabel) + '</text>';
    for (var g = 1; g <= lines; g++) {
      var gv = g * step;
      s += '<line class="grid" x1="' + pl + '" x2="' + plotR + '" y1="' + r1(Y(gv)) + '" y2="' + r1(Y(gv)) + '" stroke="' + RULE + '" stroke-width="1"/>';
      s += '<text x="' + pl + '" y="' + r1(Y(gv) - 6) + '" style="font-variant-numeric:tabular-nums">' + esc(fmt(gv)) + '</text>';
    }
    s += '<line class="axis" x1="' + pl + '" x2="' + plotR + '" y1="' + r1(Y(0)) + '" y2="' + r1(Y(0)) + '" stroke="' + INK + '" stroke-width="1.5"/>';

    var ticks = (spec.xTicks && spec.xTicks.length ? spec.xTicks : xs).filter(isNum);
    ticks.forEach(function (x) {
      s += '<text x="' + r1(X(x)) + '" y="' + (h - pb + 24) + '" text-anchor="' + (X(x) <= pl + 8 ? 'start' : 'middle') + '" style="font-variant-numeric:tabular-nums">' + esc(fmt(x)) + '</text>';
    });
    if (spec.xLabel) s += '<text x="' + plotR + '" y="' + (h - 8) + '" text-anchor="end">' + esc(spec.xLabel) + '</text>';

    // Repeat ranges and lines first, so the points and labels sit on top.
    series.forEach(function (sr) {
      sr.points.forEach(function (p) {
        if (isNum(p[2]) && isNum(p[3]) && p[2] !== p[3]) {
          s += '<line x1="' + r1(X(p[0])) + '" x2="' + r1(X(p[0])) + '" y1="' + r1(Y(p[2])) + '" y2="' + r1(Y(p[3])) + '" stroke="' + sr.color + '" stroke-width="1.5" stroke-opacity="0.4"/>';
        }
      });
      if (sr.points.length > 1) {
        s += '<polyline fill="none" stroke="' + sr.color + '" stroke-width="4" stroke-linejoin="round" stroke-linecap="round" points="' +
          sr.points.map(function (p) { return r1(X(p[0])) + ',' + r1(Y(p[1])); }).join(' ') + '"/>';
      }
    });

    // Annotations: a rule between the series at x, or a callout above a single value.
    (spec.annotations || []).forEach(function (a) {
      if (!a || !isNum(a.x) || !isNum(a.y)) return;
      var px = X(a.x);
      var ys = [];
      var isValue = false;
      series.forEach(function (sr) {
        sr.points.forEach(function (p) {
          if (p[0] === a.x) { ys.push(p[1]); if (p[1] === a.y) isValue = true; }
        });
      });
      var right = px < (pl + plotR) / 2;
      var halo = ' paint-order="stroke" stroke="' + BG + '" stroke-width="4" stroke-linejoin="round"';
      if (!isValue && ys.length > 1) {
        var lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys);
        var rx = px + (right ? 12 : -12);
        s += '<line x1="' + r1(rx) + '" x2="' + r1(rx) + '" y1="' + r1(Y(hi) + 10) + '" y2="' + r1(Y(lo) - 10) + '" stroke="' + INK + '" stroke-width="1"/>';
        s += '<text x="' + r1(rx + (right ? 8 : -8)) + '" y="' + r1(Y(a.y) + 5) + '" text-anchor="' + (right ? 'start' : 'end') + '" fill="' + INK + '" font-weight="600" font-size="15"' + halo + '>' + esc(a.text) + '</text>';
      } else {
        s += '<text x="' + r1(px) + '" y="' + r1(Y(a.y) - 16) + '" text-anchor="' + (right ? 'start' : 'end') + '" fill="' + INK + '" font-weight="600" font-size="15"' + halo + '>' + esc(a.text) + '</text>';
      }
    });

    // Points: focusable, with a tooltip carrying the value and the repeat range.
    series.forEach(function (sr) {
      sr.points.forEach(function (p) {
        var t = pointTitle(sr.label, p[0], xUnit, p[1], p[2], p[3]);
        s += '<circle cx="' + r1(X(p[0])) + '" cy="' + r1(Y(p[1])) + '" r="5" fill="' + sr.color + '" tabindex="0" role="img" aria-label="' + esc(t) + '"><title>' + esc(t) + '</title></circle>';
      });
    });

    // Direct labels at the line ends, nudged apart when they would collide.
    var ends = series.filter(function (sr) { return sr.points.length; }).map(function (sr) {
      var last = sr.points[sr.points.length - 1];
      return { sr: sr, x: X(last[0]), y: Y(last[1]) };
    }).sort(function (a, b) { return a.y - b.y; });
    ends.forEach(function (e) { e.ly = e.y; });
    for (var j = 1; j < ends.length; j++) {
      if (ends[j].ly - ends[j - 1].ly < 18) ends[j].ly = ends[j - 1].ly + 18;
    }
    ends.forEach(function (e) {
      s += '<text x="' + r1(e.x + 12) + '" y="' + r1(e.ly + 5) + '" fill="' + e.sr.color + '" font-weight="600" font-size="15">' + esc(e.sr.label) + '</text>';
    });
    s += '</svg>';

    var rows = [];
    series.forEach(function (sr) {
      sr.points.forEach(function (p) {
        rows.push([sr.label, fmt(p[0]), fmt(p[1]), isNum(p[2]) ? fmt(p[2]) : '', isNum(p[3]) ? fmt(p[3]) : '']);
      });
    });
    return s + srTable(spec.ariaLabel || spec.yLabel || 'Chart data',
      ['Series', spec.xLabel || 'x', spec.yLabel || 'y', 'Lowest repeat', 'Highest repeat'], rows);
  };

  // spec: {groups:[{label, values:[{label,color,v}]}], unit, ariaLabel, width}
  RTC.barPairs = function (spec) {
    spec = spec || {};
    var w = spec.width || 760;
    var unit = spec.unit ? ' ' + spec.unit : '';
    var groups = (spec.groups || []).map(function (g) {
      return {
        label: g.label,
        values: (g.values || []).filter(function (v) { return v && isNum(v.v); })
      };
    });
    var max = 1;
    groups.forEach(function (g) { g.values.forEach(function (v) { max = Math.max(max, v.v); }); });
    var bx = 112, valueRoom = 112, barH = 16, rowH = 28, headH = 24, gap = 32;
    var barMax = Math.max(40, w - bx - valueRoom);
    var y = 0;
    var body = '';
    var rows = [];
    groups.forEach(function (g, gi) {
      if (gi) y += gap;
      body += '<text x="0" y="' + (y + 16) + '" fill="' + INK + '" font-weight="600" font-size="15">' + esc(g.label) + '</text>';
      y += headH;
      var gTop = y;
      g.values.forEach(function (v) {
        var bw = Math.max(2, Math.round(v.v / max * barMax));
        var c = color(v.color);
        body += '<text x="0" y="' + (y + 13) + '" fill="' + c + '" font-weight="600" font-size="15">' + esc(v.label) + '</text>';
        body += '<rect x="' + bx + '" y="' + (y + 2) + '" width="' + bw + '" height="' + barH + '" fill="' + c + '"/>';
        body += '<text x="' + (bx + bw + 8) + '" y="' + (y + 15) + '" fill="' + INK + '" font-size="15" style="font-variant-numeric:tabular-nums">' + esc(fmt(v.v) + unit) + '</text>';
        rows.push([g.label, v.label, fmt(v.v) + unit]);
        y += rowH;
      });
      body += '<line x1="' + bx + '" x2="' + bx + '" y1="' + gTop + '" y2="' + y + '" stroke="' + INK + '" stroke-width="1.5"/>';
    });
    var h = Math.max(y, 8);
    var s = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" role="group" aria-label="' + esc(spec.ariaLabel || 'Bar chart') + '" ' +
      'font-family="' + FONT + '" font-size="13" fill="' + INK3 + '" style="display:block;max-width:100%;height:auto">' + body + '</svg>';
    return s + srTable(spec.ariaLabel || 'Bar chart data', ['Group', 'Series', 'Value'], rows);
  };
})();
