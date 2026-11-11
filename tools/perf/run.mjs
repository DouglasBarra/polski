#!/usr/bin/env node
// Iskry · tools/perf/run.mjs — repeatable whole-scene performance runner (node >= 22, no deps).
// OWNER: perf agent.
//
// Drives Dia/Chrome over the DevTools Protocol (http://127.0.0.1:9222, or $CDP). For each page it
// opens ITS OWN tab, brings it to the front (background tabs are throttled), injects probe.js
// before any page script, and records:
//   load    time to first frame, to the last shader link ("scene complete"), worst hitch, long tasks
//   steady  frame-time distribution over --duration s after --settle s: p50/p90/p95/p99/max,
//           frames over 16.7 / 20 / 33 ms, long tasks, spikes and their period (if periodic),
//           WebGL compiles, links and uploads that happened in the window, JS heap sawtooth
//   --alloc sampled allocation profile (who allocates per frame), --cpu sampled CPU self time
// Before every page it lists the other localhost tabs: other agents share this GPU.
//
//   python3 -m http.server 8791 &            (from the repo root)
//   node tools/perf/run.mjs --label baseline
//   node tools/perf/run.mjs --pages site,bare,profiler --alloc --cpu --shots /private/tmp/iskry-perf
//   node tools/perf/run.mjs --url '/?hour=5.5' --duration 45     (any page; long enough for the 20 s tick)
//
// Options: --base URL (http://localhost:8791)  --pages site,bare,profiler,harness  --url PATH (repeatable)
//          --settle S (5)  --duration S (15)  --label NAME  --repeat N (1)  --alloc  --cpu  --shots DIR
//          --keep (leave the window open)  --tab (a tab in the front window instead of its own window)  --profiler-query 'dpr=2&reps=30'
// Output: tools/perf/results/<label>-<time>.json and a summary on stdout.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { listTabs, openTab, openWindow, activateTab, closeTab, connect, sleep } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes('--' + name);
const opt = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const optAll = (name) => args.flatMap((a, i) => (a === '--' + name && args[i + 1] ? [args[i + 1]] : []));

const BASE = opt('base', 'http://localhost:8791');
const SETTLE = Number(opt('settle', 5)), DURATION = Number(opt('duration', 15));
const LABEL = opt('label', 'run'), REPEAT = Math.max(1, Number(opt('repeat', 1)));
const SHOTS = opt('shots', '');
const PAGES = {
  site: '/',
  bare: '/?bare=1',
  harness: '/tools/perf/harness/',            // the real site with js/quality.js wired in (make-harness.mjs)
  profiler: '/dev/perf.html?auto=1&' + opt('profiler-query', '')
};
const wanted = optAll('url').length && !opt('pages', '') ? [] : opt('pages', 'site,bare').split(',').filter(Boolean);
const jobs = [
  ...wanted.map((name) => { if (!PAGES[name]) throw new Error('unknown page: ' + name); return { name, path: PAGES[name] }; }),
  ...optAll('url').map((path) => ({ name: path, path }))
];

const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

// Frame-time statistics for the rAF timestamps inside [from, to) ms.
function frameStats(stamps, from, to) {
  const dts = [], at = [];
  for (let i = 1; i < stamps.length; i++) {
    if (stamps[i] < from || stamps[i] >= to) continue;
    dts.push(stamps[i] - stamps[i - 1]); at.push(stamps[i]);
  }
  if (!dts.length) return { frames: 0 };
  const sorted = Float64Array.from(dts).sort();
  const sum = dts.reduce((a, b) => a + b, 0);
  const over = (ms) => dts.reduce((n, d) => n + (d > ms ? 1 : 0), 0);
  // Spikes: frames at least 20 ms and twice the median, merged when closer than 250 ms.
  const thresh = Math.max(20, 2 * quantile(sorted, 0.5));
  const spikes = [];
  for (let i = 0; i < dts.length; i++) {
    if (dts[i] <= thresh) continue;
    const last = spikes[spikes.length - 1];
    if (last && at[i] - last.t < 250) { last.ms = Math.max(last.ms, round(dts[i])); last.frames++; }
    else spikes.push({ t: round(at[i] / 1000, 2), tMs: at[i], ms: round(dts[i]), frames: 1 });
  }
  let period = null;
  if (spikes.length >= 3) {
    const gaps = spikes.slice(1).map((s, i) => s.tMs - spikes[i].tMs);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
    period = { meanSec: round(mean / 1000, 2), jitter: round(sd / mean, 2), regular: sd / mean < 0.25 };
  }
  return {
    frames: dts.length, seconds: round((to - from) / 1000), fps: round(1000 * dts.length / sum),
    p50: round(quantile(sorted, 0.5)), p90: round(quantile(sorted, 0.9)), p95: round(quantile(sorted, 0.95)),
    p99: round(quantile(sorted, 0.99)), max: round(sorted[sorted.length - 1]),
    over16_7: over(16.7), over20: over(20), over33: over(33),
    spikes: spikes.slice(0, 60).map(({ t, ms, frames }) => ({ t, ms, frames })), spikeCount: spikes.length, period
  };
}

function glSummary(events, from, to) {
  const out = {};
  for (const [t, kind, bytes] of events) {
    if (t < from || t >= to) continue;
    const o = (out[kind] = out[kind] || { calls: 0, bytes: 0 });
    o.calls++; o.bytes += bytes;
  }
  return out;
}

function summarizeAlloc(profile, seconds) {
  const rows = [];
  const walk = (node, stack) => {
    const f = node.callFrame, here = `${f.functionName || '(anonymous)'} ${f.url.replace(/^https?:\/\/[^/]+/, '')}:${f.lineNumber + 1}`;
    if (node.selfSize > 0) rows.push({ where: here, via: stack.slice(-2).join(' < '), bytes: node.selfSize });
    for (const c of node.children || []) walk(c, stack.concat(here));
  };
  walk(profile.head, []);
  const by = new Map();
  for (const r of rows) { const o = by.get(r.where) || { where: r.where, via: r.via, bytes: 0 }; o.bytes += r.bytes; by.set(r.where, o); }
  const list = [...by.values()].sort((a, b) => b.bytes - a.bytes);
  const total = list.reduce((a, r) => a + r.bytes, 0);
  return { kbPerSec: round(total / 1024 / seconds), top: list.slice(0, 25).map((r) => ({ kbPerSec: round(r.bytes / 1024 / seconds, 2), where: r.where, via: r.via })) };
}

function summarizeCpu(profile) {
  const total = (profile.endTime - profile.startTime) / 1000, dt = total / Math.max(1, profile.samples.length);
  const self = new Map();
  for (const id of profile.samples) self.set(id, (self.get(id) || 0) + dt);
  const byFile = new Map(), byFn = new Map();
  for (const n of profile.nodes) {
    const ms = self.get(n.id) || 0;
    if (!ms) continue;
    const f = n.callFrame, file = f.url ? f.url.replace(/^https?:\/\/[^/]+/, '') : `(${f.functionName})`;
    byFile.set(file, (byFile.get(file) || 0) + ms);
    const fn = `${f.functionName || '(anonymous)'} ${file}:${f.lineNumber + 1}`;
    byFn.set(fn, (byFn.get(fn) || 0) + ms);
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, ms]) => ({ pct: round(100 * ms / total), ms: round(ms), where: k }));
  return { seconds: round(total / 1000), byFile: top(byFile, 16), byFunction: top(byFn, 25) };
}

async function environment() {
  const tabs = await listTabs();
  const local = tabs.filter((t) => t.type === 'page' && /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(t.url));
  return { otherLocalhostTabs: local.length, otherLocalhostUrls: local.map((t) => t.url), otherPages: tabs.filter((t) => t.type === 'page').length - local.length };
}

async function runPage(job) {
  const env = await environment();           // before our own tab exists
  const before = new Set((await listTabs()).map((t) => t.id));
  // Its own window (so another agent activating a tab cannot hide it); --tab opens a tab instead.
  const target = flag('tab') ? await openTab('about:blank') : await openWindow('about:blank').catch(() => openTab('about:blank'));
  const s = await connect(target);
  const result = { page: job.name, url: BASE + job.path, ...env };
  try {
    await s.send('Page.enable'); await s.send('Runtime.enable');
    await s.send('Page.addScriptToEvaluateOnNewDocument', { source: readFileSync(join(HERE, 'probe.js'), 'utf8') });
    await activateTab(target.id);
    const loaded = new Promise((res) => s.on('Page.loadEventFired', res));
    await s.send('Page.navigate', { url: BASE + job.path });
    await Promise.race([loaded, sleep(20000)]);
    await activateTab(target.id);

    if (job.name === 'profiler') {
      const t0 = Date.now();
      while (!(await s.evaluate('!!(window.__perf && (window.__perf.done || window.__perf.error))'))) {
        if (Date.now() - t0 > 240000) throw new Error('profiler timed out');
        await sleep(500);
      }
      result.profiler = await s.evaluate('window.__perf.toJSON ? window.__perf.toJSON() : window.__perf');
      result.errors = await s.evaluate('window.__probe.errors');
    } else {
      // Heap sawtooth over the steady window (4 Hz, outside the page).
      const heap = [];
      const steadyFrom = SETTLE * 1000, steadyTo = (SETTLE + DURATION) * 1000;
      let now = await s.evaluate('performance.now()');
      await sleep(Math.max(0, steadyFrom - now));
      await activateTab(target.id);
      const end = Date.now() + DURATION * 1000;
      while (Date.now() < end) {
        heap.push((await s.send('Runtime.getHeapUsage')).usedSize);
        await sleep(250);
      }
      const data = await s.evaluate(`(() => { const P = window.__probe; return {
        stamps: Array.from(P.frames.subarray(0, P.n)), longtasks: P.longtasks, errors: P.errors, gl: P.gl, vis: P.vis,
        w: innerWidth, h: innerHeight, dpr: devicePixelRatio, visible: document.visibilityState,
        canvas: (() => { const c = document.querySelector('#scene-world canvas, canvas'); return c ? [c.width, c.height] : null; })(),
        quality: (window.Iskry && Iskry.quality) ? { level: Iskry.quality.level, pixelRatio: Iskry.quality.pixelRatio } : null,
        nav: performance.getEntriesByType('navigation').map((n) => ({ dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd }))[0]
      }; })()`);
      const stamps = data.stamps;
      result.viewport = { w: data.w, h: data.h, dpr: data.dpr, canvas: data.canvas, visible: data.visible };
      result.quality = data.quality;
      // Load: everything before the steady window.
      const links = data.gl.filter((e) => e[1] === 'linkProgram' && e[0] < steadyFrom);
      const lastLink = links.length ? links[links.length - 1][0] : 0;
      const firstAfterLink = stamps.find((t) => t > lastLink) || 0;
      const loadFrames = frameStats(stamps, 0, steadyFrom);
      result.load = {
        firstFrameMs: round(stamps[0] || 0), domContentLoadedMs: round(data.nav ? data.nav.dcl : 0),
        programsLinked: links.length, lastLinkMs: round(lastLink), sceneCompleteMs: round(firstAfterLink),
        worstHitchMs: loadFrames.max || 0, framesOver33: loadFrames.over33 || 0, framesOver50: stamps.filter((t, i) => i && t < steadyFrom && t - stamps[i - 1] > 50).length,
        hitches: (loadFrames.spikes || []).slice(0, 20),
        longtasks: data.longtasks.filter((l) => l[0] < steadyFrom), gl: glSummary(data.gl, 0, steadyFrom)
      };
      result.steady = frameStats(stamps, steadyFrom, steadyTo);
      result.steady.longtasks = data.longtasks.filter((l) => l[0] >= steadyFrom && l[0] < steadyTo);
      result.steady.gl = glSummary(data.gl, steadyFrom, steadyTo);
      let drops = 0, grown = 0;
      for (let i = 1; i < heap.length; i++) { const d = heap[i] - heap[i - 1]; if (d < -262144) drops++; else if (d > 0) grown += d; }
      result.steady.heap = { mb: round(heap[heap.length - 1] / 1048576), minMb: round(Math.min(...heap) / 1048576), maxMb: round(Math.max(...heap) / 1048576), gcDrops: drops, growthKbPerSec: round(grown / 1024 / DURATION) };
      result.errors = data.errors;
      // Time the page spent hidden inside the steady window: anything above 0 voids the numbers.
      let hiddenMs = 0;
      for (let i = 0; i < data.vis.length; i++) {
        if (data.vis[i][1] !== 'hidden') continue;
        const a = Math.max(steadyFrom, data.vis[i][0]), b = Math.min(steadyTo, i + 1 < data.vis.length ? data.vis[i + 1][0] : steadyTo);
        if (b > a) hiddenMs += b - a;
      }
      result.steady.hiddenMs = round(hiddenMs);

      if (SHOTS) {
        mkdirSync(SHOTS, { recursive: true });
        const file = join(SHOTS, `${LABEL}-${job.name.replace(/[^a-z0-9]+/gi, '_')}.png`);
        writeFileSync(file, Buffer.from((await s.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
        result.screenshot = file;
      }
      if (flag('alloc')) {
        const secs = 8;
        await s.send('HeapProfiler.enable');
        await s.send('HeapProfiler.startSampling', { samplingInterval: 4096 });
        await sleep(secs * 1000);
        result.alloc = summarizeAlloc((await s.send('HeapProfiler.stopSampling')).profile, secs);
      }
      if (flag('cpu')) {
        await s.send('Profiler.enable');
        await s.send('Profiler.setSamplingInterval', { interval: 250 });
        await s.send('Profiler.start');
        await sleep(6000);
        result.cpu = summarizeCpu((await s.send('Profiler.stop')).profile);
      }
    }
  } finally {
    s.close();
    if (!flag('keep')) {
      await closeTab(target.id);
      // Dia leaves a start page behind in a window whose last tab closed: close that too (only ours).
      await sleep(400);
      for (const t of await listTabs()) {
        if (t.type === 'page' && !before.has(t.id) && t.url.startsWith('chrome://start-page')) await closeTab(t.id);
      }
    }
  }
  return result;
}

function printPage(r) {
  console.log(`\n== ${r.page}  ${r.url}`);
  console.log(`   other localhost tabs: ${r.otherLocalhostTabs}, other pages: ${r.otherPages}`);
  if (r.profiler) { console.log('   profiler: see JSON (window.__perf)'); return; }
  const v = r.viewport, l = r.load, st = r.steady;
  if (st.hiddenMs > 0) console.log(`   !! the page was HIDDEN for ${st.hiddenMs} ms of the window: these numbers are void, run again`);
  console.log(`   viewport ${v.w}x${v.h} dpr ${v.dpr} canvas ${v.canvas ? v.canvas.join('x') : '-'} ${v.visible}${r.quality ? `  quality level ${r.quality.level} pr ${r.quality.pixelRatio}` : ''}`);
  console.log(`   load    first frame ${l.firstFrameMs} ms, scene complete ${l.sceneCompleteMs} ms (${l.programsLinked} programs), worst hitch ${l.worstHitchMs} ms, frames >33: ${l.framesOver33}, >50: ${l.framesOver50}, long tasks ${l.longtasks.length} (max ${Math.max(0, ...l.longtasks.map((x) => x[1]))} ms)`);
  console.log(`   steady  ${st.fps} fps over ${st.seconds}s: p50 ${st.p50}  p90 ${st.p90}  p95 ${st.p95}  p99 ${st.p99}  max ${st.max} ms | >16.7: ${st.over16_7}  >20: ${st.over20}  >33: ${st.over33} of ${st.frames}`);
  console.log(`           long tasks ${st.longtasks.length}, spikes ${st.spikeCount}${st.period ? ` (mean gap ${st.period.meanSec}s, ${st.period.regular ? 'PERIODIC' : 'irregular'})` : ''}, heap ${st.heap.minMb}-${st.heap.maxMb} MB, GC drops ${st.heap.gcDrops}, growth ${st.heap.growthKbPerSec} kB/s`);
  const glKinds = Object.entries(st.gl).map(([k, o]) => `${k} x${o.calls}${o.bytes ? ` (${round(o.bytes / 1024)} kB)` : ''}`).join(', ');
  if (glKinds) console.log(`           GL in window: ${glKinds}`);
  if (r.alloc) { console.log(`   alloc   ${r.alloc.kbPerSec} kB/s sampled; top:`); for (const a of r.alloc.top.slice(0, 8)) console.log(`           ${String(a.kbPerSec).padStart(7)} kB/s  ${a.where}`); }
  if (r.cpu) { console.log('   cpu     self time by file:'); for (const c of r.cpu.byFile.slice(0, 10)) console.log(`           ${String(c.pct).padStart(5)}%  ${c.where}`); }
  if (r.errors && r.errors.length) console.log(`   console: ${r.errors.length} error/warn lines, first: ${r.errors[0]}`);
}

let head = '';
try { head = execSync('git rev-parse --short HEAD', { cwd: HERE }).toString().trim(); } catch (e) { /* not git */ }
const out = { label: LABEL, date: new Date().toISOString(), gitHead: head, settleSec: SETTLE, durationSec: DURATION, runs: [] };
for (let i = 0; i < REPEAT; i++) {
  for (const job of jobs) {
    const r = await runPage(job);
    r.repeat = i;
    out.runs.push(r);
    printPage(r);
  }
}
mkdirSync(join(HERE, 'results'), { recursive: true });
const file = join(HERE, 'results', `${LABEL}-${out.date.replace(/[:.]/g, '-').slice(0, 19)}.json`);
writeFileSync(file, JSON.stringify(out, null, 1));
console.log('\nwrote ' + file);
