# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 啟動與開發

**無 build step**。直接用 local HTTP server 開啟即可（ES module import 不支援 `file://`）：

```bash
python -m http.server 8080
# 或 VS Code Live Server、npx serve .
```

瀏覽器開啟 `http://localhost:8080`，所有變更立即生效（F5 重整）。

## 架構總覽

三層嚴格分離：

| 檔案 | 職責 |
|------|------|
| `js/engine.js` | **純計算層**：無 DOM、無副作用。`computeCapacity(state) → results` 為唯一主入口。 |
| `js/app.js` | **響應式綁定層**：`state → computeCapacity() → render()`，用 GSAP 補間動畫（feature-detect，離線可用）。 |
| `js/scene.js` | **Three.js 3D 動畫**：動態 import，失敗自動切換靜態 fallback，不影響主功能。 |
| `css/styles.css` | 全部樣式，CSS 變數集中於 `:root`，無預處理器。 |
| `index.html` | 宣告 importmap（`three` CDN），載入 Lucide / GSAP CDN，再以 `type="module"` 掛載 `app.js`。 |

## 計算邏輯關鍵規則

- **記憶體分配圖**（`renderMemoryAllocation`）**必須使用原始 `state`**（autoOptimize 前），才能顯示 VRAM 溢出的紅色區塊。`computeCapacity` 內以 `rawPerUserKV` 傳入，而非優化後的 `eff`。
- `autoOptimize` 只修改 `kvPrecision` / `contextTokens`，不改硬體規格（`vram`、`ram`）。
- 體積單位全為「友善 GB」（非嚴格 GiB），常數從 spec.md 的標竿範例反推：32B × Q4_K_M = 20 GB、64k context @ f16 = 2.15 GB/人。

## UI / 樣式規範

- **禁止 emoji**。圖示一律使用 **Lucide icon**：HTML 用 `<i data-lucide="icon-name" aria-hidden="true"></i>`，JS 在 boot 後呼叫 `window.lucide.createIcons()`。
- 色彩變數：`--teal` (#76ABAE) / `--orange` (#FF5722) / `--red` (color-mix) / `--bg-0`~`--bg-3`（深色階）。
- 字型：display → `Chakra Petch`；monospace → `JetBrains Mono`；body → `Noto Sans TC`。
- 動畫前必須 feature-detect：`const hasGsap = typeof window.gsap !== 'undefined'`，並尊重 `prefers-reduced-motion`。

## 新增/修改計算欄位

1. 在 `engine.js` 的 `DEFAULT_STATE` 加入欄位。
2. 在 `computeCapacity` 回傳物件中掛載計算結果。
3. 在 `app.js` 的 `render(r)` 更新對應 DOM 元素。
4. 若需要新的 slider/chip，在 `buildControls()` 建立、`wireInputs()` 綁定事件。

## 記憶體分配區塊類型（CSS class）

| class | 顏色 | 說明 |
|-------|------|------|
| `mem-block--reserve` | 灰斜紋 | GPU 系統預留 1.5 GB |
| `mem-block--model-vram` | 紫 | 模型存於 VRAM |
| `mem-block--model-ram` | 深紫斜紋 | 模型溢出至 RAM |
| `mem-block--kv-vram` | teal | KV Cache 存於 VRAM |
| `mem-block--kv-ram` | 橘紅 | KV Cache 溢出至 RAM（紅色警示） |
| `mem-block--free` | 透明 | 空閒空間 |

奇偶交替色透過 `.mem-block--idx-1/3/5/7` selector 實現，`index` 值為該區塊在陣列中的位置。
