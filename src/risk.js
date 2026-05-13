async function assessConflictAndSensitivity(chunks, config) {
  const { apiKey, baseUrl, llmModel } = config;

  if (!apiKey || !llmModel || chunks.length === 0) {
    return {
      conflict: 0,
      sensitive: 0,
      reasons: ['未进行冲突/敏感性检测：缺少 API 配置或没有检索到可分析的证据。'],
    };
  }

  const docsText = chunks
    .map((c, i) => `[文档${i + 1}] (来源: ${c.source})\n${c.text}`)
    .join('\n\n---\n\n');

  const prompt = `请分析下面检索到的文档片段，判断它们之间是否存在口径矛盾、事实冲突或适用条件冲突，并判断是否包含高风险敏感信息。

你只返回 JSON，不要输出其他文字：
{
  "conflict": <0 到 1 之间的浮点数，0 表示无冲突，1 表示严重冲突>,
  "sensitive": <0 到 1 之间的浮点数，0 表示无敏感信息，1 表示高度敏感>,
  "reasons": ["用简短中文说明风险原因"]
}

评估标准：
- conflict 高：不同文档给出互斥结论、政策条件不一致、时间版本混杂但未区分。
- sensitive 高：涉及身份信息、账号密钥、具体金额、医疗/医保等需要谨慎确认的高影响决策。
- 如果只是普通知识说明且来源一致，分数应较低。

文档片段：
${docsText}`;

  try {
    let resp;
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        resp = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: llmModel,
            messages: [
              {
                role: 'system',
                content: '你是文档冲突分析和敏感信息识别助手。只返回调用方要求的 JSON。',
              },
              { role: 'user', content: prompt },
            ],
            temperature: 0,
            response_format: { type: 'json_object' },
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        break;
      } catch (fetchErr) {
        console.error(`[risk] 冲突检测第 ${attempt + 1} 次请求失败: ${fetchErr.message}`);
        if (attempt === 1) throw fetchErr;
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (!resp.ok) {
      console.error(`[risk] 冲突检测 API 调用失败: ${resp.status}`);
      return { conflict: 0, sensitive: 0, reasons: ['冲突检测 API 调用失败。'] };
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '{}';

    let result;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      result = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    } catch (parseErr) {
      console.error('[risk] 无法解析冲突检测结果:', content);
      return { conflict: 0, sensitive: 0, reasons: ['冲突检测结果解析失败。'] };
    }

    return {
      conflict: Math.min(1, Math.max(0, parseFloat(result.conflict) || 0)),
      sensitive: Math.min(1, Math.max(0, parseFloat(result.sensitive) || 0)),
      reasons: Array.isArray(result.reasons) ? result.reasons : [],
    };
  } catch (err) {
    console.error('[risk] 冲突检测异常:', err.message);
    return { conflict: 0, sensitive: 0, reasons: [`冲突检测异常：${err.message}`] };
  }
}

/**
 * Amplify: map [0, cap] to [0, 1] with power curve
 */
function amplify(value, cap, power) {
  const clamped = Math.min(value, cap) / cap;
  return Math.pow(clamped, power);
}

/**
 * Compute risk score with non-linear scaling
 * Raw H_ans ~0.02-0.12, H_ret ~0-0.40 from DeepSeek
 * These need amplification to produce meaningful risk differentiation
 */
function computeRiskScore(hans, hret, conflict, sensitive, chunkCount, modelBias = 0, promptRisk = 0) {
  // Scale H_prompt / prompt risk: 0.30=uncertain, 0.60+=very vague
  const scaledPrompt = amplify(promptRisk, 0.80, 1.2);

  // Scale H_ans: 0.03=safe, 0.06=uncertain, 0.10+=risky
  const scaledHans = amplify(hans, 0.12, 1.2);

  // Scale H_ret: 0.05=focused, 0.20=scattered, 0.40+=very scattered
  const scaledHret = amplify(hret, 0.50, 1.2);

  // No-retrieval penalty: model answering without any evidence
  const noRetrievalPenalty = (chunkCount === 0) ? 0.6 : 0;

  const evidenceRisk = Math.max(scaledHret, noRetrievalPenalty);
  const clampedModelBias = Math.min(0.25, Math.max(0, Number(modelBias) || 0));
  const clampedPromptRisk = Math.min(1, Math.max(0, Number(promptRisk) || 0));
  const R = 0.22 * scaledHans + 0.23 * evidenceRisk + 0.10 * scaledPrompt + 0.28 * conflict + 0.17 * sensitive + clampedModelBias;
  const score = parseFloat(Math.min(1, R).toFixed(4));

  let verdict, action;
  if (score < 0.25) {
    verdict = '\u4F4E\u98CE\u9669';
    action = '\u6B63\u5E38\u8F93\u51FA';
  } else if (score < 0.50) {
    verdict = '\u4E2D\u98CE\u9669';
    action = '\u63D0\u793A\u8BC1\u636E\u4E0D\u8DB3\u6216\u6765\u6E90\u51B2\u7A81\uFF0C\u5EFA\u8BAE\u4E8C\u6B21\u786E\u8BA4';
  } else {
    verdict = '\u9AD8\u98CE\u9669';
    action = '\u5EFA\u8BAE\u62E6\u622A\u6216\u8FDB\u5165\u4EBA\u5DE5\u590D\u6838';
  }

  return {
    score,
    verdict,
    action,
    scaledPrompt,
    scaledHans,
    scaledHret,
    noRetrievalPenalty,
    modelBias: clampedModelBias,
    promptRisk: clampedPromptRisk,
  };
}

module.exports = { assessConflictAndSensitivity, computeRiskScore };
