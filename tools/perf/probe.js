// Iskry · tools/perf/probe.js — injected by run.mjs before any page script runs (never shipped).
// Records every animation frame from navigation start, long tasks, console errors and the
// WebGL calls that cause hitches (shader compiles, program links, texture and buffer uploads).
(() => {
  if (window.__probe) return;
  const P = (window.__probe = {
    frames: new Float64Array(400000), n: 0,       // rAF timestamps, ms since navigation start
    longtasks: [], errors: [], gl: [],            // gl: [t, kind, bytes]
    vis: [[0, document.visibilityState]],         // [t, state]: a hidden tab is throttled, so the run is void
    firstFrameAt: 0, canvasAt: 0
  });
  const tick = (t) => { if (P.n < P.frames.length) P.frames[P.n++] = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) P.longtasks.push([Math.round(e.startTime * 10) / 10, Math.round(e.duration * 10) / 10]);
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) { /* no longtask support */ }
  document.addEventListener('visibilitychange', () => P.vis.push([performance.now(), document.visibilityState]));
  addEventListener('error', (e) => P.errors.push(String(e.message)));
  addEventListener('unhandledrejection', (e) => P.errors.push('unhandled: ' + String(e.reason)));
  for (const k of ['error', 'warn']) {
    const orig = console[k];
    console[k] = function (...a) { P.errors.push(k + ': ' + a.map(String).join(' ').slice(0, 300)); return orig.apply(this, a); };
  }
  const note = (kind, bytes) => { if (P.gl.length < 50000) P.gl.push([performance.now(), kind, bytes || 0]); };
  const sizeOf = (a) => (a && a.byteLength) || 0;
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const gl = getContext.call(this, type, ...rest);
    if (gl && /webgl/.test(type) && !gl.__probed) {
      gl.__probed = true;
      if (!P.canvasAt) P.canvasAt = performance.now();
      const wrap = (name, bytes) => {
        const f = gl[name];
        if (typeof f !== 'function') return;
        gl[name] = function (...a) { note(name, bytes ? bytes(a) : 0); return f.apply(gl, a); };
      };
      wrap('compileShader'); wrap('linkProgram');
      wrap('texImage2D', (a) => (a.length >= 9 ? (sizeOf(a[8]) || a[3] * a[4] * 4) : 0));
      wrap('texSubImage2D', (a) => (a.length >= 9 ? (sizeOf(a[8]) || a[4] * a[5] * 4) : 0));
      wrap('texImage3D', (a) => sizeOf(a[9]) || a[3] * a[4] * a[5] * 4);
      wrap('texStorage2D', (a) => a[3] * a[4] * 4);
      wrap('bufferData', (a) => (typeof a[1] === 'number' ? a[1] : sizeOf(a[1])));
      wrap('bufferSubData', (a) => sizeOf(a[2]));
      wrap('generateMipmap');
      wrap('readPixels');
    }
    return gl;
  };
})();
