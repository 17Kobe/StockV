# 美洲圖示 2.5D 化：未完成清單（2026-11-25）

已完成並接上地圖（app.js 改 `iso:`、tips.js／index.html 版本已更新、icons.html 已重產）：
美國／加拿大地標、動物、人物共 49 項 + 白宮、聯準會地標圖示 + 美國／加拿大居民。

產生器在 `%TEMP%`：`gen_am1.py`（美國地標）、`gen_am2.py`（太空／動物／加拿大）、`gen_am3.py`（人物）、
`gen_folk3.py`（居民）、`wire_am.py`（接線，可重跑：只處理 lon < −25 且尚未 `iso:` 的項目）。

## 尚未畫（仍是舊圖、仍用 `s:`）

### 中南美洲地標
christ-redeemer、machu-picchu、chichen-itza、teotihuacan、nazca-lines、panama-canal、iguazu、angel-falls、
salar-de-uyuni、torres-del-paine、galapagos、great-blue-hole、moai、buenos-aires-obelisk、amazon-rainforest、cactus-mexico

### 中南美洲動物／船
- sloth、jaguar（wander，朝左）、piranha（swim，face R → 朝右畫）、sea-turtle（turtle，朝左）
- animals/toucan.svg、animals/axolotl.svg、animals/alpaca.svg（原地覆寫；genicons.py 的 ISO25 regex 要加 `animals/`）
- animals/penguin.png → critters/penguin.svg（兩筆都要改路徑）
- amazon-boat（boat）

### 海上
- critters/whale-spout.png → critters/whale-spout.svg，alt critters/whale.png → critters/whale.svg（mode whale，朝左）
- galleon-manila、fleet-columbus、ship-victoria（boat face F）、titanic（bob→still）、rms-olympic（boat，需補 face）、
  bermuda、iceberg（bob→still）

### 非美洲但仍未統一的船
caravel-dias、flying-dutchman、yacht-vendee、fram-polar-ship

## 未驗證
圖示都看過預覽圖，但接線後的地圖實際畫面（含白宮／聯準會地標、美加居民）沒有在瀏覽器裡檢查過。
