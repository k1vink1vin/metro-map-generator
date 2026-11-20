# Gemini 建議的對照實驗

基準為 `57b8f827159046c57af2bf8b11d8ff9ce06988e7` 的原版 `TPE_Metro.xlsm` 與同一個產圖流程。試算用 Node.js 24.22.1 與 Chromium。正式驗收輸出放在成果包根目錄。

- `moscow-radius-comparison.json` 記錄四個雙環半徑比的站距、顯著方位反轉及繪製路線的自交。
- `moscow-083-print-audit.json` 記錄 0.83 的四種站牌印刷稽核，其中莫斯科站牌版的觀潮廣場（V22）發生站名與站牌重疊。
- `radial-experiments.patch` 是隔離測試使用的演算法改動。

在基準 commit 的暫存 checkout 中重現雙環試算。先以 `npm install` 安裝依賴，再將本目錄的 patch 套到 checkout，將本目錄 `scripts/` 的兩個腳本複製至 checkout 的 `scripts/`。

```sh
git apply /path/to/experiments/radial-experiments.patch
cp /path/to/experiments/scripts/*.ts scripts/
for ratio in 0.60 0.80 0.82 0.83
do
  TEST_RADIUS_RATIO="$ratio" node --import tsx scripts/try-ring.ts
done
TEST_RADIUS_RATIO=0.83 node --import tsx scripts/try-ring-suite.ts moscow
npm run qa:print -- moscow
```

同心圓 0.65 次方壓縮套在雙北環線最外側站點半徑以外，並讓分界點兩側的斜率接近。結果用了更小的印刷幅面，但仍有 151 處直角接合和 48 圖面單位的額外徑向路徑。南北方位正確率從 98.63% 降至 98.10%。四種站牌均通過印刷碰撞檢查，但每張圖多用 16 至 25 個站點引線。原圖保留較高方位正確率與較少引線。

```sh
TEST_OUTER_RADIUS=1 npm run qa:render -- concentric
TEST_OUTER_RADIUS=1 npm run qa:principles -- concentric
TEST_OUTER_RADIUS=1 npm run qa:layouts -- concentric
npm run qa:print -- concentric
```
