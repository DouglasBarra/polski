// Iskry · tools/perf/cdp.mjs — a tiny Chrome DevTools Protocol client for Dia/Chrome (node >= 22, no deps).
// OWNER: perf agent. Used by run.mjs; also a CLI:
//   node tools/perf/cdp.mjs <targetId> '<js expression or @file.js>' [screenshot.png]
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CDP = process.env.CDP || 'http://127.0.0.1:9222';

export async function listTabs() {
  return (await fetch(`${CDP}/json/list`)).json();
}

// Opens a new tab (it never reuses or touches someone else's) and returns its target.
export async function openTab(url = 'about:blank') {
  return (await fetch(`${CDP}/json/new?${url}`, { method: 'PUT' })).json();
}
// Opens a tab in a NEW WINDOW, so tabs that other agents activate in the main window cannot hide it.
export async function openWindow(url = 'about:blank') {
  const v = await (await fetch(`${CDP}/json/version`)).json();
  const b = await connect({ id: 'browser', webSocketDebuggerUrl: v.webSocketDebuggerUrl });
  try {
    const { targetId } = await b.send('Target.createTarget', { url, newWindow: true });
    for (let i = 0; i < 40; i++) {
      const t = (await listTabs()).find((x) => x.id === targetId);
      if (t) return t;
      await sleep(50);
    }
    throw new Error('new window did not appear');
  } finally { b.close(); }
}
export const activateTab = (id) => fetch(`${CDP}/json/activate/${id}`).then((r) => r.text());
export const closeTab = (id) => fetch(`${CDP}/json/close/${id}`).then((r) => r.text());

// A session on one tab: send(method, params) -> result, on(event, fn), evaluate(expr), close().
export async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket failed')); });
  let seq = 0;
  const pending = new Map(), listeners = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.rej(new Error(`${p.method}: ${m.error.message}`)); else p.res(m.result);
    } else if (m.method && listeners.has(m.method)) {
      for (const fn of listeners.get(m.method)) fn(m.params);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res, rej, method }); ws.send(JSON.stringify({ id, method, params }));
  });
  const on = (event, fn) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); };
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('page: ' + ((d.exception && d.exception.description) || d.text));
    }
    return r.result.value;
  };
  return { id: target.id, send, on, evaluate, close: () => ws.close() };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [, , tid, exprArg, shotPath] = process.argv;
  const t = (await listTabs()).find((x) => x.id === tid);
  if (!t || !exprArg) { console.error('usage: cdp.mjs <targetId> <expr|@file> [shot.png]  (tab not found?)'); process.exit(1); }
  const s = await connect(t);
  const expr = exprArg.startsWith('@') ? readFileSync(exprArg.slice(1), 'utf8') : exprArg;
  try {
    if (expr.trim()) console.log(JSON.stringify(await s.evaluate(expr), null, 1));
    if (shotPath) writeFileSync(shotPath, Buffer.from((await s.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  } catch (e) { console.error(String(e.message || e)); process.exitCode = 1; }
  s.close();
}
