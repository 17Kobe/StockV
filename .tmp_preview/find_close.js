const fs = require('fs');
const vm = require('vm');
const appSrc = fs.readFileSync('../site/app.js', 'utf8');
function extractBetween(src, startMarker, endMarker, fromIndex = 0) {
    const s = src.indexOf(startMarker, fromIndex);
    const e = src.indexOf(endMarker, s + startMarker.length);
    return src.slice(s, e + endMarker.length);
}
const critLit = extractBetween(appSrc, 'const CRITTERS = [', '\n    ]').replace('const CRITTERS = ', '');
const CRITTERS = vm.runInNewContext('(' + critLit + ')');

const landmarks = CRITTERS.filter(d => d.landmark);
console.log('landmark 總數:', landmarks.length);

const targets = {
  'critters/forbidden-city.svg': null,
  'critters/burj-al-arab.svg': null,
  'critters/black-ship.svg': null,
};
for (const d of CRITTERS) if (d.src in targets) targets[d.src] = d;
// black-ship 本身不是 landmark:true，但一樣用同樣的鄰近判斷邏輯檢查（它會跟其它 landmark 比較是否被壓住嗎？
// 其實 black-ship 不是 landmark，照程式碼只會被「一般 rects 碰撞」擋住，不會被其它地標的 lmPlaced 擋住。
// 但還是先列出它附近的東西，方便你判斷。

for (const [src, t] of Object.entries(targets)) {
  if (!t) { console.log(src, '找不到'); continue; }
  console.log(`\n=== ${src} (lon ${t.lon}, lat ${t.lat}, landmark=${!!t.landmark}) 附近的其它項目 ===`);
  const dists = CRITTERS
    .filter(d => d !== t)
    .map(d => ({ d, dist: Math.hypot((d.lon - t.lon), (d.lat - t.lat)) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 6);
  for (const { d, dist } of dists) {
    console.log(`  ${dist.toFixed(2)}度  ${d.src}  landmark=${!!d.landmark}  s=${d.s}`);
  }
}
