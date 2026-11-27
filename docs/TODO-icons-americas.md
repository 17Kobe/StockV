# 地圖圖示 2.5D 化：進度（2026-11-27）

## 已完成
- 美洲全部完成（美國、加拿大、中南美洲的地標、動物、人物），白宮與聯準會地標改用 2.5D 圖示，美國、加拿大居民改成 2.5D。
- 海上全部完成：鯨魚（噴水 ↔ 舉尾輪流）、馬尼拉大帆船、哥倫布船隊、維多利亞號、鐵達尼號、奧林匹克號、百慕達三角、冰山。
- 非美洲的 4 艘船也完成：迪亞士帆船、幽靈船、旺代帆船、前進號。
- `docs/icons.html` 已重產（美洲這輪標成「第 7 輪」）。

產生器在 `%TEMP%`：`gen_am1.py`～`gen_am6.py`、`gen_folk3.py`（居民）、`wire_am.py`（把新圖接上 app.js／tips.js、調整版本號，可重跑）。

## 尚未統一（仍是 Fluent Emoji 點陣圖、用 `s:`）
不在原本的美洲清單裡，是之後檢查 app.js 時發現的 6 隻動物：
- animals/peacock.png（印度孔雀）
- animals/kangaroo.png（澳洲袋鼠）
- animals/orangutan.png（印尼紅毛猩猩）
- animals/elephant.png（泰國大象；非洲象已另有 critters/african-elephant.svg）
- animals/ox.png（西班牙公牛）
- animals/camel.png（沙烏地駱駝）
