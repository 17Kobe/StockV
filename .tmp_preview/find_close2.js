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

const targets = ['critters/bagan.svg', 'critters/marina-bay-sands.svg'];
for (const src of targets) {
  const t = CRITTERS.find(d => d.src === src);
  if (!t) { console.log(src, '找不到'); continue; }
  console.log(`\n=== ${src} (lon ${t.lon}, lat ${t.lat}) 附近的其它項目 ===`);
  CRITTERS.filter(d => d !== t)
    .map(d => ({ d, dist: Math.hypot(d.lon - t.lon, d.lat - t.lat) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 6)
    .forEach(({ d, dist }) => console.log(`  ${dist.toFixed(2)}度  ${d.src}  landmark=${!!d.landmark}`));
}
