const EXAMPLES = [
  '医保报销需要哪些材料？',
  '2026年AI芯片最新进展',
  '异地就医到底需不需要自己先垫付？',
  '火星殖民现在能赚钱吗？',
];

const $ = id => document.getElementById(id);
let modelPresets = [];
let allowCustomModels = true;

function fillExample(i) {
  $('query-input').value = EXAMPLES[i] || '';
  runAnalyze();
}

async function loadStatus() {
  try {
    const resp = await fetch('/api/status');
    const data = await resp.json();
    modelPresets = data.config?.modelPresets || [];
    allowCustomModels = data.config?.allowCustomModels !== false;
    applyCustomAvailability();
    renderModelSelect(data.config?.defaultModelId);
  } catch (err) {
    $('model-note').textContent = `读取模型配置失败：${err.message}`;
  }
}

function applyCustomAvailability() {
  const panel = document.querySelector('.custom-model-panel');
  if (!panel) return;
  panel.style.display = allowCustomModels ? 'block' : 'none';
  if (!allowCustomModels && $('custom-enabled')) $('custom-enabled').checked = false;
}

function renderModelSelect(defaultModelId) {
  const select = $('model-select');
  select.innerHTML = '';

  for (const preset of modelPresets) {
    const opt = document.createElement('option');
    opt.value = preset.id;
    opt.textContent = `${preset.label} / ${preset.model}${preset.configured ? '' : '（未配置 key）'}`;
    opt.disabled = !preset.configured;
    select.appendChild(opt);
  }

  const configuredDefault = modelPresets.find(p => p.id === defaultModelId && p.configured) ||
    modelPresets.find(p => p.configured);
  if (configuredDefault) select.value = configuredDefault.id;
  updateModelNote();
}

function selectedPreset() {
  return modelPresets.find(p => p.id === $('model-select').value);
}

function useCustomModel() {
  return !!$('custom-enabled')?.checked;
}

function customModelPayload() {
  if (!useCustomModel()) return null;
  return {
    enabled: true,
    provider: $('custom-provider').value.trim() || 'Custom',
    label: $('custom-label').value.trim(),
    baseUrl: $('custom-base-url').value.trim(),
    model: $('custom-model').value.trim(),
    apiKey: $('custom-api-key').value.trim(),
    riskBias: Number($('custom-risk-bias').value || 0),
    completionMode: $('custom-completion-mode').checked,
  };
}

function updateCustomPanel() {
  const enabled = useCustomModel();
  $('custom-model-grid').classList.toggle('active', enabled);
  $('model-select').disabled = enabled;
  updateModelNote();
}

function updateModelNote() {
  if (useCustomModel()) {
    const mode = $('custom-completion-mode').checked ? 'completions/logprobs' : 'chat/logprobs';
    const model = $('custom-model').value.trim() || '未填写 model';
    $('model-note').textContent = `自定义模型 · ${model} · ${mode} · key 仅本次请求使用`;
    return;
  }
  const preset = selectedPreset();
  if (!preset) {
    $('model-note').textContent = '没有可用模型，请检查 .env 配置。';
    return;
  }
  const bias = Number(preset.riskBias || 0);
  const mode = preset.completionMode ? 'completions/logprobs' : 'chat/logprobs';
  $('model-note').textContent = `${preset.provider} · ${preset.configured ? '已配置' : '未配置 key'} · ${mode} · 模型先验 +${bias.toFixed(2)}`;
}

function drawGauge(score) {
  const c = $('gauge-canvas');
  if (!c) return;
  const ctx = c.getContext('2d');
  const W = c.width;
  const H = c.height;
  const cx = W / 2;
  const cy = H - 16;
  const R = 90;
  ctx.clearRect(0, 0, W, H);

  [
    [Math.PI, 1.33 * Math.PI, '#bbf7d0'],
    [1.33 * Math.PI, 1.55 * Math.PI, '#fef08a'],
    [1.55 * Math.PI, 1.75 * Math.PI, '#fde68a'],
    [1.75 * Math.PI, 1.88 * Math.PI, '#fed7aa'],
    [1.88 * Math.PI, 2 * Math.PI, '#fecaca'],
  ].forEach(([a, b, color]) => {
    ctx.beginPath();
    ctx.arc(cx, cy, R, a, b);
    ctx.lineWidth = 16;
    ctx.strokeStyle = color;
    ctx.stroke();
  });

  const end = Math.PI + Math.min(1, score) * Math.PI;
  const arcColor = score < 0.25 ? '#16a34a' : score < 0.50 ? '#ca8a04' : '#dc2626';
  ctx.beginPath();
  ctx.arc(cx, cy, R, Math.PI, end);
  ctx.lineWidth = 16;
  ctx.strokeStyle = arcColor;
  ctx.lineCap = 'round';
  ctx.stroke();

  const nx = cx + Math.cos(end) * (R - 6);
  const ny = cy + Math.sin(end) * (R - 6);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(nx, ny);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#334155';
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#334155';
  ctx.fill();

  ctx.fillStyle = arcColor;
  ctx.font = 'bold 20px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(score.toFixed(3), cx, cy - 14);
}

let gaugeVal = 0;
function animateGauge(target) {
  const step = () => {
    gaugeVal += (target - gaugeVal) * 0.1;
    drawGauge(gaugeVal);
    if (Math.abs(gaugeVal - target) > 0.001) requestAnimationFrame(step);
    else drawGauge(target);
  };
  requestAnimationFrame(step);
}

let logprobPts = [];
function drawChart() {
  const c = $('logprob-canvas');
  if (!c) return;
  const W = c.offsetWidth || 400;
  c.width = W;
  const H = 80;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  if (logprobPts.length < 2) return;

  const minV = -5;
  const maxV = 0;
  const pts = logprobPts.map((v, i) => ({
    x: (i / (logprobPts.length - 1)) * W,
    y: H - ((Math.max(v, minV) - minV) / (maxV - minV)) * (H - 10) - 5,
  }));

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const cpx = (pts[i - 1].x + pts[i].x) / 2;
    ctx.bezierCurveTo(cpx, pts[i - 1].y, cpx, pts[i].y, pts[i].x, pts[i].y);
  }
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  logprobPts.forEach((v, i) => {
    if (v < -2) {
      const x = (i / (logprobPts.length - 1)) * W;
      const y = H - ((Math.max(v, minV) - minV) / (maxV - minV)) * (H - 10) - 5;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = v < -3 ? '#dc2626' : '#ca8a04';
      ctx.fill();
    }
  });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderPrompt(input) {
  $('h-prompt-badge').textContent = `H_prompt = ${input.hPrompt.toFixed(4)}`;
  $('prompt-analysis').innerHTML = `
    <div class="prompt-box">
      <div class="prompt-label">${escapeHtml(input.label)}</div>
      <p>用户输入叫 <b>prompt</b>。这里的 H_prompt 表示输入端不确定性：问题越短、越缺少主体/意图、越含糊，数值越高；清晰问题不会因为词频均匀就被判高风险。</p>
      <div class="prompt-stats">
        <span>长度：${input.length}</span>
        <span>token 数：${input.tokenCount}</span>
        <span>不同项：${input.distinctTerms}</span>
        <span>含糊词命中：${input.ambiguityHits}</span>
        <span>输入风险：${input.promptRisk.toFixed(4)}</span>
      </div>
    </div>`;
}

function renderChunks(chunks) {
  const el = $('chunk-list');
  if (!chunks || chunks.length === 0) {
    el.innerHTML = '<div class="empty-evidence">本地知识库和联网搜索都没有找到可用证据。<br><span>此时系统会把回答视为缺少外部依据，综合风险会被推高。</span></div>';
    return;
  }
  el.innerHTML = chunks.map(c => {
    const color = c.score > 1.8 ? '#16a34a' : c.score > 1 ? '#ca8a04' : '#ea580c';
    return `<div class="chunk-item">
      <span class="chunk-score" style="color:${color}">${Number(c.score).toFixed(2)}</span>
      <div class="chunk-content">
        ${escapeHtml(c.text.substring(0, 190))}${c.text.length > 190 ? '...' : ''}
        <div class="chunk-source">${escapeHtml(c.source)}</div>
      </div>
    </div>`;
  }).join('');
}

function setMetric(chipId, valId, barId, value) {
  const chip = $(chipId);
  const val = $(valId);
  const bar = $(barId);
  if (val) val.textContent = Number(value).toFixed(4);
  const cls = value > 0.7 ? 'alert' : value > 0.35 ? 'warn' : 'ok';
  if (chip) chip.className = `metric ${cls}`;
  const colors = { alert: '#dc2626', warn: '#ca8a04', ok: '#16a34a' };
  if (val) val.style.color = colors[cls];
  if (bar) {
    bar.style.width = `${Math.min(value * 100, 100)}%`;
    bar.style.background = colors[cls];
  }
}

function metricLabel(value) {
  if (value > 0.7) return '高';
  if (value > 0.35) return '中';
  return '低';
}

function retrievalModeLabel(mode) {
  const labels = {
    embedding: 'Embedding 知识库',
    'bm25-local': '本地知识库 BM25',
    bm25: '本地知识库 BM25',
    'hybrid-local-web': '本地知识库 + 联网搜索',
    'web-search': '联网搜索',
    'topic-fallback': '主题兜底证据',
    'web-search-empty': '联网搜索无结果',
    'bm25-empty': '本地知识库无结果',
  };
  return labels[mode] || mode || '-';
}

function renderEffect(data) {
  const { input, retrieval, generation, risk, model } = data;
  const score = risk.score;
  const stage = score < 0.25
    ? '结论：当前回答可正常输出'
    : score < 0.50
      ? '结论：当前回答需要显式提示不确定性'
      : '结论：当前回答建议拦截或人工复核';
  const summary = score < 0.25
    ? '输入、检索证据与生成过程整体较稳定，风险信号较弱。'
    : score < 0.50
      ? '本次回答存在输入含糊、证据分散、生成犹豫或模型较弱中的一类风险，适合提示用户二次确认。'
      : '本次回答命中高风险组合信号，系统应避免把不稳定结论包装成确定事实。';

  $('effect-stage').textContent = stage;
  $('effect-summary').textContent = summary;

  const generationLabel = generation.isStrictEntropy ? '输出熵 H_ans' : '平均负对数概率 avgNLP';
  const items = [
    `Prompt 输入熵 H_prompt = ${input.hPrompt.toFixed(4)}，输入风险 = ${input.promptRisk.toFixed(4)}（${input.label}）。`,
    `RAG 检索模式：${retrievalModeLabel(retrieval.mode)}，H_ret = ${retrieval.hret.toFixed(4)}（${metricLabel(retrieval.hret)}）。`,
    `${generationLabel} = ${generation.hans.toFixed(4)}（${metricLabel(generation.hans)}），用于定位模型生成时的不稳定位置。`,
    `冲突度 S_conflict = ${risk.conflict.toFixed(4)}，敏感度 S_sensitive = ${risk.sensitive.toFixed(4)}。`,
    `模型：${model.label}，模型不稳定先验 = ${Number(risk.modelBias || 0).toFixed(4)}。`,
    `综合风险 R = ${risk.score.toFixed(4)}，处置策略：${risk.action}`,
  ];
  $('effect-list').innerHTML = items.map(item => `<li>${escapeHtml(item)}</li>`).join('');
}

async function runAnalyze() {
  const query = $('query-input').value.trim();
  if (!query) return;

  $('results-area').style.display = 'none';
  $('info-bar').style.display = 'none';
  $('error-box').style.display = 'none';
  $('loading').style.display = 'block';
  $('status-text').textContent = 'ANALYZING...';
  $('status-dot').style.background = '#ca8a04';
  $('analyze-btn').disabled = true;

  try {
    const resp = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        topK: 5,
        modelId: $('model-select').value,
        customModel: customModelPayload(),
      }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error?.message || '未知后端错误');
    render(data);
  } catch (err) {
    $('error-box').textContent = `错误：${err.message}`;
    $('error-box').style.display = 'block';
    $('status-text').textContent = 'ERROR';
    $('status-dot').style.background = '#dc2626';
  } finally {
    $('loading').style.display = 'none';
    $('analyze-btn').disabled = false;
  }
}

function render(data) {
  const { input, model, retrieval, generation, risk } = data;

  $('info-model').textContent = `${model.label} / ${model.llmModel}`;
  $('info-retrieval').textContent = retrievalModeLabel(retrieval.mode);
  $('info-logprobs').textContent = model.logprobsAvailable ? '真实返回' : '未返回';
  $('info-logprobs').style.color = model.logprobsAvailable ? '#16a34a' : '#dc2626';
  $('info-model-bias').textContent = `+${Number(risk.modelBias || 0).toFixed(2)}`;
  $('info-elapsed').textContent = `${model.elapsed}ms`;
  $('info-bar').style.display = 'flex';

  renderPrompt(input);
  renderChunks(retrieval.chunks);
  $('h-ret-badge').textContent = `H_ret = ${retrieval.hret.toFixed(4)}`;

  $('output-answer').textContent = generation.answer;
  $('left-gen-badge').textContent = `${generation.answer.length} chars`;

  $('h-ans-badge').textContent = `${generation.isStrictEntropy ? 'H_ans' : 'avgNLP'} = ${generation.hans.toFixed(4)}`;
  $('hans-label').innerHTML = generation.isStrictEntropy ? 'H<sub>ans</sub>' : 'avgNegLogprob（非严格熵）';
  $('label-hans').textContent = generation.isStrictEntropy ? 'H_ans 输出熵' : 'avgNegLogprob';

  const tokEl = $('output-tokens');
  tokEl.innerHTML = '';
  logprobPts = [];
  if (generation.tokens && generation.tokens.length > 0) {
    generation.tokens.forEach(t => {
      const span = document.createElement('span');
      span.className = `token ${t.risk || 'safe'}`;
      span.textContent = t.text;
      span.title = `logp=${(t.logprob || 0).toFixed(3)} entropy=${(t.entropy || 0).toFixed(3)}`;
      tokEl.appendChild(span);
      logprobPts.push(t.logprob || 0);
    });
    drawChart();
  } else {
    tokEl.innerHTML = '<span class="muted-note">当前模型未返回 token logprobs，无法展示逐 token 不确定性。</span>';
  }

  setMetric('chip-hprompt', 'val-hprompt', 'bar-hprompt', input.hPrompt);
  setMetric('chip-hret', 'val-hret', 'bar-hret', retrieval.hret);
  setMetric('chip-hans', 'val-hans', 'bar-hans', generation.hans);
  setMetric('chip-conflict', 'val-conflict', 'bar-conflict', risk.conflict);
  setMetric('chip-sensitive', 'val-sensitive', 'bar-sensitive', risk.sensitive);

  const R = risk.score;
  $('risk-formula').textContent =
    `R = H'_prompt + H'_ret + H'_ans + 冲突/敏感度 + 模型先验(${Number(risk.modelBias || 0).toFixed(2)}) = ${R.toFixed(4)}`;
  gaugeVal = 0;
  animateGauge(R);

  const rColor = R < 0.25 ? '#16a34a' : R < 0.50 ? '#ca8a04' : '#dc2626';
  $('risk-verdict').textContent = risk.verdict;
  $('risk-verdict').style.color = rColor;
  const act = $('risk-action');
  act.textContent = risk.action;
  act.style.color = rColor;
  act.style.background = R < 0.25 ? '#f0fdf4' : R < 0.50 ? '#fffbeb' : '#fef2f2';
  act.style.border = `1px solid ${R < 0.25 ? '#86efac' : R < 0.50 ? '#fcd34d' : '#fca5a5'}`;

  const reasonsEl = $('risk-reasons');
  reasonsEl.textContent = risk.reasons && risk.reasons.length > 0 ? risk.reasons.join('；') : '';

  if (R >= 0.25 && risk.reasons && risk.reasons.length > 0) {
    $('alert-title').textContent = R >= 0.50 ? '高风险提示' : '中风险提示';
    $('alert-body').textContent = risk.reasons.join('；');
    $('alert-banner').classList.add('show');
  } else {
    $('alert-banner').classList.remove('show');
  }

  renderEffect(data);
  $('results-area').style.display = 'block';
  $('status-text').textContent = 'COMPLETE';
  $('status-dot').style.background = '#16a34a';
}

let isComposing = false;
const inputEl = $('query-input');
inputEl.addEventListener('compositionstart', () => { isComposing = true; });
inputEl.addEventListener('compositionend', () => { isComposing = false; });
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !isComposing) {
    e.preventDefault();
    runAnalyze();
  }
});
$('model-select').addEventListener('change', updateModelNote);
$('custom-enabled').addEventListener('change', updateCustomPanel);
[
  'custom-provider',
  'custom-label',
  'custom-base-url',
  'custom-model',
  'custom-risk-bias',
  'custom-completion-mode',
].forEach(id => $(id).addEventListener('input', updateModelNote));

window.addEventListener('load', () => {
  drawGauge(0);
  loadStatus();
  updateCustomPanel();
});
window.addEventListener('resize', drawChart);
