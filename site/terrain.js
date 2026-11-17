/* 遊戲風（文明帝國式）地形：用 DEM + 衛星影像即時「畫」出卡通地形
 *
 * 每張 256×256 圖磚的處理流程：
 *   1. DEM（高度 / 海深）→ 陸海分界、海水深淺色、誇張化的山體光影
 *   2. 衛星影像（先柔化）→ 只用來判斷地貌：沙漠 / 平原 / 草原 / 森林 / 凍原 / 雪地 / 湖泊
 *   3. 依地貌套用遊戲調色盤，海岸加白色浪花、沙灘
 *   4. 山脈直接畫在地表上（岩石色 + 雪線 + 加強稜線光影），不另外貼山的圖示
 *   5. 程序化擺放手繪精靈：針葉林、闊葉林、雨林、沙丘
 * 精靈另外畫在一張四周留邊的透明圖層，跨圖磚邊界也不會被切掉。
 *
 * 效能：圖磚的像素運算和種樹很花時間，瀏覽器支援時交給背景的 Web Worker 處理（同一支檔案在
 * Worker 裡執行時只負責繪製），主執行緒只負責把畫好的圖貼上去，拖曳 / 縮放時就不會卡住。
 * 不支援 Worker + OffscreenCanvas 的瀏覽器照舊在主執行緒處理，畫出來的內容完全一樣。
 *
 * 磁碟快取：畫好的圖磚（地表 JPEG + 精靈 PNG）存進 IndexedDB，下次開網頁直接解碼貼上，
 * 不用重新下載、運算、種樹。鍵值含本檔原始碼的雜湊，改了這支檔案舊圖磚就自動作廢。
 * 下載排隊：同時只下載幾張，畫面上最新需要的先下載，飛越途中已經離開畫面的直接取消。
 */
(function terrainModule() {
'use strict';

const IS_WORKER = typeof document === 'undefined';
const SELF_URL = IS_WORKER ? null : (document.currentScript && document.currentScript.src) || null;

const TS = 256;          // 圖磚邊長（像素）
const PAD = 26;          // 精靈圖層四周留白，讓山和樹可以超出圖磚邊界
const CACHE_MAX = 220;   // 記憶體快取圖磚數（每張約 0.6 MB）
const DISK_MAX = 1500;   // 磁碟快取圖磚數（每張約 60~100 KB）
const MAX_DL = 8;        // 同時下載的圖磚數（每張兩個檔案）
const PF_MAX = 2;        // 背景預先處理同時進行的圖磚數
const OCEAN_BG = '#2378b8';

const cache = new Map();
const pending = [];
const dlq = [];
let opt = null, procRaf = 0, frame = 0;
let wctx = null, sctx64 = null, sctx128 = null;
let pool = null, jobId = 0, dlActive = 0, pfq = [], pfBusy = 0;
const jobs = new Map();

/* ================= 磁碟快取（IndexedDB；主執行緒讀、Worker 寫） ================= */
// 原始碼雜湊：繪製方式一改，舊的圖磚就不會再被讀到
const SRC_VER = (() => {
  const s = terrainModule.toString();
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
})();
const DB_STORE = 'tiles';
let dbP = null;
function db() {
  if (!dbP) dbP = new Promise((res) => {
    try {
      if (typeof indexedDB === 'undefined') { res(null); return; }
      const rq = indexedDB.open('stockv-terrain', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(DB_STORE).createIndex('t', 't');
      rq.onsuccess = () => res(rq.result);
      rq.onerror = rq.onblocked = () => res(null);
    } catch (err) { res(null); }
  });
  return dbP;
}
function diskReq(mode, fn) {
  return db().then((d) => d && new Promise((res) => {
    try {
      const r = fn(d.transaction(DB_STORE, mode).objectStore(DB_STORE));
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch (err) { res(null); }
  }));
}
const diskGet = (key) => diskReq('readonly', (s) => s.get(key));
const diskHas = (key) => diskReq('readonly', (s) => s.count(key)).then((n) => n > 0);
const diskPut = (key, v) => diskReq('readwrite', (s) => s.put(v, key));
// 畫布 → 壓縮檔（地表不透明用 JPEG，精靈要透明用 PNG）
function encode(c, type, q) {
  if (c.convertToBlob) return c.convertToBlob({ type, quality: q });
  return new Promise((res) => c.toBlob(res, type, q));
}
async function diskSave(key, base, spr) {
  try {
    const [b, s] = await Promise.all([encode(base, 'image/jpeg', 0.92), encode(spr, 'image/png')]);
    if (!b || !s) return;
    const [bb, sb] = await Promise.all([b.arrayBuffer(), s.arrayBuffer()]);
    await diskPut(key, { b: bb, bt: b.type, s: sb, st: s.type, t: Date.now() });
  } catch (err) { /* 存不了（空間不足等）就算了，下次重畫 */ }
}
// 主執行緒：原始碼改版就清空；超過上限刪掉最舊的
function diskMaintain() {
  let old = null;
  try { old = localStorage.getItem('stockv.terrainVer'); localStorage.setItem('stockv.terrainVer', SRC_VER); } catch (err) { /* 無痕模式等 */ }
  if (old !== SRC_VER) diskReq('readwrite', (s) => s.clear());
  setTimeout(() => {
    db().then((d) => {
      if (!d) return;
      try {
        const st = d.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE), c = st.count();
        c.onsuccess = () => {
          let n = c.result - DISK_MAX * 0.8;
          if (c.result <= DISK_MAX) return;
          const cur = st.index('t').openCursor();
          cur.onsuccess = () => {
            const k = cur.result;
            if (!k || n-- <= 0) return;
            k.delete(); k.continue();
          };
        };
      } catch (err) { /* 略過 */ }
    });
  }, 6000);
  // 請瀏覽器不要在空間吃緊時優先清掉這個網站的資料（不支援或被拒絕都沒關係）
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (err) { /* 略過 */ }
}

// 畫布：Worker 裡用 OffscreenCanvas，主執行緒用一般的 <canvas>
function newCanvas(w, h) {
  if (IS_WORKER) return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ================= 四季 =================
 * 季節直接畫進圖磚（樹的種類 / 顏色、地面積雪），所以每一幀完全不多花效能。
 * 季節「相位」0~1 以北半球為準：0 = 冬至（12/21）、0.25 = 春分、0.5 = 夏至、0.75 = 秋分；南半球差半年。
 * 相位量化成 SEASON_STEPS 段（約一個月一段），段數放進磁碟快取的鍵值：同一段期間都直接讀快取，
 * 換段時看到的圖磚才重畫一次。網址加 ?season=winter / spring / summer / autumn（或 0~1 的數字）可以預覽。 */
const SEASON_STEPS = 12;
function seasonStep() {
  let p = null;
  try {
    const v = new URLSearchParams(location.search).get('season');
    if (v != null) p = { winter: 0, spring: 0.25, summer: 0.5, autumn: 0.88 }[v] ?? parseFloat(v);
  } catch (err) { /* 略過 */ }
  if (p == null || !isFinite(p)) {
    const now = new Date();
    const day = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 864e5);
    p = (day - 355) / 365;
  }
  p = ((p % 1) + 1) % 1;
  return Math.round(p * SEASON_STEPS) % SEASON_STEPS;
}
// Worker 端由主執行緒在每個工作裡帶過來（e.sq），兩邊一定一致
const SEASON_Q = IS_WORKER ? 0 : seasonStep();
// 環狀的分段線性內插：anchors = [[相位, 值], ...]，相位由小到大、首尾接起來
function ring(anchors, p) {
  const n = anchors.length;
  for (let k = 0; k < n; k++) {
    const [p0, v0] = anchors[k], [p1r, v1] = anchors[(k + 1) % n];
    const p1 = k === n - 1 ? p1r + 1 : p1r;
    const pp = p < p0 ? p + 1 : p;
    if (pp >= p0 && pp <= p1) return v0 + (v1 - v0) * (p1 === p0 ? 0 : (pp - p0) / (p1 - p0));
  }
  return anchors[0][1];
}
// 緯度（絕對值）超過 snow：樹和地面積雪；介於 bare～snow：落葉樹只剩枝幹；介於 leaf～bare：落葉樹變秋色
const SNOW_A = [[0, 48], [0.08, 47], [0.16, 52], [0.25, 58], [0.33, 70], [0.4, 90], [0.66, 90], [0.75, 70], [0.85, 60], [0.92, 55]];
const LEAF_A = [[0.62, 62], [0.72, 52], [0.82, 40], [0.9, 32], [0.96, 30]];
const seasonMemo = new Map();
function seasonAt(step, latDeg) {
  const south = latDeg < 0;
  const key = step * 2 + (south ? 1 : 0);
  let v = seasonMemo.get(key);
  if (v) return v;
  const p = ((step / SEASON_STEPS + (south ? 0.5 : 0)) % 1 + 1) % 1;
  const snow = ring(SNOW_A, p);
  // 秋色：9 月下旬～12 月初，由北往南掃下來
  const leaf = p >= 0.62 && p <= 0.96 ? ring(LEAF_A, p) : 90;
  // 冬天落葉：12 月～4 月初，積雪線往南 16 度內的落葉樹只剩枝幹
  const bare = p >= 0.93 || p <= 0.22 ? snow - 16 : 90;
  v = { snow, leaf: Math.min(leaf, snow), bare: Math.min(bare, snow) };
  seasonMemo.set(key, v);
  return v;
}
function rnd(a, b, c) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// 平滑的值雜訊（以全域像素座標計算，相鄰圖磚接得起來），用來做草地的深淺色塊
function vnoise(px, py, cell, seed) {
  const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
  let fx = px / cell - gx, fy = py / cell - gy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = rnd(gx, gy, seed), b = rnd(gx + 1, gy, seed), c = rnd(gx, gy + 1, seed), d = rnd(gx + 1, gy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/* ================= 調色盤 ================= */
const P = {
  desert: [238, 210, 132],
  plains: [204, 196, 98],
  grass: [138, 196, 76],
  lush: [96, 168, 62],
  forest: [66, 134, 56],
  tundra: [172, 176, 136],
  rock: [156, 140, 120],
  snow: [244, 248, 253],
  beach: [246, 228, 164],
  lake: [86, 196, 220],
  foam: [226, 252, 246]
};
// 海水依深度漸層：淺海松石綠 → 深海藍
const WATER = [[0, [126, 228, 222]], [-30, [74, 202, 216]], [-180, [46, 162, 208]], [-1500, [35, 120, 184]], [-5000, [26, 84, 158]]];
function waterColor(h, out) {
  if (h >= 0) { out[0] = WATER[0][1][0]; out[1] = WATER[0][1][1]; out[2] = WATER[0][1][2]; return; }
  for (let k = 1; k < WATER.length; k++) {
    const [d1, c1] = WATER[k], [d0, c0] = WATER[k - 1];
    if (h >= d1 || k === WATER.length - 1) {
      const t = clamp((h - d0) / (d1 - d0), 0, 1);
      out[0] = c0[0] + (c1[0] - c0[0]) * t; out[1] = c0[1] + (c1[1] - c0[1]) * t; out[2] = c0[2] + (c1[2] - c0[2]) * t;
      return;
    }
  }
}
function mixInto(o, c, t) { o[0] += (c[0] - o[0]) * t; o[1] += (c[1] - o[1]) * t; o[2] += (c[2] - o[2]) * t; }

/* ================= 手繪精靈 ================= */
const SPR = {};
function mk(w, h, fn) {
  const c = newCanvas(w, h);
  const g = c.getContext('2d');
  g.lineJoin = 'round'; g.lineCap = 'round';
  fn(g, w, h);
  return c;
}
function shadow(g, cx, cy, rx, ry) {
  g.fillStyle = 'rgba(28,40,18,.28)';
  g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); g.fill();
}
function pine(g, w, h) {
  shadow(g, w * 0.56, h * 0.93, w * 0.34, h * 0.05);
  g.fillStyle = '#6b4a2b'; g.fillRect(w * 0.45, h * 0.78, w * 0.1, h * 0.16);
  const tiers = [[0.82, 0.42, 0.44], [0.62, 0.34, 0.24], [0.42, 0.24, 0.04]];
  for (const [b, hw, tp] of tiers) {
    g.fillStyle = '#2f7240';
    g.beginPath(); g.moveTo(w * (0.5 - hw), h * b); g.lineTo(w * 0.5, h * tp); g.lineTo(w * (0.5 + hw), h * b); g.closePath(); g.fill();
    g.fillStyle = '#46934f';
    g.beginPath(); g.moveTo(w * (0.5 - hw), h * b); g.lineTo(w * 0.5, h * tp); g.lineTo(w * 0.47, h * b); g.closePath(); g.fill();
  }
  g.strokeStyle = 'rgba(20,50,25,.55)'; g.lineWidth = w * 0.04;
  g.beginPath(); g.moveTo(w * 0.08, h * 0.82); g.lineTo(w * 0.5, h * 0.04); g.lineTo(w * 0.92, h * 0.82); g.stroke();
}
function broadleaf(g, w, h, dark, light, hi) {
  shadow(g, w * 0.56, h * 0.92, w * 0.36, h * 0.06);
  g.fillStyle = '#6b4a2b'; g.fillRect(w * 0.45, h * 0.6, w * 0.1, h * 0.32);
  g.fillStyle = dark; g.beginPath(); g.arc(w * 0.5, h * 0.42, w * 0.4, 0, Math.PI * 2); g.fill();
  g.fillStyle = light; g.beginPath(); g.arc(w * 0.44, h * 0.37, w * 0.31, 0, Math.PI * 2); g.fill();
  g.fillStyle = hi; g.beginPath(); g.arc(w * 0.36, h * 0.28, w * 0.13, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(20,50,25,.5)'; g.lineWidth = w * 0.04;
  g.beginPath(); g.arc(w * 0.5, h * 0.42, w * 0.4, 0, Math.PI * 2); g.stroke();
}
// 積雪的針葉樹：每層樹冠上半截蓋白雪，底邊留一條雪線
function pineSnow(g, w, h) {
  pine(g, w, h);
  const tiers = [[0.82, 0.42, 0.44], [0.62, 0.34, 0.24], [0.42, 0.24, 0.04]];
  for (const [b, hw, tp] of tiers) {
    const yb = tp + (b - tp) * 0.5, k = 0.5;
    g.fillStyle = '#f5f9ff';
    g.beginPath(); g.moveTo(w * (0.5 - hw * k), h * yb); g.lineTo(w * 0.5, h * tp);
    g.lineTo(w * (0.5 + hw * k), h * yb);
    g.quadraticCurveTo(w * 0.5, h * (yb - (b - tp) * 0.12), w * (0.5 - hw * k), h * yb); g.fill();
    g.strokeStyle = 'rgba(245,249,255,.9)'; g.lineWidth = h * 0.025;
    g.beginPath(); g.moveTo(w * (0.5 - hw * 0.92), h * (b - 0.01)); g.lineTo(w * (0.5 + hw * 0.92), h * (b - 0.01)); g.stroke();
  }
}
// 落葉後的枝幹（snow：枝條上緣積雪）
const BRANCHES = [[0.5, 0.5, 0.26, 0.2], [0.5, 0.45, 0.74, 0.18], [0.5, 0.42, 0.5, 0.1], [0.5, 0.62, 0.22, 0.42], [0.5, 0.58, 0.8, 0.38]];
function bareTree(g, w, h, snow) {
  shadow(g, w * 0.56, h * 0.92, w * 0.32, h * 0.05);
  g.strokeStyle = '#6e4a2c';
  g.lineWidth = w * 0.09; g.beginPath(); g.moveTo(w * 0.5, h * 0.92); g.lineTo(w * 0.5, h * 0.45); g.stroke();
  g.lineWidth = w * 0.05;
  for (const [x0, y0, x1, y1] of BRANCHES) { g.beginPath(); g.moveTo(w * x0, h * y0); g.quadraticCurveTo(w * (x0 + x1) / 2, h * y0, w * x1, h * y1); g.stroke(); }
  if (!snow) return;
  g.strokeStyle = '#f5f9ff'; g.lineWidth = w * 0.045;
  for (const [x0, y0, x1, y1] of BRANCHES) { g.beginPath(); g.moveTo(w * (x0 + (x1 - x0) * 0.35), h * (y0 + (y1 - y0) * 0.35) - w * 0.035); g.quadraticCurveTo(w * (x0 + x1) / 2, h * y0 - w * 0.035, w * x1, h * y1 - w * 0.03); g.stroke(); }
  g.fillStyle = '#f5f9ff'; g.beginPath(); g.ellipse(w * 0.5, h * 0.9, w * 0.3, h * 0.05, 0, 0, Math.PI * 2); g.fill();
}
// 椰子樹：微彎的樹幹 + 一叢往外下垂的寬葉片 + 椰子。地圖上只有十幾 px，葉子要畫得粗，縮小後才看得出是椰子樹
function palm(g, w, h) {
  shadow(g, w * 0.6, h * 0.93, w * 0.3, h * 0.05);
  const cx = w * 0.44, cy = h * 0.34;
  g.strokeStyle = '#7a5530'; g.lineWidth = w * 0.11;
  g.beginPath(); g.moveTo(w * 0.56, h * 0.93); g.quadraticCurveTo(w * 0.62, h * 0.58, cx, cy); g.stroke();
  g.strokeStyle = '#a77a45'; g.lineWidth = w * 0.045;
  g.beginPath(); g.moveTo(w * 0.53, h * 0.9); g.quadraticCurveTo(w * 0.58, h * 0.58, cx - w * 0.02, cy + h * 0.02); g.stroke();
  // 葉子：[角度, 長度, 下垂量]，先畫深色底再畫亮色中段
  const fronds = [[-178, 0.44, 0.22], [-140, 0.4, 0.1], [-100, 0.3, 0.03], [-60, 0.4, 0.1], [-4, 0.44, 0.22], [155, 0.34, 0.2], [25, 0.34, 0.2]];
  for (let pass = 0; pass < 2; pass++) {
    for (const [deg, len, dr] of fronds) {
      const a = (deg * Math.PI) / 180, L = w * len;
      const tx = cx + Math.cos(a) * L, ty = cy + Math.sin(a) * L * 0.6 + h * dr;
      const mx = cx + Math.cos(a) * L * 0.55, my = cy + Math.sin(a) * L * 0.45 - h * 0.06;
      const k = w * (pass ? 0.055 : 0.12), nx = -Math.sin(a) * k, ny = Math.cos(a) * k;
      g.fillStyle = pass ? '#6fcf5c' : '#23803a';
      g.beginPath(); g.moveTo(cx, cy);
      g.quadraticCurveTo(mx + nx, my + ny, tx, ty);
      g.quadraticCurveTo(mx - nx, my - ny, cx, cy); g.fill();
    }
  }
  g.fillStyle = '#5a3a14';
  for (const [dx, dy] of [[-0.06, 0.05], [0.05, 0.06], [0, 0.1]]) { g.beginPath(); g.arc(cx + w * dx, cy + h * dy, w * 0.055, 0, Math.PI * 2); g.fill(); }
}
function jungle(g, w, h) {
  shadow(g, w * 0.55, h * 0.9, w * 0.42, h * 0.07);
  const blobs = [[0.3, 0.55, 0.26], [0.7, 0.55, 0.26], [0.5, 0.36, 0.3]];
  for (const [x, y, r] of blobs) {
    g.fillStyle = '#226b34'; g.beginPath(); g.arc(w * x, h * y, w * r, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#34914a'; g.beginPath(); g.arc(w * (x - 0.05), h * (y - 0.05), w * r * 0.72, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#5cb85a'; g.beginPath(); g.arc(w * (x - 0.1), h * (y - 0.1), w * r * 0.28, 0, Math.PI * 2); g.fill();
  }
}
function dune(g, w, h) {
  g.fillStyle = 'rgba(190,140,70,.55)';
  g.beginPath(); g.moveTo(w * 0.05, h * 0.8); g.quadraticCurveTo(w * 0.5, h * 0.05, w * 0.95, h * 0.8);
  g.quadraticCurveTo(w * 0.55, h * 0.45, w * 0.05, h * 0.8); g.fill();
  g.strokeStyle = 'rgba(255,240,200,.9)'; g.lineWidth = h * 0.08;
  g.beginPath(); g.moveTo(w * 0.08, h * 0.78); g.quadraticCurveTo(w * 0.5, h * 0.08, w * 0.92, h * 0.78); g.stroke();
}
function buildSprites() {
  // [畫布, 錨點高度比例]（錨點 = 精靈貼在地圖上的位置）
  SPR.pine = [mk(44, 64, pine), 0.9];
  SPR.tree = [mk(48, 56, (g, w, h) => broadleaf(g, w, h, '#2f7e38', '#4aa046', '#7fcb5e')), 0.9];
  SPR.treeY = [mk(48, 56, (g, w, h) => broadleaf(g, w, h, '#6f8a2a', '#9bb43c', '#cfd86a')), 0.9];
  SPR.jungle = [mk(60, 56, jungle), 0.86];
  // 四季變化用的樹：積雪針葉樹、秋色闊葉樹（楓紅 / 橘 / 金黃）、落葉枝幹、積雪枝幹；海島 / 熱帶海岸的椰子樹
  SPR.pineSnow = [mk(44, 64, pineSnow), 0.9];
  SPR.maple = [mk(48, 56, (g, w, h) => broadleaf(g, w, h, '#a8341c', '#d9532a', '#f59a5c')), 0.9];
  SPR.treeO = [mk(48, 56, (g, w, h) => broadleaf(g, w, h, '#b85e18', '#e58c2a', '#f8c766')), 0.9];
  SPR.treeG = [mk(48, 56, (g, w, h) => broadleaf(g, w, h, '#a8861a', '#d9b635', '#f5e486')), 0.9];
  SPR.bare = [mk(48, 56, (g, w, h) => bareTree(g, w, h, false)), 0.9];
  SPR.bareSnow = [mk(48, 56, (g, w, h) => bareTree(g, w, h, true)), 0.9];
  SPR.palm = [mk(48, 60, palm), 0.92];
  SPR.dune = [mk(84, 34, dune), 0.6];
}

/* ================= 圖磚載入 / 快取 ================= */
let diskOK = false;
function newEntry(z, x, y, extra) {
  return Object.assign({
    z, x, y, ready: false, seen: frame, left: 2,
    key: diskOK ? SRC_VER + '/s' + SEASON_Q + '/' + z + '/' + x + '/' + y : null
  }, extra);
}
// 先查磁碟快取，沒有才排隊下載、重畫
function startEntry(e) {
  if (!e.key) { queueDl(e); return; }
  diskGet(e.key).then((v) => {
    if (e.dead) return;
    if (!v) { queueDl(e); return; }
    const dec = (buf, type) => createImageBitmap(new Blob([buf], { type })).catch(() => null);
    Promise.all([dec(v.b, v.bt), dec(v.s, v.st)]).then(([b, s]) => {
      if (e.dead || !b || !s) {
        for (const x of [b, s]) if (x) x.close();
        if (!e.dead) queueDl(e);
        return;
      }
      e.base = toCanvas(b); e.spr = toCanvas(s);
      finish(e);
    });
  });
}
// 貼到主執行緒的一般 canvas 上再用：直接畫 ImageBitmap 時，有些瀏覽器每一幀都要重新上傳到 GPU，拖曳時反而比較慢
function toCanvas(b) {
  const c = newCanvas(b.width, b.height);
  c.getContext('2d').drawImage(b, 0, 0);
  b.close();
  return c;
}
function finish(e) {
  e.ready = true; e.prev = null;
  opt.onUpdate();
  pfKick(50);
}
function loadImg(url, done) {
  const im = new Image();
  im.crossOrigin = 'anonymous'; // 需要讀取像素，必須走 CORS
  im.decoding = 'async';
  im.onload = done;
  im.onerror = () => { im.bad = true; done(); };
  im.src = url;
  return im;
}
// Worker 模式：只下載原始檔（不解碼），解碼和繪製都在 Worker 裡做
function loadBlob(url, done) {
  fetch(url, { mode: 'cors' }).then((r) => (r.ok ? r.blob() : null)).catch(() => null).then(done);
}
// 下載排隊：畫面上最新需要的先下載；同一幀裡低層級（涵蓋範圍大、當替身用）的先
const byNeed = (a, b) => (b.seen - a.seen) || (a.z - b.z);
function queueDl(e) { dlq.push(e); pumpDl(); }
function pumpDl() {
  if (dlActive >= MAX_DL || !dlq.length) return;
  dlq.sort(byNeed);
  while (dlActive < MAX_DL && dlq.length) {
    const e = dlq.shift();
    if (e.dead) continue;
    // 飛越途中已經離開畫面：先不下載，之後又出現在畫面上時再排隊（get 會叫醒它）
    if (!e.pf && !e.pin && e.seen < frame) { e.parked = true; continue; }
    dlActive++;
    loadSources(e);
  }
}
function loadSources(e) {
  const viaPool = !!pool;
  e.left = 2;
  const done = () => {
    if (--e.left) return;
    dlActive--;
    if (viaPool !== !!pool) { e.demB = e.imgB = null; if (!e.dead && !e.pf) dlq.push(e); } // 處理方式中途換了：重新下載
    else if (!e.dead) pending.push(e);
    kick(); pumpDl();
  };
  if (viaPool) {
    loadBlob(opt.dem(e.z, e.x, e.y), (b) => { e.demB = b; done(); });
    loadBlob(opt.img(e.z, e.x, e.y), (b) => { e.imgB = b; done(); });
  } else {
    e.dem = loadImg(opt.dem(e.z, e.x, e.y), done);
    e.img = loadImg(opt.img(e.z, e.x, e.y), done);
  }
}
// 丟掉圖磚（ImageBitmap 要手動 close 才會馬上釋放記憶體）
function drop(v) {
  v.dead = true;
  for (const b of [v.base, v.spr]) if (b && b.close) b.close();
  v.base = v.spr = null;
}
function get(z, x, y, request) {
  const key = z + '/' + x + '/' + y;
  let e = cache.get(key);
  if (e) {
    cache.delete(key); cache.set(key, e); // LRU
    if (!request) return e;
    if (e.parked) { e.parked = false; e.seen = frame; queueDl(e); }
    return e;
  }
  if (!request) return null;
  e = newEntry(z, x, y);
  cache.set(key, e);
  startEntry(e);
  if (cache.size > CACHE_MAX) {
    for (const [k, v] of cache) {
      if (cache.size <= CACHE_MAX) break;
      if (v.z <= 2) continue; // 低層級全球圖磚永遠保留，當作放大時的替身
      drop(v);
      cache.delete(k);
    }
  }
  return e;
}
function kick() { if (!procRaf) procRaf = requestAnimationFrame(pump); }
// 背景 Worker：每個 Worker 同時最多排 2 張，其餘留在 pending 依「畫面上最近需要」的順序等
const PER_WORKER = 2;
function makePool() {
  if (!SELF_URL || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null;
  try {
    const n = clamp((navigator.hardwareConcurrency || 2) - 1, 1, 3);
    const ws = [];
    for (let i = 0; i < n; i++) {
      const w = new Worker(SELF_URL);
      w.busy = 0;
      w.onmessage = (ev) => onJobDone(w, ev.data);
      w.onerror = (ev) => { ev.preventDefault && ev.preventDefault(); disablePool('Worker 發生錯誤'); };
      ws.push(w);
    }
    return ws;
  } catch (err) {
    return null;
  }
}
// Worker 不能用（例如舊版 Safari 的 OffscreenCanvas 不完整）：改回主執行緒處理，還沒畫好的圖磚重新下載
function disablePool(why) {
  if (!pool) return;
  console.warn('地形改在主執行緒處理：', why);
  for (const w of pool) w.terminate();
  pool = null;
  if (!wctx) setupDrawing();
  pfq = []; pfBusy = 0;
  for (const e of [...pending, ...jobs.values()]) {
    if (e.dead || e.pf) continue;
    e.demB = e.imgB = null;
    dlq.push(e);
  }
  pending.length = 0;
  jobs.clear();
  for (let i = dlq.length - 1; i >= 0; i--) if (dlq[i].pf) dlq.splice(i, 1);
  pumpDl();
}
function onJobDone(w, d) {
  w.busy--;
  const e = jobs.get(d.id);
  jobs.delete(d.id);
  if (d.unsupported) { disablePool(d.err); return; }
  if (d.base && (!e || e.dead || e.pf)) { d.base.close(); d.spr.close(); }
  if (e && e.pf) pfDone();
  else if (e && d.err) { console.warn('地形圖磚處理失敗', e.z, e.x, e.y, d.err); e.failed = true; }
  else if (e && !e.dead && d.base) { e.base = toCanvas(d.base); e.spr = toCanvas(d.spr); finish(e); }
  if (pending.length) kick();
}
function pump() {
  procRaf = 0;
  pending.sort(byNeed); // 畫面上最近需要的先處理
  if (pool) {
    for (const w of pool) {
      while (w.busy < PER_WORKER && pending.length) {
        const e = pending.shift();
        if (e.dead) continue;
        const id = ++jobId;
        jobs.set(id, e);
        w.busy++;
        w.postMessage({ id, z: e.z, x: e.x, y: e.y, sq: SEASON_Q, dem: e.demB, img: e.imgB, key: e.key, keep: !e.pf });
        e.demB = e.imgB = null;
      }
    }
    return;
  }
  const t0 = performance.now();
  let did = false;
  while (pending.length && performance.now() - t0 < 12) {
    const e = pending.shift();
    if (e.dead) continue;
    try {
      render(e);
      e.ready = true; e.prev = null;
      if (e.key && !e.dem.bad && !e.img.bad) diskSave(e.key, e.base, e.spr);
    } catch (err) { console.warn('地形圖磚處理失敗', e.z, e.x, e.y, err); e.failed = true; }
    e.dem = e.img = null;
    did = true;
  }
  if (pending.length) kick();
  if (did) opt.onUpdate();
}

/* ---------- 背景預先處理（例如各個篩選按鈕會飛到的畫面）：畫好只存磁碟，不佔記憶體 ---------- */
let pfTimer = 0;
function pfKick(ms) { if (pfq.length && !pfTimer) pfTimer = setTimeout(pfPump, ms); }
function pfPump() {
  pfTimer = 0;
  if (!pool || !diskOK) return;
  // 畫面上還有圖磚在等：先讓給它們
  for (const e of cache.values()) if (!e.ready && !e.dead && !e.failed && !e.parked && e.seen === frame) { pfKick(400); return; }
  while (pfBusy < PF_MAX && pfq.length) {
    const [z, x, y] = pfq.shift();
    const c = cache.get(z + '/' + x + '/' + y);
    if (c && !c.dead) continue; // 已經在記憶體裡（或正在處理）
    const e = newEntry(z, x, y, { pf: true, seen: -1 });
    if (!e.key) continue;
    pfBusy++;
    diskHas(e.key).then((has) => { if (has) pfDone(); else queueDl(e); });
  }
}
function pfDone() { pfBusy--; pfKick(50); }

/* ================= 單張圖磚的繪製 ================= */
// 每個像素周圍 (2·rad+1)² 範圍內的陸地比例（可分離的方框模糊；超出圖磚沿用邊緣像素）
function landFrac(water, rad) {
  const N = TS * TS, E = TS - 1, tmp = new Float32Array(N), out = new Float32Array(N);
  for (let r = 0; r < TS; r++) {
    const o = r * TS;
    let s = 0;
    for (let c = -rad; c <= rad; c++) s += 1 - water[o + clamp(c, 0, E)];
    for (let c = 0; c < TS; c++) {
      tmp[o + c] = s;
      s += (1 - water[o + Math.min(E, c + rad + 1)]) - (1 - water[o + Math.max(0, c - rad)]);
    }
  }
  const win = (2 * rad + 1) * (2 * rad + 1);
  for (let c = 0; c < TS; c++) {
    let s = 0;
    for (let r = -rad; r <= rad; r++) s += tmp[clamp(r, 0, E) * TS + c];
    for (let r = 0; r < TS; r++) {
      out[r * TS + c] = s / win;
      s += tmp[Math.min(E, r + rad + 1) * TS + c] - tmp[Math.max(0, r - rad) * TS + c];
    }
  }
  return out;
}
function render(e) {
  const { z, x, y } = e;
  const SQ = e.sq ?? SEASON_Q;
  const N = TS * TS, zs = Math.pow(2, z);

  // ---- 1. 高度（Terrarium 編碼：R*256 + G + B/256 - 32768 公尺）----
  const Hh = new Float32Array(N);
  if (!e.dem.bad) {
    wctx.clearRect(0, 0, TS, TS);
    wctx.drawImage(e.dem, 0, 0, TS, TS);
    const d = wctx.getImageData(0, 0, TS, TS).data;
    for (let i = 0, j = 0; i < N; i++, j += 4) Hh[i] = d[j] * 256 + d[j + 1] + d[j + 2] / 256 - 32768;
  }
  // ---- 2. 影像：先縮小再放大 = 柔化，去掉道路、建築等雜訊，只留大片地貌 ----
  let I = null;
  if (!e.img.bad) {
    // 小畫布尺寸剛好等於縮小後的大小，放大時邊緣才不會取樣到透明像素（否則圖磚邊會出現亮線）
    const sc = z < 6 ? sctx128 : sctx64, s = sc.canvas.width;
    sc.clearRect(0, 0, s, s);
    sc.drawImage(e.img, 0, 0, s, s);
    wctx.clearRect(0, 0, TS, TS);
    wctx.drawImage(sc.canvas, 0, 0, TS, TS);
    I = wctx.getImageData(0, 0, TS, TS).data;
  }

  const lat = new Float32Array(TS), mpp = new Float32Array(TS);
  for (let r = 0; r < TS; r++) {
    const n = Math.PI - (2 * Math.PI * (y * TS + r + 0.5)) / (TS * zs);
    const la = Math.atan(Math.sinh(n));
    lat[r] = (la * 180) / Math.PI;
    mpp[r] = (156543.034 * Math.cos(la)) / zs;
  }
  const gradX = (i, c) => (c === 0 ? Hh[i + 1] - Hh[i] : c === TS - 1 ? Hh[i] - Hh[i - 1] : (Hh[i + 1] - Hh[i - 1]) / 2);
  const gradY = (i, r) => (r === 0 ? Hh[i + TS] - Hh[i] : r === TS - 1 ? Hh[i] - Hh[i - TS] : (Hh[i + TS] - Hh[i - TS]) / 2);

  // 光影誇張倍率（低縮放時誇張更多，否則看不出起伏）
  const ex = clamp(1.3 * Math.pow(2, (12 - z) * 0.38), 1.3, 18);

  // ---- 3. 陸海判斷 + 地貌分類 + 底色 ----
  const water = new Uint8Array(N);
  const rock = new Float32Array(N); // 0~1：山地程度（陡 + 高），用來加強稜線光影、不種樹
  const bio = new Uint8Array(N); // 0 草原 1 森林 2 沙漠 3 雪地 4 凍原 5 疏林
  const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
  const col = [0, 0, 0];
  for (let r = 0, i = 0; r < TS; r++) {
    const ar = Math.abs(lat[r]), m = mpp[r];
    const snowLat = seasonAt(SQ, lat[r]).snow;
    for (let c = 0; c < TS; c++, i++) {
      const h = Hh[i];
      let ir = 120, ig = 150, ib = 80, L = 110, sat = 60;
      if (I) {
        ir = I[i * 4]; ig = I[i * 4 + 1]; ib = I[i * 4 + 2];
        L = (ir + ig + ib) / 3;
        sat = Math.max(ir, ig, ib) - Math.min(ir, ig, ib);
      }
      let w;
      if (!I) w = h <= 0;
      else {
        const blue = ib > ir + 8 && ib + 6 >= ig;
        if (h <= -120) w = true;
        else if (h <= 3) w = blue || L < 26;
        else {
          // 內陸湖泊：影像偏藍且地面平坦
          const sl = (Math.abs(gradX(i, c)) + Math.abs(gradY(i, r))) / m;
          w = h > 3 && blue && L < 125 && sl < 0.01;
        }
      }
      if (w) {
        water[i] = 1;
        if (h < 0) waterColor(Math.min(h, 0), col); else { col[0] = P.lake[0]; col[1] = P.lake[1]; col[2] = P.lake[2]; }
      } else {
        // t：0 = 乾燥（沙漠）→ 1 = 茂盛（綠地）
        const t = clamp((ig - ir + 38) / 70, 0, 1);
        if (t < 0.45) { col[0] = P.desert[0]; col[1] = P.desert[1]; col[2] = P.desert[2]; mixInto(col, P.plains, t / 0.45); }
        else if (t < 0.75) { col[0] = P.plains[0]; col[1] = P.plains[1]; col[2] = P.plains[2]; mixInto(col, P.grass, (t - 0.45) / 0.3); }
        else { col[0] = P.grass[0]; col[1] = P.grass[1]; col[2] = P.grass[2]; mixInto(col, P.lush, (t - 0.75) / 0.25); }
        // 深色植被 → 森林
        const fw = clamp((t - 0.5) * 2.5, 0, 1) * clamp((100 - L) / 45, 0, 1);
        mixInto(col, P.forest, fw);
        // 灰色、低彩度 → 凍原 / 岩地
        const gw = clamp((30 - sat) / 30, 0, 1) * clamp((L - 55) / 60, 0, 1) * (1 - fw);
        mixInto(col, ar > 45 ? P.tundra : P.rock, gw * 0.75);
        // 山地：不畫山的圖示，改用「陡峭 + 高海拔 → 岩石色」讓山脈自然長在地表上
        const gxv = gradX(i, c) / m, gyv = gradY(i, r) / m;
        const sl = Math.sqrt(gxv * gxv + gyv * gyv) * ex;
        const rk = clamp((sl - 0.22) / 0.5, 0, 1) * clamp((h - 500) / 1300, 0, 1);
        rock[i] = rk;
        mixInto(col, P.rock, rk * 0.75);
        // 雪線依緯度下降：赤道約 5200 m，45° 約 3500 m，60° 約 2200 m
        const snowline = 5200 - Math.max(0, ar - 25) * 85;
        const hs = clamp((h - snowline) / 700, 0, 1) * clamp(0.35 + rk, 0, 1);
        // 影像白色、低彩度 → 雪
        const sw = Math.max(hs, clamp((L - 172) / 45, 0, 1) * clamp((48 - sat) / 30, 0, 1));
        mixInto(col, P.snow, sw);
        // 季節積雪：超過積雪線的陸地蓋上一層雪（邊緣用雜訊做出斑駁，不要一條直線）；沙漠少一點
        if (ar > snowLat - 6) {
          const nz = vnoise(x * TS + c, y * TS + r, 18, 5) - 0.5;
          const sn = clamp((ar - snowLat + nz * 8) / 5, 0, 1) * (t < 0.18 ? 0.45 : 0.78);
          if (sn > 0) mixInto(col, P.snow, sn);
        }
        bio[i] = sw > 0.5 ? 3 : fw > 0.45 ? 1 : t < 0.18 ? 2 : gw > 0.5 ? 4 : fw > 0.2 ? 5 : 0;
      }
      R[i] = col[0]; G[i] = col[1]; B[i] = col[2];
    }
  }

  // ---- 4. 海岸：附近陸地比例（可分離的方框模糊）→ 浪花 / 沙灘 ----
  const rad = z >= 5 ? 3 : 2;
  const tmp = new Float32Array(N), lb = new Float32Array(N);
  // 超出圖磚的部分沿用邊緣像素（不能當成海，否則圖磚邊會冒出一圈沙灘）
  const E = TS - 1;
  for (let r = 0; r < TS; r++) {
    let s = 0;
    const o = r * TS;
    for (let c = -rad; c <= rad; c++) s += 1 - water[o + clamp(c, 0, E)];
    for (let c = 0; c < TS; c++) {
      tmp[o + c] = s;
      s += (1 - water[o + Math.min(E, c + rad + 1)]) - (1 - water[o + Math.max(0, c - rad)]);
    }
  }
  const win = (2 * rad + 1) * (2 * rad + 1);
  for (let c = 0; c < TS; c++) {
    let s = 0;
    for (let r = -rad; r <= rad; r++) s += tmp[clamp(r, 0, E) * TS + c];
    for (let r = 0; r < TS; r++) {
      lb[r * TS + c] = s / win;
      s += tmp[Math.min(E, r + rad + 1) * TS + c] - tmp[Math.max(0, r - rad) * TS + c];
    }
  }

  // 較大範圍的陸地比例：判斷「靠海」（椰子樹用），跟上面的浪花 / 沙灘分開算
  const lw = landFrac(water, z >= 6 ? 16 : 8);

  // ---- 5. 光影：誇張化的山體陰影，山地的稜線再加強對比 ----
  const lx = -0.62, ly = -0.62, lz = 0.48; // 西北方的光
  const flat = lz;
  const out = new ImageData(TS, TS);
  const o = out.data;
  for (let r = 0, i = 0; r < TS; r++) {
    const m = mpp[r];
    for (let c = 0; c < TS; c++, i++) {
      let cr = R[i], cg = G[i], cb = B[i];
      const nb = (Math.imul((x * TS + c) | 0, 73856093) ^ Math.imul((y * TS + r) | 0, 19349663)) >>> 0;
      const noise = ((nb >>> 7) & 7) - 3.5;
      if (water[i]) {
        const f = clamp(lb[i] * 2.4, 0, 1); // 越靠岸越白
        cr += (P.foam[0] - cr) * f * 0.85; cg += (P.foam[1] - cg) * f * 0.85; cb += (P.foam[2] - cb) * f * 0.85;
        cr += noise * 0.6; cg += noise * 0.6; cb += noise * 0.6;
      } else {
        const wb = 1 - lb[i];
        if (z >= 6 && wb > 0.25 && Hh[i] < 30 && bio[i] !== 1 && bio[i] !== 3) {
          const f = clamp((wb - 0.25) * 2.5, 0, 1) * 0.8;
          cr += (P.beach[0] - cr) * f; cg += (P.beach[1] - cg) * f; cb += (P.beach[2] - cb) * f;
        }
        const nx = (-gradX(i, c) / m) * ex, ny = (-gradY(i, r) / m) * ex;
        const len = Math.sqrt(nx * nx + ny * ny + 1);
        const sh = (nx * lx + ny * ly + lz) / len;
        let f = 0.32 + (0.68 * sh) / flat;
        f = clamp(1 + (f - 1) * (1 + rock[i] * 0.9), 0.38, 1.45);
        if (f >= 1) {
          // 受光面：偏暖的提亮
          const k = (f - 1) * 0.9;
          cr += (255 - cr) * k; cg += (248 - cg) * k; cb += (215 - cb) * k * 0.8;
        } else {
          // 背光面：偏藍紫的陰影
          cr *= f; cg *= f; cb *= f * 0.92 + 0.1;
        }
        // 手繪感的深淺色塊（大塊 + 小塊兩層）
        const gpx = x * TS + c, gpy = y * TS + r;
        const vn = vnoise(gpx, gpy, 24, 1) * 0.62 + vnoise(gpx, gpy, 7, 2) * 0.38 - 0.5;
        const k = 1 + vn * 0.16;
        cr = cr * k + noise; cg = cg * (k + vn * 0.04) + noise; cb = cb * k + noise;
      }
      o[i * 4] = cr; o[i * 4 + 1] = cg; o[i * 4 + 2] = cb; o[i * 4 + 3] = 255;
    }
  }
  const base = newCanvas(TS, TS);
  base.getContext('2d').putImageData(out, 0, 0);
  e.base = base;

  // ---- 6. 精靈擺放 ----
  const list = [];
  // 樹林
  const TC = 12;
  for (let cy = 0; cy * TC < TS; cy++) {
    for (let cx = 0; cx * TC < TS; cx++) {
      const gx = x * 22 + cx, gy = y * 22 + cy;
      const px = cx * TC + rnd(gx, gy, z + 1) * TC, py = cy * TC + rnd(gx, gy, z + 2) * TC;
      const ci = clamp(py | 0, 0, TS - 1), cj = clamp(px | 0, 0, TS - 1), i = ci * TS + cj;
      if (water[i]) continue;
      const al = Math.abs(lat[ci]);
      // 熱帶 / 亞熱帶（南北緯 27° 內）靠海的地方：種椰子樹（例如台灣南部、東南亞島嶼、加勒比海），可以種到離岸比較近
      // 北回歸線以南的低地（例如台灣南部、海南島）就算離海遠一點也種椰子樹
      const coast = al < 27 && (lw[i] < 0.97 || (al < 23.6 && Hh[i] < 250));
      if (lb[i] < (coast ? 0.6 : 0.9)) continue;
      const b = bio[i], p = rnd(gx, gy, z + 3), q = rnd(gx, gy, z + 4);
      if (rock[i] > 0.35) continue; // 陡峭山地不種樹
      const dense = b === 1 ? p < 0.92 : b === 5 ? p < 0.35 : b === 0 ? p < 0.04 : false;
      // 熱帶沒有凍原：灰色低彩度（b === 4）在這裡多半是城鎮 / 農田，也可以種
      const palmy = coast && b !== 3 && (b === 2 ? p < 0.15 : p < 0.45);
      if (!dense && !palmy) continue;
      let type;
      if (coast && (!dense || q < 0.6)) type = 'palm';
      else type = al < 20 ? (q < 0.8 ? 'jungle' : 'tree') : al > 50 ? 'pine' : q < 0.45 ? 'pine' : b === 5 ? 'treeY' : 'tree';
      // 季節：每棵樹的分界線各自錯開幾度，季節交界才不會是一條直線
      if (type === 'pine' || type === 'tree' || type === 'treeY') {
        const S = seasonAt(SQ, lat[ci]), jit = (rnd(gx, gy, z + 5) - 0.5) * 6, r2 = rnd(gx, gy, z + 6);
        if (type === 'pine') { if (al > S.snow + jit) type = 'pineSnow'; }
        else if (al > S.snow + jit) type = 'bareSnow';
        else if (al > S.bare + jit) type = 'bare';
        else if (al > S.leaf + jit && r2 < 0.25 + clamp((al - S.leaf - jit) / 6, 0, 1) * 0.65) {
          const r3 = rnd(gx, gy, z + 7);
          type = r3 < 0.4 ? 'maple' : r3 < 0.75 ? 'treeO' : 'treeG';
        }
      }
      const size = (type === 'jungle' ? 13 : type === 'palm' ? 14 : type === 'pine' || type === 'pineSnow' ? 9 : 10.5) * (0.85 + q * 0.3);
      list.push([px, py, type, size]);
    }
  }
  // 沙丘
  const DC = 34;
  for (let cy = 0; cy * DC < TS; cy++) {
    for (let cx = 0; cx * DC < TS; cx++) {
      const gx = x * 8 + cx, gy = y * 8 + cy;
      if (rnd(gx, gy, z + 11) > 0.5) continue;
      const px = cx * DC + rnd(gx, gy, z + 12) * DC, py = cy * DC + rnd(gx, gy, z + 13) * DC;
      const ci = clamp(py | 0, 0, TS - 1), cj = clamp(px | 0, 0, TS - 1), i = ci * TS + cj;
      if (water[i] || bio[i] !== 2 || Hh[i] > 1300) continue;
      if (rock[i] > 0.2) continue;
      list.push([px, py, 'dune', 22]);
    }
  }
  list.sort((a, b) => a[1] - b[1]); // 由上往下畫，下方的精靈蓋住上方
  const sp = newCanvas(TS + PAD * 2, TS + PAD * 2);
  const g = sp.getContext('2d');
  for (const [u, v, type, size] of list) {
    const [img, anchor] = SPR[type];
    const w = size, h = (size * img.height) / img.width;
    g.drawImage(img, PAD + u - w / 2, PAD + v - h * anchor, w, h);
  }
  e.spr = sp;
}

/* ================= 對外介面 ================= */
// 繪製用的暫存畫布與精靈（主執行緒、Worker 各自準備一份）
function setupDrawing() {
  wctx = newCanvas(TS, TS).getContext('2d', { willReadFrequently: true });
  const small = (n) => {
    const g = newCanvas(n, n).getContext('2d');
    g.imageSmoothingQuality = 'high';
    return g;
  };
  sctx64 = small(64); sctx128 = small(128);
  buildSprites();
}
function init(o) {
  opt = o;
  diskOK = typeof indexedDB !== 'undefined' && typeof createImageBitmap !== 'undefined';
  if (diskOK) diskMaintain();
  pool = makePool();
  if (!pool) setupDrawing();
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) get(2, x, y, true).pin = true;
}

// 畫面 t 要用哪一層、哪些圖磚。t：d3 zoom transform；S0：k=1 時世界正方形的邊長（CSS 像素）
function tileRange(t, S0, W, H, dpr) {
  const world = S0 * t.k;
  // 依「裝置像素」挑層級，Retina / 手機螢幕也清晰
  const zf = Math.log2((world * dpr) / TS);
  const z = clamp(Math.ceil(zf - 0.2), 0, opt.maxZ);
  const n = 1 << z, ts = world / n;
  // 東西向無限循環（像 Google 地圖）：x 不設上下限，取圖磚時再對 n 取餘數
  return {
    z, n, ts,
    x0: Math.floor(-t.x / ts), x1: Math.floor((W - t.x) / ts),
    y0: Math.max(0, Math.floor(-t.y / ts)), y1: Math.min(n - 1, Math.floor((H - t.y) / ts))
  };
}

function draw(ctx, t, S0, W, H, dpr) {
  frame++;
  const cv = ctx.canvas;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = OCEAN_BG;
  ctx.fillRect(0, 0, cv.width, cv.height);

  const { z, n, ts, x0, x1, y0, y1 } = tileRange(t, S0, W, H, dpr);
  const sprites = [];
  for (let y = y0; y <= y1; y++) {
    const Y0 = Math.round((t.y + y * ts) * dpr), Y1 = Math.round((t.y + (y + 1) * ts) * dpr);
    for (let x = x0; x <= x1; x++) {
      const X0 = Math.round((t.x + x * ts) * dpr), X1 = Math.round((t.x + (x + 1) * ts) * dpr);
      const xi = ((x % n) + n) % n; // 繞回世界範圍內的實際圖磚編號
      const e = get(z, xi, y, true);
      e.seen = frame;
      // 畫好了就用；遮罩 / 道路換了正在重畫的，先用舊的
      const im = e.ready ? e : e.prev;
      if (im) {
        ctx.drawImage(im.base, X0, Y0, X1 - X0, Y1 - Y0);
        sprites.push(im, X0, Y0, X1 - X0);
        continue;
      }
      // 還沒處理好：順便請上兩層的圖磚（一張頂 16 張，很快就能先蓋滿畫面），
      // 先用已完成、最接近的上層圖磚放大頂替
      if (z >= 5) get(z - 2, xi >> 2, y >> 2, true).seen = frame;
      for (let d = 1; d <= Math.min(z, 12); d++) {
        const p = get(z - d, xi >> d, y >> d, false);
        const pi = p && (p.ready ? p : p.prev);
        if (!pi) continue;
        const s = TS / (1 << d);
        ctx.drawImage(pi.base, (xi - ((xi >> d) << d)) * s, (y - ((y >> d) << d)) * s, s, s, X0, Y0, X1 - X0, Y1 - Y0);
        break;
      }
    }
  }
  // 精靈圖層最後畫（四周有留白，可以蓋過相鄰圖磚）
  for (let i = 0; i < sprites.length; i += 4) {
    const e = sprites[i], X0 = sprites[i + 1], Y0 = sprites[i + 2], w = sprites[i + 3];
    const s = w / TS;
    ctx.drawImage(e.spr, X0 - PAD * s, Y0 - PAD * s, (TS + PAD * 2) * s, (TS + PAD * 2) * s);
  }
}

// 背景預先處理這些畫面（d3 zoom transform 陣列）會用到的圖磚：畫面上的圖磚都好了才開始，
// 一次只做幾張，畫好存進磁碟快取。之後切過去就是直接讀檔。再呼叫一次會取代之前的清單
function prefetch(views, S0, W, H, dpr) {
  if (!opt) return;
  const out = [], seen = new Set();
  for (const t of views) {
    const { z, n, x0, x1, y0, y1 } = tileRange(t, S0, W, H, dpr);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const xi = ((x % n) + n) % n, k = z + '/' + xi + '/' + y;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push([z, xi, y]);
      }
    }
  }
  pfq = out;
  pfKick(1500);
}

/* ================= Worker 端 ================= */
if (IS_WORKER) {
  let ok = true;
  try { setupDrawing(); } catch (err) { ok = String(err); }
  const decode = async (b) => {
    if (!b) return { bad: true };
    try { return await createImageBitmap(b); } catch (err) { return { bad: true }; }
  };
  self.onmessage = async (ev) => {
    const d = ev.data;
    // 這個瀏覽器的 OffscreenCanvas 不能用：請主執行緒改回自己畫
    if (ok !== true) { self.postMessage({ id: d.id, unsupported: true, err: ok }); return; }
    const e = { z: d.z, x: d.x, y: d.y, sq: d.sq };
    e.dem = await decode(d.dem);
    e.img = await decode(d.img);
    try {
      render(e);
      // 兩個來源都下載成功才存磁碟（斷線時畫出來的殘缺圖磚不能留到下次）
      if (d.key && !e.dem.bad && !e.img.bad) await diskSave(d.key, e.base, e.spr);
      if (d.keep) {
        const base = e.base.transferToImageBitmap(), spr = e.spr.transferToImageBitmap();
        self.postMessage({ id: d.id, base, spr }, [base, spr]);
      } else self.postMessage({ id: d.id });
    } catch (err) {
      self.postMessage({ id: d.id, err: String(err) });
    } finally {
      for (const b of [e.dem, e.img]) if (b.close) b.close();
    }
  };
  return;
}

window.Terrain = { init, draw, prefetch };
})();
