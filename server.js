require('dotenv').config();

const express = require('express');
const path = require('path');
const dns = require('dns');
const { loadCorpus } = require('./src/corpus');
const { retrieve } = require('./src/retrieval');
const { generateAnswer } = require('./src/llm');
const { computePromptEntropy, computeRetrievalEntropy, computeOutputEntropy } = require('./src/entropy');
const { assessConflictAndSensitivity, computeRiskScore } = require('./src/risk');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

dns.setServers(['8.8.8.8', '1.1.1.1']);

function envBool(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return String(value).toLowerCase() !== 'false';
}

function parseExtraModelPresets() {
  if (!process.env.MODEL_PRESETS_JSON) return [];
  try {
    const presets = JSON.parse(process.env.MODEL_PRESETS_JSON);
    return Array.isArray(presets) ? presets : [];
  } catch (err) {
    console.error(`[config] MODEL_PRESETS_JSON parse failed: ${err.message}`);
    return [];
  }
}

function buildModelPresets() {
  const deepSeekKey = process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || '';
  const siliconFlowKey = process.env.SILICONFLOW_API_KEY || '';
  const deepSeekBaseUrl = (process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');

  const presets = [
    {
      id: 'deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      provider: 'DeepSeek',
      baseUrl: deepSeekBaseUrl,
      apiKey: deepSeekKey,
      model: 'deepseek-v4-flash',
      riskBias: 0,
    },
    {
      id: 'deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      provider: 'DeepSeek',
      baseUrl: deepSeekBaseUrl,
      apiKey: deepSeekKey,
      model: 'deepseek-v4-pro',
      riskBias: 0,
    },
    {
      id: 'deepseek-chat-legacy',
      label: 'DeepSeek Chat 兼容名',
      provider: 'DeepSeek',
      baseUrl: deepSeekBaseUrl,
      apiKey: deepSeekKey,
      model: process.env.LLM_MODEL || 'deepseek-chat',
      riskBias: 0.02,
    },
    {
      id: 'siliconflow-qwen25-7b',
      label: 'SiliconFlow Qwen2.5-7B',
      provider: 'SiliconFlow',
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: siliconFlowKey,
      model: 'Qwen/Qwen2.5-7B-Instruct',
      riskBias: 0.18,
      completionMode: true,
    },
    {
      id: 'siliconflow-glm4-9b',
      label: 'SiliconFlow GLM-4-9B',
      provider: 'SiliconFlow',
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: siliconFlowKey,
      model: 'THUDM/GLM-4-9B-0414',
      riskBias: 0.17,
      completionMode: true,
    },
    {
      id: 'siliconflow-qwen3-14b',
      label: 'SiliconFlow Qwen3-14B',
      provider: 'SiliconFlow',
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: siliconFlowKey,
      model: 'Qwen/Qwen3-14B',
      riskBias: 0.14,
      completionMode: true,
    },
    ...parseExtraModelPresets().map(p => ({
      id: p.id,
      label: p.label || p.id,
      provider: p.provider || 'Custom',
      baseUrl: String(p.baseUrl || '').replace(/\/+$/, ''),
      apiKey: process.env[p.apiKeyEnv || ''] || p.apiKey || '',
      model: p.model,
      riskBias: Number(p.riskBias || 0),
    })),
  ].filter(p => p.id && p.baseUrl && p.model);

  const deduped = [];
  const seen = new Set();
  for (const preset of presets) {
    if (seen.has(preset.id)) continue;
    seen.add(preset.id);
    deduped.push(preset);
  }
  return deduped;
}

const MODEL_PRESETS = buildModelPresets();
const DEFAULT_MODEL_ID = process.env.DEFAULT_MODEL_ID ||
  MODEL_PRESETS.find(p => p.model === process.env.LLM_MODEL)?.id ||
  'deepseek-v4-flash';

const CONFIG = {
  embeddingModel: process.env.EMBEDDING_MODEL || '',
  webSearchEnabled: envBool('WEB_SEARCH_ENABLED', true),
  allowCustomModels: envBool('ALLOW_CUSTOM_MODELS', true),
  bingSearchApiKey: process.env.BING_SEARCH_API_KEY || '',
  serperApiKey: process.env.SERPER_API_KEY || '',
};

const PORT = parseInt(process.env.PORT, 10) || 5177;
const CORPUS_DIRS = (process.env.CORPUS_DIRS || './corpus').split(',').map(d => d.trim());

function publicModelPreset(preset) {
  return {
    id: preset.id,
    label: preset.label,
    provider: preset.provider,
    model: preset.model,
    configured: !!preset.apiKey,
    riskBias: preset.riskBias,
    completionMode: !!preset.completionMode,
  };
}

function resolveModelPreset(modelId) {
  return MODEL_PRESETS.find(p => p.id === modelId) ||
    MODEL_PRESETS.find(p => p.id === DEFAULT_MODEL_ID) ||
    MODEL_PRESETS[0];
}

function resolveRunModel(body) {
  const custom = body.customModel;
  if (custom && custom.enabled) {
    if (!CONFIG.allowCustomModels) {
      return {
        error: {
          code: 'CUSTOM_MODELS_DISABLED',
          message: '当前部署已关闭临时自定义模型输入。',
        },
      };
    }
    const baseUrl = String(custom.baseUrl || '').trim().replace(/\/+$/, '');
    const apiKey = String(custom.apiKey || '').trim();
    const model = String(custom.model || '').trim();
    if (!baseUrl || !apiKey || !model) {
      return {
        error: {
          code: 'INVALID_CUSTOM_MODEL',
          message: '自定义模型需要填写 base URL、API key 和 model。',
        },
      };
    }
    return {
      model: {
        id: 'custom-runtime',
        label: String(custom.label || model).trim() || model,
        provider: String(custom.provider || 'Custom').trim() || 'Custom',
        baseUrl,
        apiKey,
        model,
        riskBias: Math.min(0.25, Math.max(0, Number(custom.riskBias) || 0)),
        completionMode: !!custom.completionMode || /siliconflow/i.test(`${custom.provider || ''} ${baseUrl}`),
      },
    };
  }
  return { model: resolveModelPreset(body.modelId) };
}

console.log('========================================');
console.log('  Entropy Risk Radar - backend started');
console.log('========================================');
console.log(`[config] Default Model: ${DEFAULT_MODEL_ID}`);
console.log(`[config] Model Presets: ${MODEL_PRESETS.map(p => `${p.id}${p.apiKey ? '' : '(no-key)'}`).join(', ')}`);
console.log(`[config] Embedding Model: ${CONFIG.embeddingModel || 'not configured, using BM25'}`);
console.log(`[config] Web Search: ${CONFIG.webSearchEnabled ? 'enabled' : 'disabled'}`);
console.log(`[config] Serper API: ${CONFIG.serperApiKey ? 'configured' : 'not configured'}`);
console.log(`[config] Bing Search API: ${CONFIG.bingSearchApiKey ? 'configured' : 'not configured'}`);
console.log(`[config] Corpus Dirs: ${CORPUS_DIRS.join(', ')}`);

let corpus = [];
try {
  corpus = loadCorpus(CORPUS_DIRS);
} catch (err) {
  console.error('[startup] Failed to load corpus:', err.message);
}

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    config: {
      defaultModelId: DEFAULT_MODEL_ID,
      modelPresets: MODEL_PRESETS.map(publicModelPreset),
      embeddingModel: CONFIG.embeddingModel || null,
      webSearchEnabled: CONFIG.webSearchEnabled,
      allowCustomModels: CONFIG.allowCustomModels,
      serperConfigured: !!CONFIG.serperApiKey,
      bingSearchConfigured: !!CONFIG.bingSearchApiKey,
    },
    corpus: {
      totalChunks: corpus.length,
      dirs: CORPUS_DIRS,
    },
  });
});

app.post('/api/analyze', async (req, res) => {
  const startTime = Date.now();
  const { query, topK = 5 } = req.body;
  const resolved = resolveRunModel(req.body);
  const selectedModel = resolved.model;

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return res.json({ ok: false, error: { code: 'INVALID_QUERY', message: '请提供有效的问题。' } });
  }
  if (resolved.error) {
    return res.json({ ok: false, error: resolved.error });
  }
  if (!selectedModel) {
    return res.json({ ok: false, error: { code: 'NO_MODEL_PRESET', message: '没有可用的模型预设。' } });
  }
  if (!selectedModel.apiKey) {
    return res.json({
      ok: false,
      error: {
        code: 'MISSING_MODEL_KEY',
        message: `模型 ${selectedModel.label} 缺少 API Key。请在 .env 中配置对应密钥后重启服务。`,
      },
    });
  }
  if (corpus.length === 0) {
    return res.json({ ok: false, error: { code: 'EMPTY_CORPUS', message: '知识库为空，请在 corpus/ 目录添加 Markdown 文档。' } });
  }

  const runConfig = {
    apiKey: selectedModel.apiKey,
    baseUrl: selectedModel.baseUrl,
    llmModel: selectedModel.model,
    completionMode: !!selectedModel.completionMode,
    embeddingModel: CONFIG.embeddingModel,
    webSearchEnabled: CONFIG.webSearchEnabled,
    bingSearchApiKey: CONFIG.bingSearchApiKey,
    serperApiKey: CONFIG.serperApiKey,
  };

  try {
    console.log('\n[analyze] ======= New request =======');
    console.log(`[analyze] Query: ${query}`);
    console.log(`[analyze] Model: ${selectedModel.id} -> ${selectedModel.model}`);

    const promptEntropy = computePromptEntropy(query);
    console.log(`[analyze] H_prompt = ${promptEntropy.hPrompt}, promptRisk = ${promptEntropy.promptRisk}`);

    const retrievalResult = await retrieve(query, corpus, topK, runConfig);
    const retrievedChunks = retrievalResult.chunks;
    console.log(`[analyze] Retrieval mode: ${retrievalResult.mode}, chunks: ${retrievedChunks.length}`);

    const scores = retrievedChunks.map(c => c.score);
    const { hret, probs } = computeRetrievalEntropy(scores);
    console.log(`[analyze] H_ret = ${hret}`);
    retrievedChunks.forEach((c, i) => { c.prob = probs[i] || 0; });

    const llmResult = await generateAnswer(query, retrievedChunks, runConfig);
    console.log(`[analyze] Answer length: ${llmResult.answer.length}, logprobs: ${llmResult.logprobsAvailable}`);

    const outputEntropy = computeOutputEntropy(llmResult.tokens);
    console.log(`[analyze] H_ans = ${outputEntropy.hans}, strictEntropy: ${outputEntropy.isStrictEntropy}`);

    const conflictResult = await assessConflictAndSensitivity(retrievedChunks, runConfig);
    console.log(`[analyze] S_conflict = ${conflictResult.conflict}, S_sensitive = ${conflictResult.sensitive}`);

    const risk = computeRiskScore(
      outputEntropy.hans,
      hret,
      conflictResult.conflict,
      conflictResult.sensitive,
      retrievedChunks.length,
      selectedModel.riskBias,
      promptEntropy.promptRisk,
    );
    console.log(`[analyze] Risk R = ${risk.score}, verdict: ${risk.verdict}`);
    console.log(`[analyze] Total elapsed: ${Date.now() - startTime}ms`);

    res.json({
      ok: true,
      query,
      model: {
        provider: selectedModel.provider,
        baseUrl: selectedModel.baseUrl,
        modelId: selectedModel.id,
        label: selectedModel.label,
        llmModel: selectedModel.model,
        riskBias: selectedModel.riskBias,
        completionMode: !!selectedModel.completionMode,
        embeddingModel: CONFIG.embeddingModel || null,
        webSearchEnabled: CONFIG.webSearchEnabled,
        logprobsAvailable: llmResult.logprobsAvailable,
        elapsed: llmResult.elapsed,
      },
      input: promptEntropy,
      retrieval: {
        mode: retrievalResult.mode,
        hret,
        chunks: retrievedChunks.map(c => ({
          id: c.id,
          source: c.source,
          text: c.text,
          score: c.score,
          prob: c.prob,
        })),
      },
      generation: {
        answer: llmResult.answer,
        hans: outputEntropy.hans,
        isStrictEntropy: outputEntropy.isStrictEntropy,
        tokens: outputEntropy.tokenDetails.map(t => ({
          text: t.text,
          logprob: t.logprob,
          entropy: t.entropy,
          risk: t.risk,
          topLogprobs: t.topLogprobs || [],
        })),
      },
      risk: {
        conflict: conflictResult.conflict,
        sensitive: conflictResult.sensitive,
        promptRisk: risk.promptRisk,
        scaledPrompt: risk.scaledPrompt,
        scaledHret: risk.scaledHret,
        scaledHans: risk.scaledHans,
        modelBias: risk.modelBias,
        score: risk.score,
        verdict: risk.verdict,
        action: risk.action,
        reasons: conflictResult.reasons,
      },
    });
  } catch (err) {
    console.error('[analyze] Error:', err);
    res.json({
      ok: false,
      error: {
        code: err.code || 'INTERNAL_ERROR',
        message: err.message || '未知服务端错误。',
      },
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n服务已启动: http://localhost:${PORT}`);
  console.log(`API 端点: POST http://localhost:${PORT}/api/analyze`);
  console.log(`状态检查: GET  http://localhost:${PORT}/api/status\n`);
});
