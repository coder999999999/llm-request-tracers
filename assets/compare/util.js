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
  RTU.pickPair = function (search, RT) {
    var params = new URLSearchParams(search || '');
    var a = params.get('a');
    var b = params.get('b');
    if (a && b && a !== b && RT.engines[a] && RT.engines[b]) return [a, b];
    var pairs = Object.keys(RT.pairs).map(function (k) { return RT.pairs[k]; });
    if (pairs.length) return [pairs[0].ids[0], pairs[0].ids[1]];
    return Object.keys(RT.engines).slice(0, 2);
  };

  RTU.fmtMs = function (n) {
    if (typeof n !== 'number' || !isFinite(n)) return 'n/a';
    if (n >= 1000) return (n / 1000).toFixed(1) + ' s';
    return Math.round(n) + ' ms';
  };
})();
