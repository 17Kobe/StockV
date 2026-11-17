// 量測重新整理後地形多久畫好：node loadtime.mjs <port> [次數]
import { spawn } from 'node:child_process';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = +process.argv[2] || 8000, RUNS = +process.argv[3] || 3, dbg = 9400 + (PORT % 100);
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${process.env.TEMP}/stockv-load-${PORT}`,
  '--window-size=1600,900', '--no-first-run', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list; for (let i = 0; i < 50; i++) { try { list = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json(); if (list.find((t) => t.type === 'page')) break; } catch {} await sleep(200); }
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
await send('Page.enable'); await send('Runtime.enable'); if (process.env.FOCUS) await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__lt=0;window.__ltb={};new PerformanceObserver(l=>{for(const e of l.getEntries()){window.__lt+=e.duration;const b=Math.floor(e.startTime/1000);window.__ltb[b]=(window.__ltb[b]||0)+Math.round(e.duration)}}).observe({type:'longtask',buffered:true});window.__tu=[];window.__idb=[];const _o=indexedDB.open.bind(indexedDB);indexedDB.open=(...a)=>{const t=performance.now();const r=_o(...a);r.addEventListener('success',()=>{window.__idb.push(['open',Math.round(t),Math.round(performance.now())]);const db=r.result;const _tx=db.transaction.bind(db);let n=0;db.transaction=(...b)=>{const tx=_tx(...b);const t1=performance.now();const k=n++;if(k<5||k%20==0)tx.addEventListener('complete',()=>window.__idb.push([b[1]+k,Math.round(t1),Math.round(performance.now())]));return tx};});return r};let _T;Object.defineProperty(window,'Terrain',{configurable:true,get(){return _T},set(v){const init=v.init;v.init=(o)=>{window.__tinit=performance.now();const u=o.onUpdate;o.onUpdate=()=>{window.__tu.push(performance.now());u()};return init(o)};_T=v}});` });
const url = `http://localhost:${PORT}/`;
await send('Page.navigate', { url }); await sleep(1500);
await ev(`localStorage.setItem('activeRegion', JSON.stringify('game'));localStorage.setItem('perfExp', '${process.env.EXP || ''}')`);
const probe = `(()=>{const c=document.querySelector('#terrain');if(!c||!c.width)return -1;const g=document.createElement('canvas');g.width=64;g.height=36;const x=g.getContext('2d');x.drawImage(c,0,0,64,36);const d=x.getImageData(0,0,64,36).data;const s=new Set();for(let i=0;i<d.length;i+=4)s.add((d[i]>>3)<<10|(d[i+1]>>3)<<5|(d[i+2]>>3));return s.size})()`;
for (let r = 0; r <= RUNS; r++) {
  const t0 = Date.now();
  await send('Page.navigate', { url });
  let tGone = 0;
  let tBmp = 0;
  while (Date.now() - t0 < 15000) { if (!tGone && await ev(`!!document.querySelector('#loading.gone')`)) tGone = Date.now() - t0;
    if (tGone && !tBmp) { const raw = await ev(`[...document.querySelectorAll('#map image')].filter(i=>/[.]svg$/.test(i.getAttribute('href')||'')&&i.style.visibility!=='hidden').length`); if (raw === 0) tBmp = Date.now() - t0; }
    await sleep(100); }
  console.log('    圖示全部換成快照:', tBmp || '>15000', 'ms');
  console.log('    longtask/秒', JSON.stringify(await ev('window.__ltb')));
  const tu = await ev('window.__tu'); const lt = Math.round(await ev('window.__lt'));
  const q = (p) => Math.round(tu[Math.min(tu.length - 1, Math.floor(tu.length * p))] || 0);
  const net = await ev(`JSON.stringify((()=>{const r=performance.getEntriesByType('resource');const t=r.filter(e=>/amazonaws|arcgis|esri|virtualearth/.test(e.name));const sv=r.filter(e=>/[.]svg/.test(e.name));const mk=r.filter(e=>/ikdx|markets[.]json|world-atlas/.test(e.name));return {tiles:t.length,tileNet:t.filter(e=>e.transferSize>0).length,tileEnd:Math.round(Math.max(0,...t.map(e=>e.responseEnd))),svg:sv.length,svgEnd:Math.round(Math.max(0,...sv.map(e=>e.responseEnd))),data:Math.round(Math.max(0,...mk.map(e=>e.responseEnd))),init:Math.round(window.__tinit||0)}})())`);
  if (process.env.IDB) console.log('   ', net, JSON.stringify(await ev('window.__idb')));
  console.log(r === 0 ? '(warm-up)' : `run${r}`, 'loading消失', tGone, '| 地形圖磚', tu.length, '張 50%', q(0.5), '90%', q(0.9), '最後', q(1), 'ms | longtask', lt, 'ms');
}
ws.close(); proc.kill(); process.exit(0);
