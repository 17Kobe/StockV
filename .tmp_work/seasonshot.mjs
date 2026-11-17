// 截圖：node seasonshot.mjs <season> <region> [js]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [season = 'autumn', region = 'game', js = ''] = process.argv.slice(2);
const dbg = 9700 + Math.floor(Math.random() * 200);
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${process.env.TEMP}/stockv-season-${dbg}`, '--window-size=1600,900', '--no-first-run', '--use-angle=d3d11', '--enable-gpu'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list; for (let i = 0; i < 50; i++) { try { list = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json(); if (list.find((t) => t.type === 'page')) break; } catch {} await sleep(200); }
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.method === 'Runtime.consoleAPICalled' && /warn|error/.test(d.params.type)) console.log('CON', JSON.stringify(d.params.args.map(a=>a.value||a.description)).slice(0, 300)); if (d.method === 'Runtime.exceptionThrown') console.log('EXC', JSON.stringify(d.params.exceptionDetails).slice(0, 300)); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send('Page.enable'); await send('Runtime.enable');
const url = `http://localhost:8000/?season=${season}`;
await send('Page.navigate', { url }); await sleep(1500);
await ev(`localStorage.setItem('activeRegion', JSON.stringify('${region}'))`);
await send('Page.navigate', { url });
for (let i = 0; i < 100; i++) { if (await ev(`!!document.querySelector('#loading.gone')`)) break; await sleep(300); }
await sleep(2500);
if (process.env.ZOOM) { const [x, y, n] = process.env.ZOOM.split(',').map(Number); for (let i = 0; i < n; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -240 }); await sleep(250); } }
if (js) { await ev(js); await sleep(9000); } else await sleep(+(process.env.WAIT || 6000));
const clip = process.env.CLIP ? (([x, y, width, height]) => ({ x, y, width, height, scale: 2 }))(process.env.CLIP.split(',').map(Number)) : undefined;
const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
const name = `season_${season}_${process.env.TAG || region}.png`;
fs.writeFileSync(name, Buffer.from(r.result.data, 'base64'));
console.log(name);
ws.close(); proc.kill(); process.exit(0);
