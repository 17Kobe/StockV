// 獨立模擬腳本：複製 app.js 裡「全球縮小視角前 50 名額」的配額演算法，
// 用真實的 CRITTERS 清單資料跑一次，回報 k=1（全球視角）時的結果。
// 注意：這只模擬「名額配額」這一層，不含畫面碰撞（旗幟卡片擋到 / 超出畫面邊界）造成的額外隱藏，
// 所以是「budgetPool 最多會有幾個候選、配額機制本身最多放出幾個」的上限模擬，不是最終畫面實際數字。
const fs = require('fs');
const vm = require('vm');

const appSrc = fs.readFileSync('../site/app.js', 'utf8');
const tipsSrc = fs.readFileSync('../site/tips.js', 'utf8');

function extractBetween(src, startMarker, endMarker, fromIndex = 0) {
    const s = src.indexOf(startMarker, fromIndex);
    if (s < 0) throw new Error('start marker not found: ' + startMarker);
    const e = src.indexOf(endMarker, s + startMarker.length);
    if (e < 0) throw new Error('end marker not found: ' + endMarker);
    return src.slice(s, e + endMarker.length);
}

// 1) 取出 CRITTERS 陣列字面值
const critLit = extractBetween(appSrc, 'const CRITTERS = [', '\n    ]').replace('const CRITTERS = ', '');
const CRITTERS = vm.runInNewContext('(' + critLit + ')');

// 2) 取出 CRITTER_TIPS 物件字面值
const tipsLit = extractBetween(tipsSrc, 'window.CRITTER_TIPS = {', '\n}').replace('window.CRITTER_TIPS = ', '');
const CRITTER_TIPS = vm.runInNewContext('(' + tipsLit + ')');

// 3) 複製 app.js 裡的 hash()
const hash = (s) => {
    let h = 0;
    for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return h;
};

// 4) 複製 LOD 常數（跟 app.js 目前內容逐字一致）
const LOD_MIN = 80;
const LOD_MAX = 150;
const LOD_FULL_K = 6;
const k = 1; // 全球視角
const lodBudget = k >= LOD_FULL_K ? LOD_MAX : Math.round(LOD_MIN + (k - 1) * ((LOD_MAX - LOD_MIN) / (LOD_FULL_K - 1)));

const LOD_MEGA = new Set([
    'critters/eiffel-tower.svg', 'critters/statue-liberty.svg', 'critters/great-wall.svg',
    'critters/taj-mahal.svg', 'critters/pyramid.svg', 'critters/colosseum.svg',
    'critters/big-ben.svg', 'critters/opera-house.svg', 'critters/fuji.svg',
    'critters/christ-redeemer.svg', 'critters/machu-picchu.svg', 'critters/stonehenge.svg',
    'critters/leaning-tower.svg', 'critters/golden-gate.svg', 'critters/forbidden-city.svg',
    'critters/tokyo-tower.svg', 'critters/grand-canyon.svg', 'critters/chichen-itza.svg',
    'critters/angkor-wat.svg', 'critters/niagara-falls.svg', 'critters/titanic.svg',
    'critters/empire-state.svg', 'critters/acropolis.svg', 'critters/rushmore.svg',
]);
const LOD_FORCE = new Set([
    'critters/potala-palace.svg', 'critters/footballer-brazil.svg', 'critters/messi-football.svg',
    'critters/neuschwanstein.svg', 'critters/fleet-columbus.svg', 'critters/napoleon-bonaparte.svg',
    'critters/camel-caravan.svg', 'critters/hokkaido-king-crab.svg', 'critters/kremlin-moscow.svg',
    'critters/shanghai.svg', 'critters/santa-sleigh.svg', 'people/viking.svg',
    'critters/burj-khalifa.svg', 'critters/burj-al-arab.svg', 'critters/hongkong-skyline.svg',
    'critters/banff.svg', 'critters/halong-bay.svg', 'critters/temple-of-heaven.svg',
    'critters/ring-tailed-lemur.svg', 'critters/gyeongbokgung.svg', 'critters/treasure-ship.svg',
    'critters/petronas-towers.svg', 'critters/panama-canal.svg', 'critters/caravel-dias.svg',
    'critters/amazon-boat.svg', 'critters/yellowstone.svg', 'critters/sagrada-familia.svg',
    'critters/louvre.svg', 'critters/berlin-wall.svg', 'critters/bagan.svg',
    'critters/koala.svg', 'critters/great-barrier-reef.svg', 'critters/black-ship.svg',
    'critters/tatara-yami.svg', 'critters/siberian-train.svg', 'critters/samarkand.svg',
    'critters/nikola-tesla.svg', 'critters/harbin-ice-world.svg', 'critters/taipei101.svg',
    'critters/boracay.svg', 'critters/marina-bay-sands.svg',
    'critters/cactus-mexico.svg', 'critters/uluru.svg', 'critters/grand-palace.svg',
    'critters/pompeii.svg', 'critters/pamukkale.svg', 'critters/greek-house.svg',
    'critters/hanging-gardens.svg', 'critters/persepolis.svg', 'critters/kraken.svg',
]);
const LOD_DEMOTE = new Set([
    'critters/beaver.svg', 'critters/red-crowned-crane.svg', 'animals/penguin.png',
    'critters/rms-olympic.svg', 'critters/dhow.svg',
    'animals/deer.png', 'animals/dog.png', 'animals/dragon.png', 'animals/ewe.png',
    'animals/hedgehog.png', 'animals/badger.png', 'animals/rooster.png', 'animals/goat.png',
    'animals/cow.png', 'animals/rabbit.png', 'animals/turkey.png', 'animals/eagle.png',
    'animals/toucan.svg', 'animals/axolotl.svg', 'animals/alpaca.svg',
    'animals/horse.png', 'animals/monkey.png',
]);
const LOD_TIER2_CATS = new Set([
    '人物文化', '歷史', '歷史人物', '歷史人物／科學家', '體育／籃球', '體育／棒球',
    '體育／拳擊', '體育／賽車', '船艦', '科技', '神話傳說', '傳說生物',
]);
const lodTips = CRITTER_TIPS;
const critterPri = (d) => {
    if (LOD_DEMOTE.has(d.src)) return 0;
    if (LOD_FORCE.has(d.src)) return 5;
    if (LOD_MEGA.has(d.src)) return 4;
    if (d.landmark) return 3;
    const cat = lodTips[d.src] && lodTips[d.src][2];
    return cat && LOD_TIER2_CATS.has(cat) ? 2 : 1;
};

// 5) budgetPool：排除 folk（原住民小人用另一套邏輯，不計入）
const budgetPool = CRITTERS.filter((d) => d.mode !== 'folk');
console.log('CRITTERS 總數（不含原住民小人）：', budgetPool.length);
console.log('lodBudget (k=1，全球視角)：', lodBudget);

const byTier = { 5: [], 4: [], 3: [], 2: [], 1: [], 0: [] };
for (const d of budgetPool) byTier[critterPri(d)].push(d);
for (const tier of [5, 4, 3, 2, 1, 0]) byTier[tier].sort((a, b) => hash(a.src) - hash(b.src));

console.log('\n各層候選數：', Object.fromEntries([5, 4, 3, 2, 1, 0].map((t) => [t, byTier[t].length])));

const SHARE = { 5: 1, 4: 0.48, 3: 0.3, 2: 0.14, 1: 0.08, 0: 0 };
let remaining = lodBudget,
    carry = 0;
const shown = [];
const hiddenByTier = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0, 0: 0 };
for (const tier of [5, 4, 3, 2, 1, 0]) {
    const quota = tier === 5 ? byTier[5].length : Math.round(lodBudget * SHARE[tier]) + carry;
    const take = Math.min(quota, byTier[tier].length, remaining);
    shown.push(...byTier[tier].slice(0, take).map((d) => ({ tier, d })));
    hiddenByTier[tier] = byTier[tier].length - take;
    remaining -= take;
    carry = quota - take;
}

console.log('\n各層「名額內會顯示」數量：', Object.fromEntries([5, 4, 3, 2, 1, 0].map((t) => [t, shown.filter((x) => x.tier === t).length])));
console.log('各層「超出名額被收起來」數量：', hiddenByTier);
console.log('\n======== 全球視角（k=1）配額機制最多會顯示的清單，共', shown.length, '個 ========\n');
const TIER_NAME = { 5: '指定一定出現', 4: '世界超級地標', 3: '一般世界地標', 2: '人物/船艦/科技等', 1: '一般動物/其它', 0: '強制降級' };
for (const tier of [5, 4, 3, 2, 1, 0]) {
    const items = shown.filter((x) => x.tier === tier);
    if (!items.length) continue;
    console.log(`--- Tier ${tier}（${TIER_NAME[tier]}，${items.length} 個）---`);
    for (const { d } of items) {
        const tip = lodTips[d.src];
        console.log('  ' + d.src + (tip ? `  [${tip[1]}]` : ''));
    }
}
