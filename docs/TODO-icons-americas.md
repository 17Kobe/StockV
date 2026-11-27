# 地圖圖示 2.5D 化：進度（2026-11-27）

## 已完成
- 地圖上所有圖示（app.js 的 CRITTERS）都已改成 2.5D 等角投影（從斜上方約 30° 往下看），沒有剩下的 Fluent Emoji 點陣圖。
- 美洲、海上、非美洲的 4 艘船：見 `gen_am1.py`～`gen_am6.py`。
- 視角修正（原本是正面平視或一點透視）：道頓堀固力果看板、普羅旺斯薰衣草、羅馬競技場、伊斯法罕伊瑪目清真寺、布達拉宮、芹壁聚落（`gen_fix30.py`；舊版備份在 `%TEMP%\bak30\`）。
- 最後 6 隻動物：印度孔雀、紅大袋鼠、紅毛猩猩、亞洲象（critters/asian-elephant.svg）、西班牙鬥牛（critters/spanish-bull.svg）、阿拉伯單峰駱駝（`gen_ani6.py`）。
- `docs/icons.html` 已重產。

產生器都在 `%TEMP%`（共用工具 `iso25d.py`、`gen_w_common.py`），清理暫存資料夾後可能會不見。

## 可能還要再看的
- 其他早期畫的圖示若也有「正面平視」的問題，可以用 `prev25.py` 做對照表找出來，再用 `gen_fix30.py` 的寫法重畫。
