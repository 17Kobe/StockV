import { spawn } from 'node:child_process';
import fs from 'node:fs';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const dbg = 9950;
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${process.env.TEMP}/stockv-spr`, '--window-size=900,420', '--no-first-run'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list; for (let i = 0; i < 50; i++) { try { list = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json(); if (list.find((t) => t.type === 'page')) break; } catch {} await sleep(200); }
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: 'about:blank' }); await sleep(800);
const src = fs.readFileSync('../site/terrain.js', 'utf8');
const pick = (name) => { const i = src.indexOf('function ' + name + '('); let d = 0, j = src.indexOf('{', i); for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; } return src.slice(i, j + 1); };
const code = ['shadow', 'pine', 'pineSnow', 'broadleaf', 'bareTree', 'palm', 'jungle'].map(pick).join('\n') + '\n' + src.match(/const BRANCHES = [^\n]*/)[0];
const r = await send('Runtime.evaluate', { returnByValue: true, expression: `(()=>{${code}
document.body.innerHTML='';document.body.style.cssText='margin:0;background:#9ec45a';
const c=document.createElement('canvas');c.width=900;c.height=420;document.body.append(c);const G=c.getContext('2d');
const mk=(w,h,fn)=>{const x=document.createElement('canvas');x.width=w;x.height=h;const g=x.getContext('2d');g.lineJoin='round';g.lineCap='round';fn(g,w,h);return x};
const list=[['pine',44,64,pine],['pineSnow',44,64,pineSnow],['tree',48,56,(g,w,h)=>broadleaf(g,w,h,'#2f7e38','#4aa046','#7fcb5e')],['maple',48,56,(g,w,h)=>broadleaf(g,w,h,'#a8341c','#d9532a','#f59a5c')],['treeO',48,56,(g,w,h)=>broadleaf(g,w,h,'#b85e18','#e58c2a','#f8c766')],['treeG',48,56,(g,w,h)=>broadleaf(g,w,h,'#a8861a','#d9b635','#f5e486')],['bare',48,56,(g,w,h)=>bareTree(g,w,h,false)],['bareSnow',48,56,(g,w,h)=>bareTree(g,w,h,true)],['palm',48,60,palm],['jungle',60,56,jungle]];
list.forEach(([n,w,h,f],k)=>{const s=mk(w,h,f);G.drawImage(s,10+k*88,10,w*1.6,h*1.6);const sz=n==='palm'?14:n.startsWith('pine')?9:n==='jungle'?13:10.5;for(let j=0;j<4;j++)G.drawImage(s,10+k*88+j*18,180,sz*2,sz*2*h/w);for(let j=0;j<4;j++)G.drawImage(s,10+k*88+j*14,280,sz,sz*h/w);G.fillStyle='#000';G.font='12px sans-serif';G.fillText(n,10+k*88,400)});
return 1})()` });
await sleep(300);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('sprites.png', Buffer.from(shot.result.data, 'base64'));
ws.close(); proc.kill(); process.exit(0);
