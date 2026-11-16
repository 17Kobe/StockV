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

function nearest(lon, lat, excludeSrc) {
  return CRITTERS
    .filter(d => d.src !== excludeSrc)
    .map(d => ({ d, dist: Math.hypot(d.lon - lon, d.lat - lat) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 4);
}
console.log('=== 新長城座標 112, 42 ===');
nearest(112, 42, 'critters/great-wall.svg').forEach(({d,dist}) => console.log(dist.toFixed(2), d.src));

console.log('\n=== 新帆船飯店座標 52.5, 24.2 ===');
nearest(52.5, 24.2, 'critters/burj-al-arab.svg').forEach(({d,dist}) => console.log(dist.toFixed(2), d.src));

console.log('\n=== 新黑船座標 146, 30 ===');
nearest(146, 30, 'critters/black-ship.svg').forEach(({d,dist}) => console.log(dist.toFixed(2), d.src));
