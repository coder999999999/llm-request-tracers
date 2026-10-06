// Small pure helpers shared by the renderers. No DOM access.
(function () {
  var RTU = window.RTU = window.RTU || {};

  RTU.esc = function (s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  RTU.shortPath = function (file) {
    var s = String(file || '');
    return s.slice(s.lastIndexOf('/') + 1);
  };

  RTU.srcURL = function (engine, file, line) {
    return engine.repo + '/blob/' + engine.commit + '/' + file + '#L' + line;
  };

  // Chooses the engine pair from a query string such as "?a=llama-cpp&b=vllm".
  // The URL picks which two engines; when a pair file exists for them, the pair
  // file fixes the order (its verdict.a and annotation ratios follow ids[0]),
  // so "?a=vllm&b=llama-cpp" shows the same page as the default order.
  RTU.pickPair = function (search, RT) {
    var params = new URLSearchParams(search || '');
    var a = params.get('a');
    var b = params.get('b');
    if (a && b && a !== b && RT.engines[a] && RT.engines[b]) {
      var own = RT.pairs[a + '--' + b] || RT.pairs[b + '--' + a];
      return own ? [own.ids[0], own.ids[1]] : [a, b];
    }
    var pairs = Object.keys(RT.pairs).map(function (k) { return RT.pairs[k]; });
    for (var i = 0; i < pairs.length; i++) {
      if (RT.engines[pairs[i].ids[0]] && RT.engines[pairs[i].ids[1]]) return [pairs[i].ids[0], pairs[i].ids[1]];
    }
    return Object.keys(RT.engines).slice(0, 2);
  };

  // ---- text colour ------------------------------------------------------

  var PAGE_BG = '#f7f6f2', INK = '#121212';

  function parseHex(hex) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex));
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [0, 2, 4].map(function (i) { return parseInt(h.slice(i, i + 2), 16); });
  }

  function luminance(rgb) {
    var c = rgb.map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  // WCAG contrast ratio between two hex colours.
  RTU.contrast = function (a, b) {
    var la = luminance(parseHex(a) || [0, 0, 0]), lb = luminance(parseHex(b) || [0, 0, 0]);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  // An engine colour for small text: darkened until it reads at 4.5 to 1 on the
  // page background. Lines, dots and bars keep the original colour.
  RTU.textColor = function (hex) {
    var rgb = parseHex(hex);
    if (!rgb) return INK;
    function toHex(v) { return '#' + v.map(function (n) { return ('0' + n.toString(16)).slice(-2); }).join(''); }
    var out = toHex(rgb);
    if (String(hex).length === 7 && RTU.contrast(out, PAGE_BG) >= 4.5) return String(hex);
    for (var i = 0; i < 60 && RTU.contrast(out, PAGE_BG) < 4.5; i++) {
      rgb = rgb.map(function (n) { return Math.max(0, Math.floor(n * 0.96)); });
      out = toHex(rgb);
    }
    return out;
  };

  RTU.fmtMs = function (n) {
    if (typeof n !== 'number' || !isFinite(n)) return 'n/a';
    if (n >= 1000) return (n / 1000).toFixed(1) + ' s';
    return Math.round(n) + ' ms';
  };
})();
