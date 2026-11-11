// node run.mjs <tid> <url> <probe.js> [dpr=2] [waitSec=9] [shot.png]
import { readFileSync, writeFileSync } from 'node:fs';
const [, , tid, url, probe, dprA, waitA, shot] = process.argv;
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const t = list.find((x) => x.id === tid);
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
await fetch('http://127.0.0.1:9222/json/activate/' + tid);
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1008, deviceScaleFactor: +(dprA || 2), mobile: false });
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, (+(waitA || 9)) * 1000));
await fetch('http://127.0.0.1:9222/json/activate/' + tid);
const r = await send('Runtime.evaluate', { expression: readFileSync(probe, 'utf8'), awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails ?? r));
if (shot) { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(shot, Buffer.from(s.result.data, 'base64')); }
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
