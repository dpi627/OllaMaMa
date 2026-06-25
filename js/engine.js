/*
 * engine.js — Ollama 容量評估純計算引擎
 * --------------------------------------------------------------
 * 設計原則：無 DOM、無副作用，computeCapacity(state) -> results。
 * 所有體積以「友善 GB」浮點計算（非 GiB 嚴格值），常數刻意反推自
 * spec.md 的標竿範例（24GB VRAM / 32B Q4_K_M / 64k / 2 人），
 * 讓 demo 數字與規格書完全吻合，而非追求物理精確的 GQA KV-cache。
 */

/* ---------- 基礎常數（GB 為單位） ---------- */

// 系統 / activation 預留（顯存）。spec 4.1 的 buffer。
export const RESERVE_GB = 1.5;

// 每「十億參數」佔用的體積（GB），已含量化 metadata overhead。
// 32B × 0.625 = 20GB，與 spec 標竿一致。
export const BYTES_PER_PARAM_GB = {
  f16: 2.0,
  Q8_0: 1.0625,
  Q6_K: 0.82,
  Q5_K_M: 0.6875,
  Q4_K_M: 0.625,
};

// KV cache：每 (token × 十億參數) 在 f16 下佔用的 GB。
// 反推：32 × 65536 × KV = 2.15GB  =>  KV = 2.15 / (32 × 65536)
export const KV_GB_PER_TOKEN_PER_B = 2.15 / (32 * 65536);

// KV cache 精度倍率（相對 f16）。
export const KV_PRECISION_MULT = { f16: 1.0, q8_0: 0.5, q4_0: 0.25 };
export const KV_PRECISION_ORDER = ['f16', 'q8_0', 'q4_0']; // 由高到低

/* ---------- UI 用 preset（供 app.js 建表單） ---------- */

export const MODEL_PRESETS = [
  { params: 1.5, name: 'Qwen2.5 1.5B' },
  { params: 3, name: 'Llama3.2 3B' },
  { params: 7, name: 'Mistral 7B' },
  { params: 8, name: 'Llama3.1 8B' },
  { params: 13, name: 'Vicuna 13B' },
  { params: 14, name: 'Qwen2.5 14B' },
  { params: 27, name: 'Gemma2 27B' },
  { params: 32, name: 'Qwen2.5 32B' },
  { params: 70, name: 'Llama3.3 70B' },
];

export const QUANT_PRESETS = ['Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0'];

export const CONTEXT_PRESETS = [
  { tokens: 4096, label: '4k' },
  { tokens: 8192, label: '8k' },
  { tokens: 16384, label: '16k' },
  { tokens: 32768, label: '32k' },
  { tokens: 49152, label: '48k' },
  { tokens: 65536, label: '64k' },
  { tokens: 131072, label: '128k' },
];

export const KV_PRESETS = ['f16', 'q8_0', 'q4_0'];

export const USE_CASES = [
  { key: 'chat', label: 'AI 聊天' },
  { key: 'coding', label: '軟體開發 (Agentic)' },
  { key: 'ocr', label: 'OCR 文字辨識' },
  { key: 'audio', label: '語音轉文字' },
];

/* ---------- 預設 state ---------- */

export const DEFAULT_STATE = {
  vram: 24,
  ram: 32,
  users: 2,
  useCase: 'coding',
  params: 32,
  quant: 'Q4_K_M',
  contextTokens: 65536,
  kvPrecision: 'f16',
  models: 1,
};

/* ---------- 體積基本算式 ---------- */

export function modelFileSizeGB(params, quant) {
  return params * (BYTES_PER_PARAM_GB[quant] ?? BYTES_PER_PARAM_GB.Q4_K_M);
}

// 單人 KV cache（GB）。
export function perUserKvGB(params, tokens, kvPrecision) {
  const mult = KV_PRECISION_MULT[kvPrecision] ?? 1.0;
  return KV_GB_PER_TOKEN_PER_B * params * tokens * mult;
}

// 指定 user 數下，顯存實際總需求（GB）。
export function totalNeededGB(state, users) {
  const modelsCount = state.models ?? 1;
  const model = modelFileSizeGB(state.params, state.quant) * modelsCount;
  const kv = perUserKvGB(state.params, state.contextTokens, state.kvPrecision);
  return model + kv * users + RESERVE_GB;
}

/* ---------- 自動優化（spec 第 5 節） ---------- */
/*
 * 當所需顯存 > VRAM 時，依序：
 *   1. 降 KV cache 精度 f16 -> q8_0 -> q4_0
 *   2. 降 Context window（往刻度下層走）
 *   3. （建議）降模型大小 / 量化  — MVP 只給文字建議，不自動改
 * 回傳 { state: 調整後, steps: [...], optimized: bool }
 */
export function autoOptimize(rawState) {
  const state = { ...rawState };
  const steps = [];
  const users = Math.max(1, state.users);

  const fits = () => totalNeededGB(state, users) <= state.vram;

  // 1) 降 KV 精度
  while (!fits()) {
    const idx = KV_PRECISION_ORDER.indexOf(state.kvPrecision);
    if (idx < 0 || idx >= KV_PRECISION_ORDER.length - 1) break;
    const next = KV_PRECISION_ORDER[idx + 1];
    steps.push(`KV Cache 精度由 ${state.kvPrecision} 調降至 ${next}（記憶體即省約一半）`);
    state.kvPrecision = next;
  }

  // 2) 降 Context
  const ctxScale = CONTEXT_PRESETS.map((c) => c.tokens).sort((a, b) => b - a);
  while (!fits()) {
    const lower = ctxScale.find((t) => t < state.contextTokens);
    if (lower === undefined) break;
    const fromLabel = labelForContext(state.contextTokens);
    const toLabel = labelForContext(lower);
    steps.push(`Context window 由 ${fromLabel} 縮短至 ${toLabel} 以釋放顯存`);
    state.contextTokens = lower;
  }

  // 3) 仍放不下 -> 建議降載
  if (!fits()) {
    steps.push('顯存仍不足，建議減少載入模型數、使用更小模型或更低量化以避免 CPU offload');
  }

  return { state, steps, optimized: steps.length > 0 };
}

function labelForContext(tokens) {
  const hit = CONTEXT_PRESETS.find((c) => c.tokens === tokens);
  return hit ? hit.label : `${Math.round(tokens / 1024)}k`;
}

/* ---------- 吞吐體感（spec 表 4.1） ---------- */

export function throughput(fitRatio, params) {
  // 依模型大小微調基準速度：小模型更快。
  const modelScale = clamp(Math.pow(32 / params, 0.3), 0.6, 2.0);
  let band;
  if (fitRatio < 0.85) {
    band = { key: 'fast', label: '飛快', icon: 'rabbit', tone: 'teal', base: 38, blurb: '字如泉湧 — 模型全在 VRAM，單人獨佔 GPU 算力。' };
  } else if (fitRatio <= 1.0) {
    band = { key: 'fluid', label: '流暢', icon: 'gauge', tone: 'teal-warm', base: 25, blurb: '閱讀速度 — 顯存接近飽和，多人同時打字時會微喘。' };
  } else if (fitRatio <= 1.15) {
    band = { key: 'slow', label: '緩慢', icon: 'turtle', tone: 'orange', base: 8, blurb: '逐字蹦出 — 部分權重溢出至系統 RAM，體驗變差。' };
  } else {
    band = { key: 'veryslow', label: '極卡', icon: 'snail', tone: 'red', base: 1.6, blurb: 'PPT 幻燈片 — 大量依賴 RAM 與 CPU，建議降級模型。' };
  }
  const ts = Math.max(0.5, band.base * modelScale);
  return { ...band, ts, fitRatio };
}

/* ---------- 情境適用度（spec 4.2，1~5 星） ---------- */

export function scoreScenarios(effState, ctx) {
  const { params, contextTokens, fitRatio, modelFitsVRAM } = ctx;
  const out = [];

  // 💬 Chat：最不吃 Context，模型進得了 VRAM 且 >= 7B 即滿星。
  out.push(scenario('chat', 'Chat', 'messages-square', () => {
    if (!modelFitsVRAM) return [2, '模型溢出 VRAM，回應會明顯延遲'];
    if (params < 7) return [3, '模型偏小，閒聊堪用但深度有限'];
    if (fitRatio > 1.15) return [3, '顯存吃緊，多輪對話會變慢'];
    if (fitRatio > 1.0) return [4, '可流暢聊天，重載時略降速'];
    return [5, '模型全在 VRAM，聊天體驗滿分'];
  }));

  // 💻 Coding：極度看重 Context（建議 >= 64k）。
  out.push(scenario('coding', 'Coding', 'code-xml', () => {
    if (!modelFitsVRAM) return [2, '模型溢出，Agent 會頻繁卡頓'];
    if (contextTokens >= 65536 && params >= 14 && fitRatio <= 1.0) return [5, 'Context >= 64k 且模型夠大，Agent 記得住整個專案'];
    if (contextTokens >= 32768 && fitRatio <= 1.05) return [4, 'Context 32k 足夠中型任務，超大專案會略短'];
    if (contextTokens >= 16384) return [3, 'Context 偏短，Agent 容易忘記較早的前文'];
    return [2, 'Context 被壓到 <= 8k，AI 馬上忘記前文'];
  }));

  // 🔍 OCR / 🎙️ Audio：吃快閃算力、不吃長 Context；大模型反而過重。
  const flash = (key, label, icon) => scenario(key, label, icon, () => {
    if (!modelFitsVRAM) return [2, '模型溢出，快閃推論速度受損'];
    let s = fitRatio <= 0.85 ? 4 : fitRatio <= 1.0 ? 3 : 2;
    if (params > 32) s = Math.max(2, s - 1); // 超大模型對 OCR/Audio 過重
    const why = s >= 4 ? '顯存充足、速度優先，適合多模態小模型'
      : s === 3 ? '速度尚可，搭配專用小模型表現更佳'
      : '顯存吃緊或模型過重，快閃任務會掉速';
    return [s, why];
  });
  out.push(flash('ocr', 'OCR', 'scan-text'));
  out.push(flash('audio', 'Audio', 'mic'));

  return out;

  function scenario(key, label, icon, fn) {
    const [stars, reason] = fn();
    return { key, label, icon, stars, reason };
  }
}

/* ---------- 主入口 ---------- */

/* ---------- 記憶體分配計算 ---------- */

export function computeMemoryAllocation(eff, users, modelFile, perUserKV) {
  const vramBlocks = [];
  const ramBlocks = [];

  const vramTotal = eff.vram;
  let vramRemaining = vramTotal;

  const ramTotal = eff.ram;
  let ramRemaining = ramTotal;
  let ramUsedByLlm = 0;

  // 1. GPU Reserve
  const reserveSize = Math.min(RESERVE_GB, vramRemaining);
  if (reserveSize > 0) {
    vramBlocks.push({
      type: 'reserve',
      label: `預留 (${reserveSize.toFixed(1)}G)`,
      size: reserveSize,
    });
    vramRemaining -= reserveSize;
  }

  // 2. Models
  const numModels = eff.models ?? 1;
  for (let i = 0; i < numModels; i++) {
    const modelVram = Math.min(modelFile, vramRemaining);
    if (modelVram > 0) {
      vramBlocks.push({
        type: 'model-vram',
        label: numModels > 1 ? `模型 ${i + 1} (${modelVram.toFixed(1)}G)` : `模型 (${modelVram.toFixed(1)}G)`,
        size: modelVram,
        index: vramBlocks.length,
      });
      vramRemaining -= modelVram;
    }
    
    const modelRam = modelFile - modelVram;
    if (modelRam > 0) {
      ramBlocks.push({
        type: 'model-ram',
        label: numModels > 1 ? `模型 ${i + 1} (${modelRam.toFixed(1)}G)` : `模型 (${modelRam.toFixed(1)}G)`,
        size: modelRam,
        index: ramBlocks.length,
      });
      ramUsedByLlm += modelRam;
    }
  }

  // 3. KV Cache (per user)
  for (let i = 0; i < users; i++) {
    const kvVram = Math.min(perUserKV, vramRemaining);
    if (kvVram > 0) {
      vramBlocks.push({
        type: 'kv-vram',
        label: users > 1 ? `用戶 ${i + 1} (${kvVram.toFixed(1)}G)` : `對話 (${kvVram.toFixed(1)}G)`,
        size: kvVram,
        index: vramBlocks.length,
      });
      vramRemaining -= kvVram;
    }

    const kvRam = perUserKV - kvVram;
    if (kvRam > 0) {
      ramBlocks.push({
        type: 'kv-ram',
        label: users > 1 ? `用戶 ${i + 1} (${kvRam.toFixed(1)}G)` : `對話 (${kvRam.toFixed(1)}G)`,
        size: kvRam,
        index: ramBlocks.length,
      });
      ramUsedByLlm += kvRam;
    }
  }

  const vramUsed = vramTotal - vramRemaining;
  const oom = ramUsedByLlm > ramTotal;

  return {
    vram: {
      total: vramTotal,
      used: vramUsed,
      free: Math.max(0, vramRemaining),
      blocks: vramBlocks,
    },
    ram: {
      total: ramTotal,
      used: ramUsedByLlm,
      free: Math.max(0, ramTotal - ramUsedByLlm),
      blocks: ramBlocks,
      oom,
    }
  };
}

/* ---------- 主入口 ---------- */

export function computeCapacity(rawState) {
  const state = normalize(rawState);
  const users = state.users;

  // 自動優化（可能調整 kvPrecision / contextTokens / models）
  const opt = autoOptimize(state);
  const eff = opt.state;

  const modelFile = modelFileSizeGB(eff.params, eff.quant);
  const totalModelFile = modelFile * eff.models;
  const perUserKV = perUserKvGB(eff.params, eff.contextTokens, eff.kvPrecision);
  const availableForKV = eff.vram - totalModelFile - RESERVE_GB;

  // ① 最大模型載入數
  const maxModels = Math.max(0, Math.floor((eff.vram - RESERVE_GB) / modelFile));

  // ② 最大併發人數
  const maxUsers = availableForKV > 0 && perUserKV > 0
    ? Math.max(0, Math.floor(availableForKV / perUserKV))
    : 0;

  // ③ 每人 Context 上限（以目前人數均分剩餘空間反推）
  const perUserMaxTokens = computePerUserMaxContext(availableForKV, users, eff);

  // ④ 吞吐體感（用實際設定人數）
  const fitRatio = totalNeededGB(eff, users) / eff.vram;
  const tp = throughput(fitRatio, eff.params);

  const modelFitsVRAM = totalModelFile + RESERVE_GB <= eff.vram;

  // 情境星等（跑在優化後的有效設定上）
  const scenarios = scoreScenarios(eff, { params: eff.params, contextTokens: eff.contextTokens, fitRatio, modelFitsVRAM });

  // 綜合匹配分數
  const score = matchScore(fitRatio, users, maxUsers, scenarios, eff.useCase);

  const env = buildEnvVars(eff, { maxUsers, users });

  // 記憶體分配圖用「原始設定」計算，才能顯示優化前的 VRAM 溢出紅色區；
  // autoOptimize 只改 kvPrecision / contextTokens，硬體規格不變。
  const rawPerUserKV = perUserKvGB(state.params, state.contextTokens, state.kvPrecision);
  const memory = computeMemoryAllocation(state, users, modelFile, rawPerUserKV);

  return {
    input: state,
    effective: eff,
    optimization: opt,
    modelFile,
    perUserKV,
    availableForKV,
    maxModels,
    maxUsers,
    perUserMaxTokens,
    perUserMaxLabel: tokensLabel(perUserMaxTokens),
    fitRatio,
    throughput: tp,
    modelFitsVRAM,
    scenarios,
    score,
    env,
    memory,
  };
}

/* ---------- 輔助 ---------- */

function normalize(s) {
  const m = { ...DEFAULT_STATE, ...s };
  m.vram = clamp(num(m.vram, 24), 1, 1024);
  m.ram = clamp(num(m.ram, 32), 1, 4096);
  m.users = clamp(Math.round(num(m.users, 1)), 1, 256);
  m.params = num(m.params, 32);
  m.contextTokens = clamp(Math.round(num(m.contextTokens, 65536)), 1024, 131072);
  m.models = clamp(Math.round(num(m.models, 1)), 1, 16);
  if (!BYTES_PER_PARAM_GB[m.quant]) m.quant = 'Q4_K_M';
  if (!KV_PRECISION_MULT[m.kvPrecision]) m.kvPrecision = 'f16';
  return m;
}

function computePerUserMaxContext(availableForKV, users, eff) {
  if (availableForKV <= 0) return 0;
  const perTokenGB = KV_GB_PER_TOKEN_PER_B * eff.params * (KV_PRECISION_MULT[eff.kvPrecision] ?? 1);
  const spacePerUser = availableForKV / Math.max(1, users);
  const raw = spacePerUser / perTokenGB;
  // 對齊到 1k 倍數並 cap 在常見訓練上限 128k
  return clamp(Math.floor(raw / 1024) * 1024, 0, 131072);
}

function matchScore(fitRatio, users, maxUsers, scenarios, useCase) {
  // fit 分量
  let fit;
  if (fitRatio <= 0.85) fit = 100 - (fitRatio / 0.85) * 8;
  else if (fitRatio <= 1.0) fit = 92 - ((fitRatio - 0.85) / 0.15) * 22;
  else if (fitRatio <= 1.15) fit = 68 - ((fitRatio - 1.0) / 0.15) * 28;
  else fit = Math.max(8, 40 - (fitRatio - 1.15) * 90);

  // 人數分量
  const usersComp = users <= maxUsers ? 100 : Math.max(20, (maxUsers / users) * 100);

  // 選定用途的星等分量
  const sel = scenarios.find((s) => s.key === useCase) || scenarios[0];
  const scenComp = (sel.stars / 5) * 100;

  const raw = 0.45 * fit + 0.25 * usersComp + 0.3 * scenComp;
  return clamp(Math.round(raw), 0, 100);
}

export function buildEnvVars(eff, { maxUsers, users }) {
  const parallel = Math.max(1, Math.min(users, maxUsers || 1));
  const quantizedKV = eff.kvPrecision !== 'f16';

  const pairs = [];
  if (quantizedKV) {
    pairs.push(['OLLAMA_FLASH_ATTENTION', '1']); // KV 量化前置需求
    pairs.push(['OLLAMA_KV_CACHE_TYPE', eff.kvPrecision]);
  }
  pairs.push(['OLLAMA_NUM_PARALLEL', String(parallel)]);
  pairs.push(['OLLAMA_MAX_LOADED_MODELS', String(eff.models ?? 1)]);
  pairs.push(['OLLAMA_NUM_CTX', String(eff.contextTokens)]);

  const powershell = pairs.map(([k, v]) => `$env:${k}="${v}"`).join('\n');
  const bash = pairs.map(([k, v]) => `export ${k}=${v}`).join('\n');
  return { powershell, bash, parallel, quantizedKV };
}

export function tokensLabel(tokens) {
  if (!tokens || tokens <= 0) return '0';
  if (tokens >= 1024) return `${Math.round(tokens / 1024)}k`;
  return String(tokens);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function num(v, fallback) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}
