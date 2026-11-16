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
  return CRITTERS.filter(d => d.src !== excludeSrc)
    .map(d => ({ d, dist: Math.hypot(d.lon - lon, d.lat - lat) }))
    .sort((a, b) => a.dist - b.dist).slice(0, 5);
}
console.log('候選新座標 lon105, lat4.3:');
nearest(105, 4.3, 'critters/marina-bay-sands.svg').forEach(({d,dist}) => console.log(' ', dist.toFixed(2), d.src));
