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
function nearest(lon, lat, n=5) {
  return CRITTERS.map(d => ({ d, dist: Math.hypot(d.lon - lon, d.lat - lat) }))
    .sort((a,b) => a.dist - b.dist).slice(0, n);
}
console.log('方尖碑 (-58.3816,-34.6037):');
nearest(-58.3816, -34.6037).forEach(({d,dist}) => console.log(' ', dist.toFixed(2), d.src, d.landmark?'[landmark]':''));
console.log('\n獅子岩 (80.76,7.96):');
nearest(80.76, 7.96).forEach(({d,dist}) => console.log(' ', dist.toFixed(2), d.src, d.landmark?'[landmark]':''));
console.log('\n峇里島 (115.19,-8.41):');
nearest(115.19, -8.41).forEach(({d,dist}) => console.log(' ', dist.toFixed(2), d.src, d.landmark?'[landmark]':''));
