/* 海面特效（WebGL，一張全螢幕畫布、一次繪製）：
 *   1. 海浪：預先算好的可循環法線貼圖，兩層不同方向捲動 → 水面起伏的明暗
 *   2. 波光：依真實太陽位置算日照，白天金白色反光（晨昏偏橘），夜晚換成淡淡的銀色月光
 *   3. 透明感：淺海有焦散光紋（陽光透過水面打在海底），水下有魚群、魟魚、海龜、鯨魚、水母的影子
 *   4. 船的水波：移動中的船拖出 V 字尾流 + 船尾白浪，停著的船 / 海洋生物周圍一圈圈漣漪；夜晚尾流發出藍綠色螢光
 *
 * 陸海遮罩：每次地形重畫（平移 / 縮放）時，把「還沒蓋夜色」的地形畫布縮小一半複製一份，
 * 用顏色判斷海水（海水的藍色明顯大於紅色），綠色通道當作深淺（淺海偏松石綠）。
 * 海浪貼圖的座標固定在地圖上（拖曳時跟著地圖走），縮放時在兩個尺度間淡入淡出，不會跳動。
 *
 * 效能：畫布只用約 0.65~0.8 倍解析度（水波本來就是柔和的效果），陸地像素第一個取樣就提早結束；
 * 頻率由 app.js 的主迴圈節流（沒焦點時更低），動畫關閉 / 系統要求減少動態時只在地圖移動時畫一張靜態的。
 * 不支援 WebGL 就整層不顯示，不影響其它功能。 */
(function () {
  'use strict';
  const MAXC = 14; // 同時最多幾隻水下生物
  const MAXW = 16; // 同時最多幾個水波來源（船 / 海洋生物）
  const TILE_PX = 340; // 海浪貼圖一格在畫面上約多大（CSS px）
  const NT = 256; // 海浪貼圖邊長
  const MASK_S = 0.5; // 陸海遮罩的解析度（相對 CSS px）
  const CPU_S = 1 / 8; // 給 JS 判斷生物位置用的遮罩解析度

  let cv = null,
    gl = null,
    prog = null,
    progPrep = null,
    progBlur = null,
    locQ = null,
    texC = null,
    fbC = null,
    coastW = 0,
    coastH = 0,
    buf = null,
    texN = null,
    texM = null,
    loc = null,
    ready = false,
    dead = false,
    bright = null;
  let W = 0,
    H = 0,
    RS = 0.65;
  let snap = null,
    sctx = null,
    maskDirty = false,
    hasMask = false;
  let cpuCv = null,
    cpuCtx = null,
    cpu = null,
    cpuW = 0,
    cpuH = 0,
    cpuAt = -1e9,
    cpuDirty = true,
    waterFrac = 1;
  let blank = false; // 上一張畫的是空白（畫面上沒有海）
  const creatures = [];
  let spawnAcc = 1,
    steerAcc = 0;
  const C0 = new Float32Array(MAXC * 4),
    C1 = new Float32Array(MAXC * 4),
    W0 = new Float32Array(MAXW * 4),
    W1 = new Float32Array(MAXW * 4);

  /* ---------- 著色器 ---------- */
  const VS = `
attribute vec2 aPos;
uniform vec2 uRes;
uniform vec4 uLodA;
uniform vec4 uLodB;
uniform vec4 uGeo;
varying vec2 vCss;
varying vec4 vUv;
varying vec2 vGeo;
void main() {
  vec2 css = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5) * uRes;
  vCss = css;
  vUv = vec4(css * uLodA.x + uLodA.yz, css * uLodB.x + uLodB.yz);
  vGeo = vec2(uGeo.x + css.x * uGeo.y, uGeo.z + css.y * uGeo.w);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;
  const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
#define MAXC ${MAXC}
#define MAXW ${MAXW}
uniform sampler2D uNoise;
uniform sampler2D uMask;
uniform sampler2D uCoast; // 模糊過的陸海遮罩：岸邊約 0.5，往外海漸增到 1（離岸遠近）
uniform vec2 uRes;
uniform vec4 uT1;   // 第一 / 第二層海浪的捲動位移
uniform vec4 uT2;   // 焦散兩層的捲動位移
uniform vec4 uT3;   // xy：閃光雜訊的捲動位移；zw：大範圍斑塊的飄移
uniform vec2 uPatch; // 大範圍斑塊的縮放（世界一圈要剛好是整數個斑塊週期，換日線才接得起來）
uniform float uLodF;
uniform float uZoom; // 0 = 全球視角 ~ 1 = 放大很多
uniform float uTime;
uniform float uShore; // 岸邊浪的相位（0~1 循環）
uniform vec2 uDecl; // sin / cos(太陽赤緯)
uniform float uSunLon; // 太陽直射經度（弳）：vGeo.x 是時角，加回來就是真正的經度
uniform vec4 uC0[MAXC];
uniform vec4 uC1[MAXC];
uniform int uNC;
uniform vec4 uW0[MAXW];
uniform vec4 uW1[MAXW];
uniform int uNW;
varying vec2 vCss;
varying vec4 vUv;
varying vec2 vGeo;

float ell(vec2 p, vec2 r, float b) { return smoothstep(1.0 + b, 1.0 - b, length(p / r)); }
float fish(vec2 p, float ph) {
  p.y += sin(p.x * 9.0 - ph * 10.0) * 0.04 * (0.6 - p.x);
  float body = ell(p - vec2(0.06, 0.0), vec2(0.34, 0.12), 0.3);
  float tx = (-p.x - 0.24) / 0.22;
  float tw = 0.02 + clamp(tx, 0.0, 1.0) * 0.13;
  float tail = smoothstep(tw + 0.03, tw - 0.02, abs(p.y)) * smoothstep(-0.1, 0.05, tx) * smoothstep(1.05, 0.9, tx);
  return max(body, tail);
}
// 生物外形（q：以生物為中心、頭朝 +x、長度為 1 的座標）。回傳覆蓋率 0~1（水下的影子邊緣是柔的）
float creature(vec2 q, float type, float ph) {
  if (type < 0.5) return fish(q, ph);
  if (type < 1.5) {
    float c = 0.0;
    for (int j = 0; j < 7; j++) {
      float fj = float(j);
      vec2 o = vec2(fract(sin(fj * 12.9898 + 1.0) * 43758.5453), fract(sin(fj * 78.233 + 2.0) * 43758.5453)) - 0.5;
      o = o * vec2(0.8, 0.62) + 0.035 * vec2(sin(ph * 1.3 + fj * 2.1), cos(ph * 1.1 + fj * 1.7));
      c = max(c, fish((q - o) / 0.24, ph * 1.6 + fj * 0.7));
    }
    return c;
  }
  if (type < 2.5) {
    float flap = 0.8 + 0.2 * sin(ph * 2.0);
    float d = abs(q.x - 0.02) / 0.26 + pow(abs(q.y) / (0.5 * flap), 1.4);
    float wing = smoothstep(1.15, 0.85, d);
    float tail = smoothstep(0.035, 0.005, abs(q.y + sin(q.x * 10.0 - ph * 3.0) * 0.02)) * step(-0.75, q.x) * step(q.x, -0.15) * 0.8;
    return max(wing, tail);
  }
  if (type < 3.5) {
    vec2 a = vec2(q.x, abs(q.y));
    float f = sin(ph * 2.2) * 0.06;
    float c = ell(q, vec2(0.26, 0.2), 0.25);
    c = max(c, ell(q - vec2(0.34, 0.0), vec2(0.09, 0.07), 0.3));
    c = max(c, ell(a - vec2(0.1 + f, 0.24), vec2(0.14, 0.05), 0.35));
    c = max(c, ell(a - vec2(-0.2 - f * 0.5, 0.15), vec2(0.07, 0.04), 0.35));
    return c;
  }
  if (type < 4.5) {
    vec2 p = q;
    p.y += sin(p.x * 3.0 - ph * 1.5) * 0.025 * (0.5 - p.x);
    vec2 a = vec2(p.x, abs(p.y));
    float c = ell(p - vec2(0.05, 0.0), vec2(0.45, 0.1), 0.3);
    c = max(c, ell(a - vec2(-0.46, 0.07), vec2(0.07, 0.045), 0.3));
    c = max(c, ell(a - vec2(0.15, 0.12), vec2(0.09, 0.03), 0.35));
    return c;
  }
  float pulse = 1.0 + 0.14 * sin(ph * 3.0);
  return ell(q, vec2(0.2 * pulse), 0.35);
}
vec2 nrm(vec2 uv) { return texture2D(uNoise, uv).rg * 2.0 - 1.0; }
float sinh_(float x) { float e = exp(x); return 0.5 * (e - 1.0 / e); }
// 經緯度方框（度），邊緣 1.5 度內漸變
float box(vec2 g, vec4 b) {
  return smoothstep(b.x - 1.5, b.x + 1.5, g.x) * smoothstep(b.y + 1.5, b.y - 1.5, g.x)
       * smoothstep(b.z - 1.5, b.z + 1.5, g.y) * smoothstep(b.w + 1.5, b.w - 1.5, g.y);
}
// 內陸海（黑海 + 亞速海、裏海）：沒有大洋湧浪，浪小、浪花少、波光細碎
float inland(vec2 g) {
  return max(box(g, vec4(27.0, 42.0, 40.5, 47.5)), box(g, vec4(46.5, 55.0, 36.5, 47.3)));
}

void main() {
  vec4 m = texture2D(uMask, vCss / uRes);
  float water = smoothstep(0.16, 0.3, m.b - m.r);
  if (water < 0.004) { gl_FragColor = vec4(0.0); return; }
  float shallow = smoothstep(0.55, 0.86, m.g);

  // 日照：0 夜 ~ 1 晝（晨昏帶 ±6°，和 app.js 的 nightBrightAt 一樣）
  float lat = atan(sinh_(3.14159265 * (1.0 - 2.0 * vGeo.y)));
  float sinAlt = sin(lat) * uDecl.x + cos(lat) * uDecl.y * cos(vGeo.x);
  float day = clamp((sinAlt + 0.1045) / 0.209, 0.0, 1.0);
  float night = 1.0 - day;
  float lonD = mod(degrees(vGeo.x + uSunLon) + 180.0, 360.0) - 180.0;
  float calm = inland(vec2(lonD, degrees(lat)));

  // 海浪法線：兩個尺度依縮放淡入淡出，各自兩層往不同方向捲動。
  // 第二層用整數矩陣旋轉放大（貼圖照樣無縫循環），兩層的紋路才不會每一格都一模一樣
  const mat2 ROT = mat2(2.0, 1.0, -1.0, 2.0);
  vec2 nA = nrm(vUv.xy + uT1.xy) + nrm(ROT * vUv.xy + uT1.zw) * 0.6;
  vec2 nB = nrm(vUv.zw + uT1.xy) + nrm(ROT * vUv.zw + uT1.zw) * 0.6;
  vec2 n = mix(nA, nB, uLodF);
  // 大範圍的明暗斑塊（四格一循環、慢慢飄）：讓波光一區多一區少，看不出貼圖重複
  float patch = mix(nrm(vUv.xy * uPatch.x + uT3.zw).x, nrm(vUv.zw * uPatch.y + uT3.zw).x, uLodF);
  patch = smoothstep(-0.35, 0.5, patch);
  n *= (0.65 + 0.35 * patch) * (1.0 - 0.6 * calm);

  // 水下生物（影子會跟著水面折射輕輕扭動）
  float cov = 0.0;
  vec3 glow = vec3(0.0);
  for (int i = 0; i < MAXC; i++) {
    if (i >= uNC) break;
    vec4 a = uC0[i];
    vec4 b = uC1[i];
    vec2 d = vCss - a.xy;
    if (dot(d, d) > b.x * b.x * 0.64) continue;
    d += n * b.x * 0.025;
    vec2 q = vec2(dot(d, a.zw), dot(d, vec2(-a.w, a.z))) / b.x;
    float k = creature(q, b.y, b.w) * abs(b.z);
    if (b.y > 4.5) {
      // 水母：白天半透明的淡粉白，夜晚發出藍綠色螢光
      glow += k * (vec3(0.5, 0.45, 0.6) * 0.22 * day + vec3(0.25, 0.85, 1.0) * 0.75 * night);
      k *= 0.25;
    }
    cov = max(cov, k);
  }

  // 船 / 海洋生物的水波
  float wake = 0.0;
  for (int i = 0; i < MAXW; i++) {
    if (i >= uNW) break;
    vec4 a = uW0[i];
    vec4 b = uW1[i];
    float s = b.x;
    vec2 d = vCss - a.xy;
    d.y *= 1.8; // 畫面是斜俯視的卡通角度，水波壓扁一點和船的白色水波橢圓一致
    float R = s * (1.4 + 3.2 * b.y);
    if (dot(d, d) > R * R) continue;
    float along = -dot(d, a.zw), across = dot(d, vec2(-a.w, a.z));
    float w = 0.0;
    if (b.y > 0.02) {
      float L = s * 4.0, ap = max(along, 0.0), u = along / L;
      if (along > -s * 0.4 && u < 1.0) {
        float fu = (1.0 - u) * (1.0 - u);
        float w0 = s * 0.2 + ap * 0.36; // Kelvin 尾流約 19.5°
        float arm = abs(abs(across) - w0), aw = s * 0.06 + ap * 0.05;
        float armI = exp(-arm * arm / (aw * aw)) * fu * (0.75 + 0.25 * sin(ap / s * 9.0 - uTime * 5.0));
        float inside = smoothstep(w0, w0 * 0.55, abs(across)) * smoothstep(0.0, s * 0.4, along);
        float trans = pow(max(0.0, sin(ap / (s * 0.24) * 6.2832 - uTime * 6.0)), 3.0) * inside * fu * 0.45;
        float cw = s * 0.12 + ap * 0.07;
        float core = exp(-across * across / (cw * cw)) * exp(-ap / (L * 0.28)) * (0.65 + 0.35 * n.x);
        w += (armI + trans + core * 1.1) * b.y;
      }
    }
    float r = length(d);
    float ring = pow(max(0.0, sin(r / (s * 0.17) * 6.2832 - uTime * 2.6 + b.w)), 4.0);
    ring *= smoothstep(s * 1.35, s * 0.5, r) * smoothstep(s * 0.25, s * 0.45, r);
    w += ring * (1.0 - b.y * 0.6) * 0.7;
    wake += w * b.z;
  }
  wake = min(wake, 1.4);

  // 光影。波光集中在太陽正下方一帶（太陽越高越多），其它地方只剩零星幾點；
  // 放大後（uZoom → 1）再變小、變少、變淡，海浪明暗也收斂，不然近看會滿片亮斑
  vec3 N = normalize(vec3(n * mix(0.3, 0.22, uZoom), 1.0));
  vec3 Hh = normalize(vec3(-0.2, -0.26, 1.0));
  float nh = max(dot(N, Hh), 0.0);
  float spec = pow(nh, mix(700.0, 1500.0, uZoom));
  float glit = smoothstep(mix(0.978, 0.99, uZoom), 1.0, texture2D(uNoise, vUv.zw * 3.0 + uT3.xy).a) * pow(nh, 80.0);
  float hi = smoothstep(0.0, 0.55, sinAlt);
  vec3 sunC = mix(vec3(1.0, 0.58, 0.28), vec3(1.0, 0.97, 0.88), smoothstep(0.02, 0.3, sinAlt));
  vec3 moonC = vec3(0.6, 0.72, 1.0);
  float sunSpot = 0.06 + 0.5 * pow(smoothstep(0.35, 0.95, sinAlt), 2.0);
  vec3 glint = (sunC * day * sunSpot * (spec + glit * 0.7)
             + moonC * night * 0.08 * (pow(nh, 900.0) + glit * 0.4)) * patch * patch * mix(1.0, 0.45, uZoom) * (1.0 - 0.7 * calm);

  float slope = dot(n, vec2(-0.55, -0.6));
  float wv = slope * mix(0.015, 0.03, day) * mix(1.0, 0.5, uZoom) * (1.0 - 0.4 * calm);
  vec3 add = max(wv, 0.0) * mix(vec3(0.35, 0.5, 0.8), vec3(0.9, 1.0, 1.0), day);
  float dark = max(-wv, 0.0);

  // 淺海焦散：陽光穿過水面在海底形成的光紋，被生物擋住的地方沒有
  if (shallow > 0.02 && day > 0.02) {
    float cA = min(texture2D(uNoise, vUv.xy * 2.0 + uT2.xy).b, texture2D(uNoise, vUv.xy * 2.0 + uT2.zw).b);
    float cB = min(texture2D(uNoise, vUv.zw * 2.0 + uT2.xy).b, texture2D(uNoise, vUv.zw * 2.0 + uT2.zw).b);
    float c = mix(cA, cB, uLodF);
    add += sunC * c * c * 0.6 * mix(1.0, 0.3, uZoom) * shallow * day * (1.0 - cov);
  }

  // 岸邊的浪：一道道和海岸線平行的白浪往岸上推，到岸邊拍成一條白邊再退回去。
  // 浪的形狀沿著「離岸遠近」的等高線走，再用平滑雜訊打斷，不會整圈一模一樣
  float cd = texture2D(uCoast, vCss / uRes).r;
  float near = smoothstep(0.95, 0.6, cd);
  if (calm > 0.0) near *= 1.0 - 0.75 * calm;
  if (near > 0.0) {
    float brk = nrm(vUv.xy + vec2(0.5, 0.25) + uT3.zw).y;
    float ph = uShore + brk * 0.3;
    float f = fract(cd * 6.5 + ph);
    float crest = smoothstep(0.58, 0.64, f) * (1.0 - smoothstep(0.64, 0.9, f));
    crest *= smoothstep(-0.5, 0.3, brk + n.x * 0.25) * near * near;
    // 拍岸：每一道浪打到岸邊時，岸邊那條白邊跟著亮起來
    float fs = fract(0.56 * 6.5 + ph);
    float wash = smoothstep(0.72, 0.54, cd) * (0.25 + 0.75 * smoothstep(0.45, 0.64, fs) * (1.0 - smoothstep(0.64, 0.95, fs)));
    float foam = max(crest, wash * (1.0 - 0.6 * calm)) * mix(0.55, 1.0, uZoom) * (1.0 - cov * 0.5);
    add += mix(vec3(0.3, 0.45, 0.62), vec3(0.95, 1.0, 1.0), day) * foam * 0.85;
  }

  // 生物的影子：淺海看得比較清楚，夜晚很淡
  float sh = cov * (0.2 + 0.24 * shallow) * (0.35 + 0.65 * day);
  add = add * (1.0 - cov * 0.5) + glint + glow;
  add += mix(vec3(0.3, 0.95, 1.0) * 0.75, vec3(0.92, 0.98, 1.0) * 0.55, day) * wake;
  float al = 1.0 - (1.0 - dark) * (1.0 - sh);
  gl_FragColor = vec4((vec3(0.0, 0.05, 0.1) * al + add) * water, al * water);
}`;

  /* ---------- 離岸遠近（地圖移動時才算一次）：陸海遮罩 → 1/4 解析度的 0/1 → 兩次可分離高斯模糊 ---------- */
  const VS_Q = `attribute vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;
  const FS_PREP = `precision mediump float;
uniform sampler2D uSrc;
uniform vec2 uSize;
void main() {
  vec4 m = texture2D(uSrc, gl_FragCoord.xy / uSize);
  float w = smoothstep(0.16, 0.3, m.b - m.r);
  gl_FragColor = vec4(w, w, w, 1.0);
}`;
  const FS_BLUR = `precision mediump float;
uniform sampler2D uSrc;
uniform vec2 uSize;
uniform vec2 uDir;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  float s = texture2D(uSrc, uv).r * 0.2042;
  s += (texture2D(uSrc, uv + uDir * 2.0).r + texture2D(uSrc, uv - uDir * 2.0).r) * 0.1802;
  s += (texture2D(uSrc, uv + uDir * 4.0).r + texture2D(uSrc, uv - uDir * 4.0).r) * 0.1238;
  s += (texture2D(uSrc, uv + uDir * 6.0).r + texture2D(uSrc, uv - uDir * 6.0).r) * 0.0663;
  s += (texture2D(uSrc, uv + uDir * 8.0).r + texture2D(uSrc, uv - uDir * 8.0).r) * 0.0276;
  gl_FragColor = vec4(s, s, s, 1.0);
}`;

  /* ---------- 海浪 / 焦散 / 閃光雜訊貼圖（可無縫循環） ---------- */
  function rng(seed) {
    let s = seed >>> 0;
    return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  }
  function makeNoise() {
    const N = NT,
      r = rng(20251125),
      PI2 = Math.PI * 2;
    // 整數波數的正弦波疊加：天生可以無縫循環，而且像海浪的干涉紋
    const waves = [];
    for (let i = 0; i < 14; i++) {
      const ang = (r() - 0.5) * 2.4 + 0.4,
        mag = 3 + r() * 10;
      let kx = Math.round(Math.cos(ang) * mag),
        ky = Math.round(Math.sin(ang) * mag);
      if (!kx && !ky) kx = 3;
      waves.push([kx, ky, 1 / Math.pow(Math.hypot(kx, ky), 1.15), r() * PI2]);
    }
    const n = N * N,
      gx = new Float32Array(n),
      gy = new Float32Array(n),
      h = new Float32Array(n);
    for (const [kx, ky, a, p] of waves) {
      const fx = (PI2 * kx) / N,
        fy = (PI2 * ky) / N;
      for (let y = 0, i = 0; y < N; y++) {
        for (let x = 0; x < N; x++, i++) {
          const ph = fx * x + fy * y + p,
            c = Math.cos(ph) * a;
          h[i] += Math.sin(ph) * a;
          gx[i] += c * kx;
          gy[i] += c * ky;
        }
      }
    }
    let sg = 0,
      mh = 0;
    for (let i = 0; i < n; i++) {
      sg += gx[i] * gx[i] + gy[i] * gy[i];
      mh = Math.max(mh, Math.abs(h[i]));
    }
    const gs = 1 / (2.2 * Math.sqrt(sg / n / 2));
    // 焦散：被海浪扭曲的 Voronoi，取「離格子邊界多近」→ 細細的亮網
    const G = 8,
      CS = N / G,
      pts = new Float32Array(G * G * 2);
    for (let i = 0; i < G * G; i++) {
      pts[i * 2] = 0.15 + r() * 0.7;
      pts[i * 2 + 1] = 0.15 + r() * 0.7;
    }
    const out = new Uint8Array(n * 4);
    for (let y = 0, i = 0; y < N; y++) {
      for (let x = 0; x < N; x++, i++) {
        const px = x + (h[i] / mh) * 7,
          py = y + (h[(i + 37 * N + 11) % n] / mh) * 7;
        const cx = Math.floor(px / CS),
          cy = Math.floor(py / CS);
        let f1 = 1e9,
          f2 = 1e9;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const gxi = cx + ox,
              gyi = cy + oy,
              k = ((((gyi % G) + G) % G) * G + (((gxi % G) + G) % G)) * 2;
            const dx = (gxi + pts[k]) * CS - px,
              dy = (gyi + pts[k + 1]) * CS - py,
              d = Math.sqrt(dx * dx + dy * dy);
            if (d < f1) {
              f2 = f1;
              f1 = d;
            } else if (d < f2) f2 = d;
          }
        }
        const e = Math.min(1, (f2 - f1) / 9);
        const o = i * 4;
        out[o] = Math.max(0, Math.min(255, 128 + gx[i] * gs * 127));
        out[o + 1] = Math.max(0, Math.min(255, 128 + gy[i] * gs * 127));
        out[o + 2] = Math.pow(1 - e, 2.2) * 255;
        out[o + 3] = r() * 255;
      }
    }
    return out;
  }

  /* ---------- WebGL ---------- */
  function shader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  }
  function setupGL() {
    gl = cv.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
    });
    if (!gl) throw new Error('no webgl');
    const link = (vs, fs) => {
      const p = gl.createProgram();
      gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
      return p;
    };
    prog = link(VS, FS);
    progPrep = link(VS_Q, FS_PREP);
    progBlur = link(VS_Q, FS_BLUR);
    locQ = {
      prep: { src: gl.getUniformLocation(progPrep, 'uSrc'), size: gl.getUniformLocation(progPrep, 'uSize') },
      blur: {
        src: gl.getUniformLocation(progBlur, 'uSrc'),
        size: gl.getUniformLocation(progBlur, 'uSize'),
        dir: gl.getUniformLocation(progBlur, 'uDir'),
      },
    };
    gl.useProgram(prog);
    buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    loc = {};
    for (const k of ['uNoise', 'uMask', 'uCoast', 'uRes', 'uLodA', 'uLodB', 'uGeo', 'uT1', 'uT2', 'uT3', 'uPatch', 'uLodF', 'uZoom', 'uTime', 'uShore', 'uDecl', 'uSunLon', 'uC0', 'uC1', 'uNC', 'uW0', 'uW1', 'uNW'])
      loc[k] = gl.getUniformLocation(prog, k);
    gl.uniform1i(loc.uNoise, 0);
    gl.uniform1i(loc.uMask, 1);
    gl.uniform1i(loc.uCoast, 2);
    texN = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texN);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, NT, NT, 0, gl.RGBA, gl.UNSIGNED_BYTE, makeNoise());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    texM = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texM);
    for (const [p, v] of [
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
    ])
      gl.texParameteri(gl.TEXTURE_2D, p, v);
    texC = [];
    fbC = [];
    for (let i = 0; i < 2; i++) {
      const tx = gl.createTexture();
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, tx);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
      for (const [p, v] of [
        [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
        [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
        [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
        [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      ])
        gl.texParameteri(gl.TEXTURE_2D, p, v);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tx, 0);
      texC.push(tx);
      fbC.push(fb);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    coastW = coastH = 0;
    gl.clearColor(0, 0, 0, 0);
    maskDirty = hasMask;
    blank = false;
    ready = true;
  }
  function fail(e) {
    ready = false;
    dead = true;
    if (cv) cv.style.display = 'none';
    if (window.console) console.warn('海面特效停用：', e && e.message ? e.message : e);
  }

  /* ---------- 陸海遮罩 ---------- */
  // 和著色器同一個判斷：海水的藍色明顯大於紅色（陸地、雪地、沙灘、白色浪花都不會）
  function cpuWater(x, y) {
    if (!cpu) return 0;
    const cx = Math.floor(x * CPU_S),
      cy = Math.floor(y * CPU_S);
    if (cx < 0 || cy < 0 || cx >= cpuW || cy >= cpuH) return 0;
    const o = (cy * cpuW + cx) * 4,
      d = cpu[o + 2] - cpu[o];
    return d > 62 ? 1 + (cpu[o + 1] > 175 ? 1 : 0) : 0; // 0 陸地 / 1 海 / 2 淺海
  }
  function readCpuMask(now) {
    if (!hasMask || !cpuDirty || now - cpuAt < 450) return;
    cpuAt = now;
    cpuDirty = false;
    const w = Math.max(1, Math.ceil(W * CPU_S)),
      h = Math.max(1, Math.ceil(H * CPU_S));
    if (!cpuCv) {
      cpuCv = document.createElement('canvas');
      cpuCtx = cpuCv.getContext('2d', { willReadFrequently: true });
    }
    if (cpuCv.width !== w || cpuCv.height !== h) {
      cpuCv.width = w;
      cpuCv.height = h;
    }
    cpuCtx.drawImage(snap, 0, 0, w, h);
    cpu = cpuCtx.getImageData(0, 0, w, h).data;
    cpuW = w;
    cpuH = h;
    let n = 0;
    for (let o = 0; o < cpu.length; o += 4) if (cpu[o + 2] - cpu[o] > 62) n++;
    waterFrac = n / (w * h);
  }

  /* ---------- 水下生物 ---------- */
  // size：身長（CSS px）；spd：游速（px/s）；deep：只出現在深海；w：出現權重 [白天, 夜晚]
  const KINDS = [
    { type: 0, size: 13, spd: 16, w: [3, 1.5] }, // 魚
    { type: 1, size: 40, spd: 11, w: [3, 1.5] }, // 魚群
    { type: 2, size: 32, spd: 9, w: [1.4, 1] }, // 魟魚
    { type: 3, size: 21, spd: 6, w: [1.4, 0.8], shallow: true }, // 海龜
    { type: 4, size: 78, spd: 8, w: [0.7, 0.6], deep: true }, // 鯨魚
    { type: 5, size: 13, spd: 2.5, w: [0.6, 3] }, // 水母（夜晚發光）
  ];
  function pickKind(depth, isNight) {
    let sum = 0;
    const ok = KINDS.filter((k) => !(k.deep && depth === 2) && !(k.shallow && depth !== 2));
    for (const k of ok) sum += k.w[isNight ? 1 : 0];
    let x = Math.random() * sum;
    for (const k of ok) if ((x -= k.w[isNight ? 1 : 0]) <= 0) return k;
    return ok[0];
  }
  const screenOf = (c, v) => {
    let x = v.x + c.u * v.ww;
    if (x < -v.ww * 0.5) x += v.ww;
    return [x, v.y + c.v * v.ww];
  };
  function spawn(v, zf) {
    for (let tries = 0; tries < 5; tries++) {
      const x = Math.random() * W,
        y = Math.random() * H,
        depth = cpuWater(x, y);
      if (!depth) continue;
      const u0 = ((((x - v.x) / v.ww) % 1) + 1) % 1,
        v0 = (y - v.y) / v.ww;
      const lon = u0 * 360 - 180,
        lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * v0))) * 180) / Math.PI;
      const isNight = bright ? bright(lon, lat) < 0.35 : false;
      const k = pickKind(depth, isNight),
        R = k.size * zf * 0.9;
      // 周圍都要是海，才不會一出生就撞上海岸
      let ok = true;
      for (let a = 0; a < 6 && ok; a++) ok = !!cpuWater(x + Math.cos(a) * R, y + Math.sin(a) * R * 0.8);
      if (!ok) continue;
      creatures.push({
        k,
        u: u0,
        v: v0,
        ang: Math.random() * Math.PI * 2,
        ph: Math.random() * 100,
        age: 0,
        life: 18 + Math.random() * 30,
        fade: 0,
        dying: false,
        depth: 0.55 + Math.random() * 0.45,
      });
      return;
    }
  }
  function stepCreatures(dt, v, k, now) {
    const zf = Math.max(1, Math.min(2, Math.pow(k, 0.22)));
    readCpuMask(now);
    if (dt > 0) {
      steerAcc += dt;
      const steer = steerAcc > 0.3;
      if (steer) steerAcc = 0;
      for (let i = creatures.length - 1; i >= 0; i--) {
        const c = creatures[i];
        c.age += dt;
        c.ph += dt * (c.k.type === 4 ? 1 : 1.6);
        if (c.age > c.life) c.dying = true;
        c.fade = Math.max(0, Math.min(1, c.fade + (c.dying ? -dt / 2.5 : dt / 3)));
        c.ang += Math.sin(c.age * 0.33 + c.ph * 0.01) * 0.22 * dt;
        const sp = c.k.spd * zf * dt;
        c.u = (((c.u + (Math.cos(c.ang) * sp) / v.ww) % 1) + 1) % 1;
        c.v += (Math.sin(c.ang) * sp) / v.ww;
        const [x, y] = screenOf(c, v),
          R = c.k.size * zf;
        if (x < -R * 3 || x > W + R * 3 || y < -R * 3 || y > H + R * 3 || (c.dying && c.fade <= 0)) {
          creatures.splice(i, 1);
          continue;
        }
        if (steer && cpu && !c.dying) {
          if (!cpuWater(x, y)) c.dying = true;
          else {
            const ahead = (a) => cpuWater(x + Math.cos(a) * R * 0.9, y + Math.sin(a) * R * 0.9);
            if (!ahead(c.ang)) {
              const l = c.ang - 1.9,
                r = c.ang + 1.9;
              c.ang = ahead(l) ? l : ahead(r) ? r : c.ang + Math.PI;
            }
          }
        }
      }
      spawnAcc += dt;
      if (spawnAcc > 0.6 && cpu) {
        spawnAcc = 0;
        const want = Math.min(MAXC, Math.round(2 + waterFrac * 11));
        if (creatures.length < want) spawn(v, zf);
      }
    }
    let n = 0;
    for (const c of creatures) {
      if (n >= MAXC) break;
      const [x, y] = screenOf(c, v),
        o = n * 4;
      C0[o] = x;
      C0[o + 1] = y;
      C0[o + 2] = Math.cos(c.ang);
      C0[o + 3] = Math.sin(c.ang);
      C1[o] = c.k.size * zf;
      C1[o + 1] = c.k.type;
      C1[o + 2] = c.fade * c.depth;
      C1[o + 3] = c.ph;
      n++;
    }
    return n;
  }

  /* ---------- 對外介面 ---------- */
  // 遮罩更新後重算離岸遠近（結果在 texC[0]，主著色器從 TEXTURE2 讀）
  function buildCoast() {
    const w = Math.max(1, Math.ceil(snap.width / 2)),
      h = Math.max(1, Math.ceil(snap.height / 2));
    if (w !== coastW || h !== coastH) {
      gl.activeTexture(gl.TEXTURE2);
      for (const tx of texC) {
        gl.bindTexture(gl.TEXTURE_2D, tx);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      coastW = w;
      coastH = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(progPrep);
    gl.uniform1i(locQ.prep.src, 1);
    gl.uniform2f(locQ.prep.size, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbC[0]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.useProgram(progBlur);
    gl.uniform1i(locQ.blur.src, 2);
    gl.uniform2f(locQ.blur.size, w, h);
    gl.activeTexture(gl.TEXTURE2);
    for (let it = 0; it < 2; it++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbC[1]);
      gl.bindTexture(gl.TEXTURE_2D, texC[0]);
      gl.uniform2f(locQ.blur.dir, 1 / w, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbC[0]);
      gl.bindTexture(gl.TEXTURE_2D, texC[1]);
      gl.uniform2f(locQ.blur.dir, 0, 1 / h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, texC[0]);
    gl.useProgram(prog);
  }
  function init(canvas, o) {
    cv = canvas;
    bright = (o && o.bright) || null;
    const onReady = (o && o.onReady) || (() => {});
    if (!cv) return;
    cv.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      ready = false;
    });
    cv.addEventListener('webglcontextrestored', () => {
      try {
        setupGL();
        onReady();
      } catch (e) {
        fail(e);
      }
    });
    // 貼圖大約要算幾十毫秒：等第一批地形畫出來之後再做，不拖慢開場
    setTimeout(() => {
      try {
        setupGL();
        onReady();
      } catch (e) {
        fail(e);
      }
    }, 700);
  }
  function resize(w, h, dpr) {
    W = w;
    H = h;
    RS = dpr >= 1.5 ? 0.8 : 0.65;
    if (cv) {
      const cw = Math.max(1, Math.round(w * RS)),
        ch = Math.max(1, Math.round(h * RS));
      if (cv.width !== cw || cv.height !== ch) {
        cv.width = cw;
        cv.height = ch;
        blank = false;
      }
    }
    if (!snap) {
      snap = document.createElement('canvas');
      sctx = snap.getContext('2d', { alpha: false });
    }
    const sw = Math.max(1, Math.round(w * MASK_S)),
      sh = Math.max(1, Math.round(h * MASK_S));
    if (snap.width !== sw || snap.height !== sh) {
      snap.width = sw;
      snap.height = sh;
    }
  }
  // 地形畫好、還沒蓋夜色之前呼叫
  function snapshot(src) {
    if (dead || !snap || !W) return;
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(src, 0, 0, snap.width, snap.height);
    hasMask = maskDirty = cpuDirty = true;
  }
  const fr = (x) => x - Math.floor(x);
  // p：{ t: d3 zoom transform, S0, time（秒，動畫關閉時不前進）, dt（這一幀要推進的秒數）, sunLon（度）, decl（弳）,
  //      wakes: [{ x, y, dx, dy, size, speed 0~1, amp 0~1, ph }] }
  function render(p) {
    if (!ready || dead || !W || !hasMask || gl.isContextLost()) return;
    const t = p.t,
      ww = p.S0 * t.k,
      v = { x: t.x, y: t.y, ww },
      now = performance.now();
    const nc = stepCreatures(p.dt || 0, v, t.k, now);
    const wakes = p.wakes || [];
    // 畫面上幾乎沒有海（放大到內陸），也沒有水波：清空一次就不再畫
    if (cpu && !cpuDirty && waterFrac < 0.002 && !wakes.length && !nc) {
      if (!blank) {
        gl.viewport(0, 0, cv.width, cv.height);
        gl.clear(gl.COLOR_BUFFER_BIT);
        blank = true;
      }
      return;
    }
    blank = false;
    if (maskDirty) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texM);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, snap);
      maskDirty = false;
      buildCoast();
    }
    gl.viewport(0, 0, cv.width, cv.height);
    gl.uniform2f(loc.uRes, W, H);
    // 海浪貼圖的尺度：每放大一倍就換到下一層，中間淡入淡出；位移只留小數（貼圖會循環），避免浮點誤差
    const s = Math.log2(Math.max(1, ww / TILE_PX)),
      lv = Math.floor(s),
      PA = Math.pow(2, lv),
      sA = PA / ww,
      sB = sA * 2;
    gl.uniform4f(loc.uLodA, sA, fr(-t.x * sA), fr(-t.y * sA), 0);
    gl.uniform4f(loc.uLodB, sB, fr(-t.x * sB), fr(-t.y * sB), 0);
    gl.uniform1f(loc.uLodF, s - lv);
    // 放大約 1.4 倍開始收斂，放大 8 倍以上降到最少
    gl.uniform1f(loc.uZoom, Math.max(0, Math.min(1, (Math.log2(t.k) - 0.5) / 2.5)));
    gl.uniform2f(loc.uPatch, Math.max(0.25, 1 / PA), Math.max(0.25, 1 / (PA * 2)));
    gl.uniform4f(loc.uGeo, (-t.x / ww) * 2 * Math.PI - Math.PI - (p.sunLon * Math.PI) / 180, (2 * Math.PI) / ww, -t.y / ww, 1 / ww);
    gl.uniform2f(loc.uDecl, Math.sin(p.decl), Math.cos(p.decl));
    gl.uniform1f(loc.uSunLon, (p.sunLon * Math.PI) / 180);
    const T = p.time;
    gl.uniform4f(loc.uT1, fr(T * 0.011), fr(T * 0.004), fr(-T * 0.006), fr(T * 0.013));
    gl.uniform4f(loc.uT2, fr(T * 0.021), fr(T * 0.009), fr(-T * 0.012), fr(-T * 0.017));
    gl.uniform4f(loc.uT3, fr(T * 0.03), fr(-T * 0.02), fr(T * 0.0021), fr(-T * 0.0013));
    gl.uniform1f(loc.uTime, T % (200 * Math.PI)); // 水波的頻率（2.6 / 5 / 6）在 200π 秒剛好都轉完整圈，繞回去不會跳
    gl.uniform1f(loc.uShore, fr(T * 0.26)); // 岸邊浪約 3.8 秒一道
    gl.uniform4fv(loc.uC0, C0);
    gl.uniform4fv(loc.uC1, C1);
    gl.uniform1i(loc.uNC, nc);
    let nw = 0;
    for (const w of wakes) {
      if (nw >= MAXW) break;
      if (w.x < -w.size * 5 || w.x > W + w.size * 5 || w.y < -w.size * 3 || w.y > H + w.size * 3) continue;
      const o = nw * 4;
      W0[o] = w.x;
      W0[o + 1] = w.y;
      W0[o + 2] = w.dx;
      W0[o + 3] = w.dy;
      W1[o] = w.size;
      W1[o + 1] = w.speed;
      W1[o + 2] = w.amp;
      W1[o + 3] = w.ph || 0;
      nw++;
    }
    gl.uniform4fv(loc.uW0, W0);
    gl.uniform4fv(loc.uW1, W1);
    gl.uniform1i(loc.uNW, nw);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texN);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texM);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, texC[0]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  window.Sea = { init, resize, snapshot, render, ready: () => ready && !dead };
})();
