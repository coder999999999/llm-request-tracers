// Global registry. Data files register onto window.RT; nothing here touches the DOM.
// Registering invalid data records a message in RT.errors and never throws.
(function () {
  var RT = window.RT = window.RT || {};
  RT.compare = RT.compare || { stages: [], questions: [], features: [] };
  RT.engines = RT.engines || {};
  RT.pairs = RT.pairs || {};
  RT.bench = RT.bench || {};
  RT.errors = RT.errors || [];
  // Steps added before their engine is registered (generated *.steps.js files
  // load ahead of the hand-written engine file).
  var pendingSteps = {};

  var REQUIRED_ENGINE = ['id', 'name', 'color', 'repo', 'commit', 'tracer', 'shape'];
  var REQUIRED_STEP = ['title', 'fn', 'file', 'line', 'check'];

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function has(v) { return v !== undefined && v !== null && v !== ''; }
  function stageIds() { return RT.compare.stages.map(function (s) { return s.id; }); }
  function featureKeys() { return RT.compare.features.map(function (f) { return f.key; }); }

  function validateSteps(label, steps) {
    var out = [];
    if (steps === undefined) return out;
    if (!isObj(steps)) { out.push(label + ': steps must be an object keyed by stage id'); return out; }
    var stages = stageIds();
    Object.keys(steps).forEach(function (stage) {
      if (stages.indexOf(stage) < 0) { out.push(label + ': unknown stage "' + stage + '"'); return; }
      var list = steps[stage];
      if (!Array.isArray(list)) { out.push(label + ': steps.' + stage + ' must be an array'); return; }
      list.forEach(function (st, i) {
        var where = label + ': steps.' + stage + '[' + i + ']';
        if (!isObj(st)) { out.push(where + ': not an object'); return; }
        REQUIRED_STEP.forEach(function (k) {
          if (!has(st[k])) out.push(where + ': missing ' + k);
        });
      });
    });
    return out;
  }

  function validateEngine(e) {
    if (!isObj(e)) return ['engine: not an object'];
    var label = 'engine "' + (has(e.id) ? e.id : '?') + '"';
    var out = [];
    REQUIRED_ENGINE.forEach(function (k) {
      if (!has(e[k])) out.push(label + ': missing ' + k);
    });
    if (e.features !== undefined) {
      if (!isObj(e.features)) out.push(label + ': features must be an object');
      else {
        var keys = featureKeys();
        Object.keys(e.features).forEach(function (k) {
          if (keys.indexOf(k) < 0) out.push(label + ': unknown feature "' + k + '"');
        });
      }
    }
    return out.concat(validateSteps(label, e.steps));
  }

  function push(list) { list.forEach(function (m) { RT.errors.push(m); }); }

  // Per stage, arrays are concatenated: earlier registrations first.
  function mergeSteps(a, b) {
    var out = {};
    [a, b].forEach(function (src) {
      if (!isObj(src)) return;
      Object.keys(src).forEach(function (stage) {
        if (!Array.isArray(src[stage])) return;
        out[stage] = (out[stage] || []).concat(src[stage]);
      });
    });
    return out;
  }

  RT.validateEngine = validateEngine;

  RT.registerEngine = function (e) {
    var problems = validateEngine(e);
    if (problems.length) push(problems);
    if (!isObj(e) || !has(e.id)) return;
    var copy = {};
    Object.keys(e).forEach(function (k) { copy[k] = e[k]; });
    copy.steps = mergeSteps(pendingSteps[e.id], e.steps);
    copy.features = isObj(e.features) ? e.features : {};
    delete pendingSteps[e.id];
    RT.engines[e.id] = copy;
  };

  RT.addSteps = function (id, steps) {
    var problems = validateSteps('engine "' + id + '"', steps);
    if (steps === null) problems.push('engine "' + id + '": steps must be an object keyed by stage id');
    if (problems.length) push(problems);
    if (!isObj(steps)) return;
    var valid = {};
    var stages = stageIds();
    Object.keys(steps).forEach(function (s) {
      if (stages.indexOf(s) >= 0 && Array.isArray(steps[s])) valid[s] = steps[s];
    });
    if (RT.engines[id]) RT.engines[id].steps = mergeSteps(RT.engines[id].steps, valid);
    else pendingSteps[id] = mergeSteps(pendingSteps[id], valid);
  };

  RT.registerPair = function (p) {
    if (!isObj(p) || !Array.isArray(p.ids) || p.ids.length !== 2 ||
        !has(p.ids[0]) || !has(p.ids[1]) || p.ids[0] === p.ids[1]) {
      RT.errors.push('pair: ids must be two different engine ids');
      return;
    }
    RT.pairs[p.ids.join('--')] = p;
  };

  RT.registerBench = function (b) {
    if (!isObj(b) || !has(b.id)) { RT.errors.push('bench: missing id'); return; }
    RT.bench[b.id] = b;
  };
})();
