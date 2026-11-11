(async () => {
  const D = (window.Iskry && Iskry.scene && Iskry.scene.debug) ? Iskry.scene.debug() : null;
  const renderer = D ? D.renderer : bench.renderer, scene = D ? D.scene : bench.scene, camera = D ? D.camera : bench.camera;
  const g = D ? D.modules.grass.group : bench.grass.group;
  const gl = renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const REPS = window.__reps || 30, ROUNDS = window.__rounds || 7;
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const timeOnce = async (vis) => {
    g.visible = vis;
    renderer.render(scene, camera);
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    for (let i = 0; i < REPS; i++) renderer.render(scene, camera);
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    g.visible = true;
    for (let k = 0; k < 600; k++) { await frame(); if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break; }
    const disj = gl.getParameter(ext.GPU_DISJOINT_EXT);
    const ns = gl.getQueryParameter(q, gl.QUERY_RESULT); gl.deleteQuery(q);
    return disj ? NaN : ns / 1e6 / REPS;
  };
  let on = [], off = [];
  for (let r = 0; r < ROUNDS; r++) { off.push(await timeOnce(false)); on.push(await timeOnce(true)); }
  const min = (a) => Math.min(...a.filter(Number.isFinite));
  const med = (a) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b[b.length >> 1]; };
  const diffs = on.map((v, i) => v - off[i]).filter(Number.isFinite);
  return JSON.stringify({ dpr: renderer.getPixelRatio(), size: [renderer.domElement.width, renderer.domElement.height],
    onMin: +min(on).toFixed(3), offMin: +min(off).toFixed(3), grassMinDiff: +(min(on) - min(off)).toFixed(3), grassMedPair: +med(diffs).toFixed(3) });
})()
