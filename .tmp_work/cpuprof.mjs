import { spawn } from 'node:child_process';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = +process.argv[2] || 8000, dbg = 9600 + (PORT % 100);
const A = +(process.argv[3] || 2500), B = +(process.argv[4] || 7000);
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${process.env.TEMP}/stockv-load-${PORT}`, '--window-size=1600,900', '--no-first-run', '--use-angle=d3d11', '--enable-gpu'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list; for (let i = 0; i < 50; i++) { try { list = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json(); if (list.find((t) => t.type === 'page')) break; } catch {} await sleep(200); }
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable'); await send('Runtime.enable'); await send('Profiler.enable');
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Page.navigate', { url: `http://localhost:${PORT}/` }); await sleep(6000);
await send('Page.navigate', { url: `http://localhost:${PORT}/` });
await sleep(A); await send('Profiler.start'); await sleep(B - A);
const { result } = await send('Profiler.stop');
const nodes = result.profile.nodes, byId = new Map(nodes.map((n) => [n.id, n]));
const dt = result.profile.timeDeltas, samples = result.profile.samples; const self = new Map();
for (let i = 0; i < samples.length; i++) self.set(samples[i], (self.get(samples[i]) || 0) + (dt[i] || 0) / 1000);
// 自身時間 + 含子孫的總時間（依函式名稱+行號）
const parent = new Map(); for (const n of nodes) for (const c of n.children || []) parent.set(c, n.id);
const tot = {}, sf = {};
for (const [nid, ms] of self) {
  const n = byId.get(nid); const k0 = n.callFrame.functionName + '@' + n.callFrame.url.split('/').pop().split('?')[0] + ':' + n.callFrame.lineNumber;
  sf[k0] = (sf[k0] || 0) + ms;
  const seen = new Set(); let p = nid;
  while (p != null) { const m = byId.get(p); const k = m.callFrame.functionName + '@' + m.callFrame.url.split('/').pop().split('?')[0] + ':' + m.callFrame.lineNumber; if (!seen.has(k)) { tot[k] = (tot[k] || 0) + ms; seen.add(k); } p = parent.get(p); }
}
console.log('--- self'); console.log(Object.entries(sf).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => Math.round(v) + 'ms ' + k).join('\n'));
console.log('--- total'); console.log(Object.entries(tot).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => Math.round(v) + 'ms ' + k).join('\n'));
ws.close(); proc.kill(); process.exit(0);
