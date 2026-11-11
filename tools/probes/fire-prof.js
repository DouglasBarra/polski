(async () => {
  const D = Iskry.scene.debug(); const r = D.renderer, fire = D.modules.fire;
  const gl = r.getContext(); const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const DPR = window.__DPR || 2;
  D.TUNE.slowFps = 0;                                   // keep the adaptive resolution out of it
  r.setPixelRatio(DPR); r.setSize(1920, 1008, false); D.camera.aspect = 1920 / 1008; D.camera.updateProjectionMatrix();
  const kids = fire.group.children.slice();
  const by = (n) => kids.find((c) => c.name === n);
  const states = {
    on: () => {},
    meshesOff: () => { for (const c of kids) if (!c.isLight) c.visible = false; },
    glowOff: () => { by('fire-glow').visible = false; },
    flameOff: () => { by('fire-flame').visible = false; },
    groupOff: () => { fire.group.visible = false; },
  };
  const reset = () => { fire.group.visible = true; for (const c of kids) c.visible = true; };
  const samples = {}; for (const s in states) samples[s] = [];
  let cur = 'on', pend = [];
  const orig = r.render.bind(r);
  r.render = (sc, cam) => {
    const q = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, q); orig(sc, cam); gl.endQuery(tq.TIME_ELAPSED_EXT);
    pend.push([q, cur]);
    pend = pend.filter(([qq, s]) => {
      if (!gl.getQueryParameter(qq, gl.QUERY_RESULT_AVAILABLE)) return true;
      if (!gl.getParameter(tq.GPU_DISJOINT_EXT) && s) samples[s].push(gl.getQueryParameter(qq, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(qq); return false;
    });
  };
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
  for (let cyc = 0; cyc < (window.__CYC || 3); cyc++) for (const s in states) {
    reset(); states[s](); cur = null; await wait(250); cur = s; await wait(window.__BLOCK || 900);
  }
  cur = null; reset(); await wait(300); r.render = orig;
  const med = (a) => { a = a.slice().sort((x, y) => x - y); return a.length ? a[Math.floor(a.length * 0.25)] : NaN; };   // lower quartile: least disturbed by other tabs
  const m = {}; for (const s in samples) m[s] = med(samples[s]);
  const f = (x) => +x.toFixed(2);
  return JSON.stringify({ dpr: DPR, n: samples.on.length, frame: f(m.on), fireTotal: f(m.on - m.groupOff), meshes: f(m.on - m.meshesOff), lightsOnScene: f(m.meshesOff - m.groupOff), glow: f(m.on - m.glowOff), flame: f(m.on - m.flameOff) });
})()
