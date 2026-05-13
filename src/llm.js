async function generateAnswer(query, retrievedChunks, config) {
  const { apiKey, baseUrl, llmModel } = config;

  if (!apiKey) {
    throw Object.assign(new Error('缺少 API Key，无法调用真实大模型。'), { code: 'MISSING_API_KEY' });
  }
  if (!llmModel) {
    throw Object.assign(new Error('缺少 LLM_MODEL，无法确定使用哪个模型。'), { code: 'MISSING_MODEL' });
  }

  let context;
  if (retrievedChunks.length === 0) {
    context = '【注意：没有找到与该问题相关的本地或外部证据。】';
  } else {
    context = retrievedChunks
      .map((c, i) => `[证据${i + 1}] (来源: ${c.source}, 相关度: ${c.score})\n${c.text}`)
      .join('\n\n---\n\n');
  }

  const systemPrompt = [
    '你是一个基于检索证据回答问题的助手。',
    '优先依据提供的检索资料回答。',
    '如果资料不足、互相冲突或无法支持确定结论，必须明确说明“不确定”以及缺少哪些证据。',
    '不要把没有证据支持的推断包装成确定事实。',
  ].join('');
  const userPrompt = `问题：${query}\n\n检索资料：\n${context}`;

  if (config.completionMode) {
    return generateCompletionAnswer(query, context, config);
  }

  const baseRequestBody = {
    model: llmModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
  };

  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  console.log(`[llm] 请求模型: ${llmModel}, URL: ${url}`);
  const startTime = Date.now();

  let resp = await requestChatCompletion(url, apiKey, {
    ...baseRequestBody,
    logprobs: true,
    top_logprobs: 5,
  });

  if (!resp.ok && await shouldRetryWithoutLogprobs(resp)) {
    console.log('[llm] 当前接口可能不支持 logprobs，改为不带 logprobs 重试');
    resp = await requestChatCompletion(url, apiKey, baseRequestBody);
  }

  const elapsed = Date.now() - startTime;
  console.log(`[llm] 模型响应耗时: ${elapsed}ms, 状态: ${resp.status}`);

  if (!resp.ok) {
    const errText = await resp.text();
    throw Object.assign(
      new Error(`LLM API 错误 (${resp.status}): ${errText}`),
      { code: 'LLM_API_ERROR' },
    );
  }

  const data = await resp.json();
  const choice = data.choices && data.choices[0];
  if (!choice) {
    throw Object.assign(new Error('LLM 返回数据格式异常，缺少 choices。'), { code: 'LLM_RESPONSE_ERROR' });
  }

  const answer = choice.message?.content || '';
  let tokens = [];
  let logprobsAvailable = false;

  if (choice.logprobs && choice.logprobs.content && choice.logprobs.content.length > 0) {
    logprobsAvailable = true;
    console.log(`[llm] logprobs 已返回，token 数量: ${choice.logprobs.content.length}`);

    tokens = choice.logprobs.content.map(item => {
      const topLp = item.top_logprobs || [];
      return {
        text: item.token,
        logprob: item.logprob,
        topLogprobs: topLp.map(t => ({ token: t.token, logprob: t.logprob })),
      };
    });
  } else {
    console.log('[llm] 当前模型未返回 token logprobs');
  }

  return {
    answer,
    tokens,
    logprobsAvailable,
    model: llmModel,
    elapsed,
  };
}

async function generateCompletionAnswer(query, context, config) {
  const { apiKey, baseUrl, llmModel } = config;
  const prompt = [
    '你是一个基于检索证据回答问题的助手。',
    '优先依据提供的检索资料回答。',
    '如果资料不足、互相冲突或无法支持确定结论，必须明确说明“不确定”以及缺少哪些证据。',
    '',
    `问题：${query}`,
    '',
    `检索资料：\n${context}`,
    '',
    '回答：',
  ].join('\n');

  const url = `${baseUrl.replace(/\/+$/, '')}/completions`;
  console.log(`[llm] 请求 completion 模型: ${llmModel}, URL: ${url}`);
  const startTime = Date.now();

  const resp = await requestCompletion(url, apiKey, {
    model: llmModel,
    prompt,
    temperature: 0.2,
    max_tokens: 800,
    logprobs: 5,
  });

  const elapsed = Date.now() - startTime;
  console.log(`[llm] completion 响应耗时: ${elapsed}ms, 状态: ${resp.status}`);

  if (!resp.ok) {
    const errText = await resp.text();
    throw Object.assign(
      new Error(`Completion API 错误 (${resp.status}): ${errText}`),
      { code: 'LLM_API_ERROR' },
    );
  }

  const data = await resp.json();
  const choice = data.choices && data.choices[0];
  if (!choice) {
    throw Object.assign(new Error('Completion 返回数据格式异常，缺少 choices。'), { code: 'LLM_RESPONSE_ERROR' });
  }

  const answer = choice.text || '';
  const lp = choice.logprobs || {};
  const tokenTexts = lp.tokens || [];
  const tokenLogprobs = lp.token_logprobs || [];
  const topLogprobs = lp.top_logprobs || [];
  const displayTokens = buildDisplayTokens(answer, tokenTexts.length);
  const tokens = tokenTexts.map((token, i) => ({
    text: displayTokens[i] || normalizeTokenText(token),
    logprob: Number.isFinite(tokenLogprobs[i]) ? tokenLogprobs[i] : 0,
    topLogprobs: topLogprobs[i]
      ? Object.entries(topLogprobs[i]).map(([tok, logprob]) => ({ token: tok, logprob }))
      : [],
  }));

  return {
    answer,
    tokens,
    logprobsAvailable: tokens.length > 0,
    model: llmModel,
    elapsed,
  };
}

function normalizeTokenText(token) {
  const text = String(token || '');
  if (!text) return '';
  const visible = text.replace(/\s+/g, '');
  const latin1Mojibake = /[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîï]/.test(text);
  const replacementNoise = /�/.test(text);
  if (latin1Mojibake || replacementNoise) return '·';
  if (visible.length > 8 && !/[\u4e00-\u9fff]/.test(visible)) return '·';
  return text;
}

function buildDisplayTokens(answer, count) {
  if (!answer || count <= 0) return [];
  const chars = Array.from(answer);
  if (chars.length === 0) return [];
  const pieces = [];
  let prev = 0;
  for (let i = 0; i < count; i++) {
    const next = Math.round(((i + 1) * chars.length) / count);
    const piece = chars.slice(prev, Math.max(prev + 1, next)).join('');
    pieces.push(piece);
    prev = Math.max(prev + 1, next);
    if (prev >= chars.length) {
      for (let j = i + 1; j < count; j++) pieces.push('');
      break;
    }
  }
  return pieces;
}

async function requestChatCompletion(url, apiKey, requestBody) {
  const maxRetries = 2;
  let resp;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return resp;
    } catch (err) {
      console.error(`[llm] 第 ${attempt + 1} 次请求失败: ${err.message}`);
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  return resp;
}

async function requestCompletion(url, apiKey, requestBody) {
  const maxRetries = 2;
  let resp;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return resp;
    } catch (err) {
      console.error(`[llm] completion 第 ${attempt + 1} 次请求失败: ${err.message}`);
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  return resp;
}

async function shouldRetryWithoutLogprobs(resp) {
  if (resp.ok) return false;
  if (![400, 422].includes(resp.status)) return false;
  const body = await resp.clone().text().catch(() => '');
  return /logprobs|top_logprobs|unsupported|not support|unknown parameter/i.test(body);
}

module.exports = { generateAnswer };
