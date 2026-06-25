/*
 * app.js — 反應式綁定層
 * state -> computeCapacity() -> render()，並以 GSAP 補間數值與儀表。
 * 所有外部函式庫（GSAP / three.js / Lucide）皆 feature-detect，離線可用。
 */
import {
  computeCapacity, DEFAULT_STATE,
  MODEL_PRESETS, QUANT_PRESETS, CONTEXT_PRESETS, KV_PRESETS, USE_CASES,
} from './engine.js';

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const hasGsap = typeof window.gsap !== 'undefined';

/* ---------- state ---------- */
const state = { ...DEFAULT_STATE };

const $ = (id) => document.getElementById(id);
const SCENARIO_META = {
  chat:  { label: 'Chat',   sub: '一般聊天', icon: 'messages-square' },
  coding:{ label: 'Coding', sub: '軟體開發', icon: 'code-xml' },
  ocr:   { label: 'OCR',    sub: '文字辨識', icon: 'scan-text' },
  audio: { label: 'Audio',  sub: '語音轉文字', icon: 'mic' },
};

const STAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><polygon points="12 2 15 9 22 9.3 16.6 14 18.6 21 12 17 5.4 21 7.4 14 2 9.3 9 9"/></svg>';

/* =================================================================
   Build dynamic controls
   ================================================================= */
function buildControls() {
  // use-case select
  const sel = $('in-usecase');
  sel.innerHTML = USE_CASES.map((u) => `<option value="${u.key}">${u.label}</option>`).join('');
  sel.value = state.useCase;

  // quant chips
  $('ctrl-quant').innerHTML = QUANT_PRESETS.map((q) =>
    `<label class="chip${q === state.quant ? ' is-on' : ''}"><input type="radio" name="quant" value="${q}">${q}</label>`
  ).join('');

  // kv chips
  $('ctrl-kv').innerHTML = KV_PRESETS.map((k) =>
    `<label class="chip${k === state.kvPrecision ? ' is-on' : ''}"><input type="radio" name="kv" value="${k}">${k}</label>`
  ).join('');

  // scenario rows (built once; only star/reason updated on recompute)
  $('scenario-list').innerHTML = Object.keys(SCENARIO_META).map((key) => {
    const m = SCENARIO_META[key];
    const stars = Array.from({ length: 5 }, () => `<span class="star">${STAR_SVG}</span>`).join('');
    return `<div class="scenario" data-key="${key}">
      <i data-lucide="${m.icon}" class="sc-ico" aria-hidden="true"></i>
      <div class="scenario__name">${m.label}<small>${m.sub}</small></div>
      <div class="scenario__meta">
        <span class="stars" data-stars="${key}">${stars}</span>
        <span class="scenario__reason" data-reason="${key}"></span>
      </div>
    </div>`;
  }).join('');
}

/* =================================================================
   Input wiring
   ================================================================= */
function setRangeFill(el) {
  const min = +el.min, max = +el.max, val = +el.value;
  const p = ((val - min) / (max - min)) * 100;
  el.style.setProperty('--p', p + '%');
}

// hardware fields: range + number paired
function linkPair(rangeId, numId, key) {
  const r = $(rangeId), n = $(numId);
  const sync = (val, fromRange) => {
    state[key] = val;
    if (fromRange) n.value = val; else r.value = Math.min(+r.max, Math.max(+r.min, val));
    setRangeFill(r);
    update();
  };
  r.addEventListener('input', () => sync(+r.value, true));
  n.addEventListener('input', () => { const v = +n.value; if (Number.isFinite(v)) sync(v, false); });
  setRangeFill(r);
}

function wireInputs() {
  linkPair('in-vram', 'in-vram-num', 'vram');
  linkPair('in-ram', 'in-ram-num', 'ram');
  linkPair('in-users', 'in-users-num', 'users');

  $('in-usecase').addEventListener('change', (e) => { state.useCase = e.target.value; update(); });

  // params slider (index -> preset)
  const pr = $('in-params');
  pr.max = MODEL_PRESETS.length - 1;
  pr.value = MODEL_PRESETS.findIndex((m) => m.params === state.params);
  const applyParams = () => {
    const m = MODEL_PRESETS[+pr.value];
    state.params = m.params;
    $('val-params').textContent = m.params + 'B';
    $('note-params').textContent = m.name;
    setRangeFill(pr);
    update();
  };
  pr.addEventListener('input', applyParams);
  setRangeFill(pr);

  // models slider
  const mr = $('in-models');
  mr.value = state.models || 1;
  $('val-models').textContent = mr.value + ' 個';
  const applyModels = () => {
    state.models = +mr.value;
    $('val-models').textContent = mr.value + ' 個';
    setRangeFill(mr);
    update();
  };
  mr.addEventListener('input', applyModels);
  setRangeFill(mr);

  // context slider (index -> preset)
  const cx = $('in-context');
  cx.max = CONTEXT_PRESETS.length - 1;
  cx.value = CONTEXT_PRESETS.findIndex((c) => c.tokens === state.contextTokens);
  const applyCtx = () => {
    const c = CONTEXT_PRESETS[+cx.value];
    state.contextTokens = c.tokens;
    $('val-context').textContent = c.label;
    setRangeFill(cx);
    update();
  };
  cx.addEventListener('input', applyCtx);
  setRangeFill(cx);

  // quant / kv radio chips
  chipGroup('ctrl-quant', 'quant', (v) => { state.quant = v; update(); });
  chipGroup('ctrl-kv', 'kv', (v) => { state.kvPrecision = v; update(); });

  // expert toggle
  const et = $('expert-toggle');
  const eb = $('expert-body');
  et.addEventListener('change', () => { eb.hidden = !et.checked; });
  eb.hidden = !et.checked;

  // copy buttons
  document.querySelectorAll('.copy').forEach((btn) => {
    btn.addEventListener('click', () => copyFrom(btn));
  });
}

function chipGroup(containerId, name, onPick) {
  const wrap = $(containerId);
  wrap.addEventListener('click', (e) => {
    const label = e.target.closest('.chip');
    if (!label) return;
    const input = label.querySelector('input');
    input.checked = true;
    wrap.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-on', c === label));
    onPick(input.value);
  });
}

async function copyFrom(btn) {
  const pre = $(btn.dataset.target);
  const text = pre.textContent;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // fallback for non-secure contexts
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  }
  const span = btn.querySelector('span');
  const prev = span.textContent;
  btn.classList.add('copied'); span.textContent = '已複製';
  setTimeout(() => { btn.classList.remove('copied'); span.textContent = prev; }, 1600);
}

/* =================================================================
   Render
   ================================================================= */
const counters = new WeakMap();
function tweenNum(el, to, fmt) {
  const from = counters.get(el) ?? to;
  counters.set(el, to);
  if (!hasGsap || reduced || from === to) { el.textContent = fmt(to); return; }
  const o = { v: from };
  window.gsap.to(o, { v: to, duration: 0.6, ease: 'power2.out', onUpdate: () => el.textContent = fmt(o.v) });
}

const TONE_VAR = { teal: 'var(--teal)', 'teal-warm': 'var(--teal-warm)', orange: 'var(--orange)', red: 'var(--red)' };

function verdictFor(score) {
  if (score >= 88) return '完美匹配';
  if (score >= 72) return '良好匹配';
  if (score >= 55) return '可用但吃緊';
  if (score >= 35) return '明顯瓶頸';
  return '無法負荷';
}

/* score -> 連續色帶（red -> orange -> teal-warm -> teal），與 3D / 文字 / 數字共用 */
const RAMP = [
  [0.00, [181, 48, 26]],   // red
  [0.40, [255, 87, 34]],   // orange
  [0.55, [180, 133, 111]], // teal-warm
  [0.72, [118, 171, 174]], // teal
  [1.00, [118, 171, 174]],
];
function rampColor(score) {
  const t = Math.max(0, Math.min(1, score / 100));
  let a = RAMP[0], b = RAMP[RAMP.length - 1];
  for (let i = 0; i < RAMP.length - 1; i++) {
    if (t >= RAMP[i][0] && t <= RAMP[i + 1][0]) { a = RAMP[i]; b = RAMP[i + 1]; break; }
  }
  const span = b[0] - a[0];
  const f = span ? (t - a[0]) / span : 0;
  const c = a[1].map((v, i) => Math.round(v + (b[1][i] - v) * f));
  return '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('');
}

let sceneHandle = null;

let lastStepsStr = '';
let typewriterTimeoutIds = [];

function typewriteList(container, steps) {
  const currentStr = JSON.stringify(steps);
  if (currentStr === lastStepsStr) return; // Keep as is if steps haven't changed
  lastStepsStr = currentStr;

  // Clear any existing timeouts from previous typing
  typewriterTimeoutIds.forEach(id => clearTimeout(id));
  typewriterTimeoutIds = [];

  container.innerHTML = '';
  if (!steps || steps.length === 0) return;

  let itemIndex = 0;

  function typeNextItem() {
    if (itemIndex >= steps.length) return;
    const text = steps[itemIndex];
    const item = document.createElement('div');
    item.className = 'autoopt-item';
    container.appendChild(item);

    let charIndex = 0;
    const speed = 20; // 20ms per character typing speed

    function typeChar() {
      if (charIndex < text.length) {
        item.textContent += text.charAt(charIndex);
        charIndex++;
        const tid = setTimeout(typeChar, speed);
        typewriterTimeoutIds.push(tid);
      } else {
        itemIndex++;
        const tid = setTimeout(typeNextItem, 100); // 100ms delay between items
        typewriterTimeoutIds.push(tid);
      }
    }

    typeChar();
  }

  typeNextItem();
}

function render(r) {
  // ---- score (number + verdict tinted by shared ramp) ----
  const col = rampColor(r.score);
  const snum = $('score-num');
  tweenNum(snum, r.score, (v) => String(Math.round(v)));
  snum.style.color = col;
  tweenNum($('chip-score'), r.score, (v) => String(Math.round(v)));
  $('chip-score').style.color = col;
  const vEl = $('score-verdict'); vEl.textContent = verdictFor(r.score); vEl.style.color = col;

  // ---- hero readout ----
  $('ro-vram').textContent = Math.round(r.effective.vram);
  $('ro-fit').textContent = r.fitRatio.toFixed(2);
  $('ro-load').textContent = Math.round(Math.min(r.fitRatio, 1.5) * 100);

  // ---- auto-opt banner ----
  const ao = $('autoopt');
  if (r.optimization.optimized) {
    ao.hidden = false;
    typewriteList($('autoopt-list'), r.optimization.steps);
  } else {
    ao.hidden = true;
    typewriterTimeoutIds.forEach(id => clearTimeout(id));
    typewriterTimeoutIds = [];
    $('autoopt-list').innerHTML = '';
    lastStepsStr = '';
  }

  // ---- stats ----
  tweenNum($('stat-models'), r.maxModels, (v) => Math.round(v) + '×');
  tweenNum($('stat-users'), r.maxUsers, (v) => Math.round(v) + ' 人');
  $('stat-context').textContent = r.perUserMaxLabel;

  // ---- memory allocation ----
  renderMemoryAllocation(r.memory);

  // ---- throughput ----
  const tp = $('tp');
  tp.style.setProperty('--tone', TONE_VAR[r.throughput.tone] || 'var(--teal)');
  $('tp-label').textContent = r.throughput.label;
  tweenNum($('tp-ts'), r.throughput.ts, (v) => v >= 10 ? String(Math.round(v)) : v.toFixed(1));
  const fillPct = Math.max(5, Math.min(100, 100 - ((r.fitRatio - 0.7) / 0.6) * 95));
  $('tp-fill').style.width = fillPct + '%';
  $('tp-blurb').textContent = r.throughput.blurb;

  // ---- scenarios ----
  r.scenarios.forEach((sc) => {
    const starsWrap = document.querySelector(`[data-stars="${sc.key}"]`);
    if (starsWrap) {
      starsWrap.querySelectorAll('.star svg').forEach((svg, i) => svg.classList.toggle('on', i < sc.stars));
    }
    const reasonEl = document.querySelector(`[data-reason="${sc.key}"]`);
    if (reasonEl) reasonEl.textContent = sc.reason;
    const row = document.querySelector(`.scenario[data-key="${sc.key}"]`);
    if (row) row.classList.toggle('is-active', sc.key === r.input.useCase);
  });

  // ---- env vars ----
  $('env-powershell').textContent = r.env.powershell;
  $('env-bash').textContent = r.env.bash;

  // ---- 3D scene: colour follows score, energy(攪動) follows shortfall ----
  if (sceneHandle) {
    const energy = Math.max(0, Math.min(1, 1 - r.score / 100));
    sceneHandle.setReactor(col, energy);
  }
}

function renderMemoryAllocation(mem) {
  // Update texts
  $('vram-bar-text').textContent = `${mem.vram.used.toFixed(1)} / ${mem.vram.total.toFixed(0)} GB`;
  $('ram-bar-text').textContent = `${mem.ram.used.toFixed(1)} / ${mem.ram.total.toFixed(0)} GB`;

  // Render VRAM blocks
  const vramBar = $('vram-bar');
  vramBar.innerHTML = '';
  
  if (mem.vram.blocks.length === 0) {
    vramBar.innerHTML = '<div class="mem-block mem-block--free" style="width: 100%;">空閒 100%</div>';
  } else {
    mem.vram.blocks.forEach(b => {
      const pct = (b.size / mem.vram.total) * 100;
      if (pct > 0) {
        const div = document.createElement('div');
        div.className = `mem-block mem-block--${b.type} ${b.index !== undefined ? 'mem-block--idx-' + b.index : ''}`;
        div.style.width = `${pct}%`;
        div.setAttribute('data-tip', `${b.label} (${pct.toFixed(1)}%)`);
        if (pct > 7) {
          div.textContent = b.label;
        }
        vramBar.appendChild(div);
      }
    });
    // Add free space block if any
    const freePct = (mem.vram.free / mem.vram.total) * 100;
    if (freePct > 0.1) {
      const div = document.createElement('div');
      div.className = 'mem-block mem-block--free';
      div.style.width = `${freePct}%`;
      div.setAttribute('data-tip', `空閒 (${freePct.toFixed(1)}%)`);
      if (freePct > 10) {
        div.textContent = `空閒 (${mem.vram.free.toFixed(1)}G)`;
      }
      vramBar.appendChild(div);
    }
  }

  // Render RAM blocks
  const ramBar = $('ram-bar');
  ramBar.innerHTML = '';
  
  if (mem.ram.blocks.length === 0) {
    const div = document.createElement('div');
    div.className = 'mem-block mem-block--free';
    div.style.width = '100%';
    div.setAttribute('data-tip', `系統 RAM 未被 LLM 溢出占用`);
    div.textContent = '系統空閒';
    ramBar.appendChild(div);
  } else {
    mem.ram.blocks.forEach(b => {
      const pct = (b.size / mem.ram.total) * 100;
      if (pct > 0) {
        const div = document.createElement('div');
        div.className = `mem-block mem-block--${b.type} ${b.index !== undefined ? 'mem-block--idx-' + b.index : ''}`;
        div.style.width = `${pct}%`;
        div.setAttribute('data-tip', `${b.label} (${pct.toFixed(1)}%)`);
        if (pct > 7) {
          div.textContent = b.label;
        }
        ramBar.appendChild(div);
      }
    });
    // Add free space block if any
    const freePct = (mem.ram.free / mem.ram.total) * 100;
    if (freePct > 0.1) {
      const div = document.createElement('div');
      div.className = 'mem-block mem-block--free';
      div.style.width = `${freePct}%`;
      div.setAttribute('data-tip', `空閒 (${freePct.toFixed(1)}%)`);
      if (freePct > 10) {
        div.textContent = `空閒 (${mem.ram.free.toFixed(1)}G)`;
      }
      ramBar.appendChild(div);
    }
  }

  // Update status badge
  const badge = $('mem-status-badge');
  if (mem.ram.oom) {
    badge.innerHTML = '<i data-lucide="alert-triangle" aria-hidden="true"></i> 記憶體超載 (OOM)';
    badge.className = 'mem-alloc__badge mem-alloc__badge--oom';
  } else if (mem.ram.used > 0) {
    badge.innerHTML = '<i data-lucide="zap" aria-hidden="true"></i> 溢出 RAM 運行';
    badge.className = 'mem-alloc__badge mem-alloc__badge--spilled';
  } else {
    badge.innerHTML = '<i data-lucide="check-circle-2" aria-hidden="true"></i> 全 VRAM 滿速';
    badge.className = 'mem-alloc__badge mem-alloc__badge--vram';
  }
  if (window.lucide) { try { window.lucide.createIcons({ nodes: [badge] }); } catch {} }
}

function update() {
  render(computeCapacity(state));
}

/* =================================================================
   Motion (GSAP) — guarded
   ================================================================= */
function initMotion() {
  document.body.classList.remove('preload');
  if (!hasGsap || reduced) return;
  const gsap = window.gsap;
  gsap.from('.topbar', { y: -34, opacity: 0, duration: 0.5, ease: 'power3.out' });
  gsap.from('.panel', { y: 28, opacity: 0, duration: 0.6, stagger: 0.08, ease: 'power3.out', clearProps: 'opacity,transform' });
}

/* =================================================================
   3D hero — dynamic import, fully optional
   ================================================================= */
async function initScene() {
  const canvas = $('hero-canvas');
  if (reduced) { showFallback(); return; }
  try {
    const mod = await import('./scene.js');
    sceneHandle = await mod.initHero(canvas);
    if (!sceneHandle) showFallback();
  } catch (err) {
    showFallback();
  }
}
function showFallback() {
  const fb = $('hero-fallback'); const cv = $('hero-canvas');
  if (fb) fb.style.display = 'grid';
  if (cv) cv.style.display = 'none';
}

/* =================================================================
   Boot
   ================================================================= */
function boot() {
  if (hasGsap && !reduced) document.body.classList.add('preload');
  buildControls();
  wireInputs();
  if (window.lucide) { try { window.lucide.createIcons(); } catch {} }
  update();           // first paint
  initMotion();
  initScene();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
