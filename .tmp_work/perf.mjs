// 用 CDP 量測遊戲模式每秒的主執行緒 / 光柵化成本
// 用法：node perf.mjs [label=js-to-eval ...]
import { spawn } from 'node:child_process';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9333;
const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, '--user-data-dir=' + process.env.TEMP + '/stockv-perf',
    '--window-size=1600,900', '--no-first-run', '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu', ...(process.env.EXTRA ? process.env.EXTRA.split(' ') : []),
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ver;
for (let i = 0; i < 50; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (ver.find((t) => t.type === 'page')) break; } catch {}
    await sleep(200);
}
const page = ver.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const listeners = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') console.log('EXC', JSON.stringify(d.params.exceptionDetails).slice(0, 400)); if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') console.log('CERR', JSON.stringify(d.params.args).slice(0, 300)); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } else listeners.forEach((f) => f(d)); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

await send('Page.enable');
await send('Runtime.enable');
if (process.env.FOCUS) await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Page.navigate', { url: 'http://localhost:8000/' });
await sleep(1500);
await ev(`localStorage.setItem('activeRegion', JSON.stringify('game')); 1`);
await send('Page.navigate', { url: 'http://localhost:8000/' });
for (let i = 0; i < 200; i++) { if (await ev(`document.querySelector('#loading')?.classList.contains('gone')`)) break; await sleep(500); }
await sleep(6000);
console.log('region:', await ev(`JSON.stringify({c:document.querySelector('#stage').className,g:document.querySelector('#loading')?.className,ls:localStorage.getItem('activeRegion'),st:document.querySelector('#statusLine')?.textContent})`));

async function measure(label) {
    const events = [];
    const on = (d) => { if (d.method === 'Tracing.dataCollected') events.push(...d.params.value); };
    listeners.push(on);
    const done = new Promise((r) => listeners.push((d) => d.method === 'Tracing.tracingComplete' && r()));
    await send('Tracing.start', { categories: process.env.GPUTOP ? 'toplevel,gpu,viz,cc,skia,disabled-by-default-gpu.service,devtools.timeline,__metadata' : 'toplevel,devtools.timeline,disabled-by-default-devtools.timeline,__metadata', transferMode: 'ReportEvents' });
    await sleep(4000);
    await send('Tracing.end');
    await done;
    listeners.length = 0;
    const sum = {}; let frames = 0; const tn = {}, busy = {};
    for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') tn[e.pid + ':' + e.tid] = e.args.name;
    const iv = {};
    for (const e of events) if (e.ph === 'X' && (e.name === 'ThreadControllerImpl::RunTask' || e.name === 'RunTask') && e.dur) { const k = (tn[e.pid + ':' + e.tid] || 't' + e.tid).replace(/\d+$/, ''); (iv[k] ||= []).push([e.ts, e.ts + e.dur]); }
    for (const [k, a] of Object.entries(iv)) { a.sort((x, y) => x[0] - y[0]); let tot = 0, cs = -1, ce = -1; for (const [s0, e0] of a) { if (s0 > ce) { if (ce > cs) tot += ce - cs; cs = s0; ce = e0; } else ce = Math.max(ce, e0); } if (ce > cs) tot += ce - cs; busy[k] = tot / 1000; }
    for (const e of events) {
        if (e.ph !== 'X' || !e.dur) continue;
        const n = e.name;
        if (['FunctionCall', 'FireAnimationFrame', 'UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'Layerize', 'RasterTask', 'Commit', 'ImageDecodeTask', 'DecodeImage'].includes(n)) sum[n] = (sum[n] || 0) + e.dur / 1000;
        if (n === 'FireAnimationFrame') frames++; if (n === 'Commit') sum.CommitN = (sum.CommitN || 0) + 1;
    }
    if (process.env.GPUTOP) { const by = {}; for (const e of events) if (e.ph === 'X' && e.dur && /GpuMain/.test(tn[e.pid + ':' + e.tid] || '')) by[e.name] = (by[e.name] || 0) + e.dur / 4000; console.log(Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => k + ':' + v.toFixed(0)).join('  ')); }
    const r = Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, +(v / 4).toFixed(1)]));
    console.log(label.padEnd(22), 'ms/s', JSON.stringify(r), 'rAF/s', frames / 4);
    console.log('   busy ms/s', JSON.stringify(Object.fromEntries(Object.entries(busy).filter(([k, v]) => v > 20 && !/VSync|IO|Cache|Browser/.test(k)).map(([k, v]) => [k, Math.round(v / 4)]))), 'commits/s', (sum.CommitN || 0) / 4, 'GPU ms/commit', ((busy.CrGpuMain || 0) / (sum.CommitN || 1)).toFixed(1));
}
const steps = process.argv.slice(2);
if (process.env.CLIP) {
  await ev("window.dispatchEvent(new Event('focus'))"); await sleep(3000);
  const fs = await import('node:fs');
  const rects = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#map use')].map(u=>{const r=u.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}))`));
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < Math.min(4, rects.length); i++) { const [x, y, w, h] = rects[i]; const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: x - 10, y: y - 10, width: w + 20, height: h + 20, scale: 4 } }); fs.writeFileSync(`clip${i}_${k}.png`, Buffer.from(r.result.data, 'base64')); }
    await sleep(700);
  }
  ws.close(); proc.kill(); process.exit(0);
}
if (process.env.PRINT) { await sleep(3000); console.log(await ev(process.env.PRINT)); ws.close(); proc.kill(); process.exit(0); }
await measure('baseline');
for (const s of steps) {
    const [label, js] = s.split('=', 2).length === 2 ? [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)] : [s, s];
    await ev(js);
    await sleep(+(process.env.SETTLE || 800));
    await measure(label);
    if (process.env.SHOT) { const r = await send('Page.captureScreenshot', { format: 'png' }); (await import('node:fs')).writeFileSync('shot_' + label + '.png', Buffer.from(r.result.data, 'base64')); }
}
ws.close(); proc.kill();
process.exit(0);
