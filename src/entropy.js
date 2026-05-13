function softmax(logits) {
  const maxL = Math.max(...logits);
  const exps = logits.map(l => Math.exp(l - maxL));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sum);
}

function normalizedEntropy(probs) {
  const n = probs.length;
  if (n <= 1) return 0;
  let h = 0;
  for (const p of probs) {
    if (p > 1e-10) h -= p * Math.log(p);
  }
  return h / Math.log(n);
}

function tokenizePrompt(text) {
  const raw = String(text || '').trim();
  const terms = [];
  const eng = raw.toLowerCase().match(/[a-z0-9_]+/g);
  if (eng) terms.push(...eng);

  const chineseRuns = raw.match(/[\u4e00-\u9fff]+/g);
  if (chineseRuns) {
    for (const run of chineseRuns) {
      for (let i = 0; i < run.length; i++) terms.push(run[i]);
      for (let i = 0; i < run.length - 1; i++) terms.push(run[i] + run[i + 1]);
    }
  }
  return terms.filter(Boolean);
}

function shannonFromCounts(items) {
  if (!items.length) return { entropy: 0, distinct: 0 };
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  const total = items.length;
  const probs = [...counts.values()].map(c => c / total);
  return {
    entropy: normalizedEntropy(probs),
    distinct: counts.size,
  };
}

function hasAny(text, terms) {
  return terms.some(term => term.test ? term.test(text) : text.includes(term));
}

function computePromptEntropy(query) {
  const raw = String(query || '').trim();
  const tokens = tokenizePrompt(raw);
  const chars = [...raw.replace(/\s+/g, '')];
  const tokenStats = shannonFromCounts(tokens);
  const charStats = shannonFromCounts(chars);
  const lexicalEntropy = (tokenStats.entropy * 0.65) + (charStats.entropy * 0.35);

  const isQuestion = /[?\uFF1F\u5417\u5462\u4E48]$/.test(raw) ||
    hasAny(raw, [
      '\u80FD\u4E0D\u80FD', '\u662F\u5426', '\u53EF\u4E0D\u53EF\u4EE5',
      '\u662F\u4E0D\u662F', '\u9700\u8981', '\u5982\u4F55',
      '\u600E\u4E48', '\u54EA\u4E9B', '\u4E3A\u4EC0\u4E48',
    ]);
  const hasSubject = hasAny(raw, [
    /\u706B\u661F\u6B96\u6C11/, /\u533B\u4FDD/, /\u62A5\u9500/, /AI\u82AF\u7247/i,
    /\u82AF\u7247/, /\u5929\u6C14/, /\u5F02\u5730\u5C31\u533B/,
    /\u91CF\u5B50\u8BA1\u7B97/, /\u533B\u7597/, /\u6A21\u578B/, /api/i,
    /\u5927\u6A21\u578B/, /\u8054\u7F51\u641C\u7D22/,
  ]);
  const hasIntent = hasAny(raw, [
    /\u8D5A\u94B1/, /\u76C8\u5229/, /\u6536\u76CA/, /\u62A5\u9500/, /\u8FDB\u5C55/,
    /\u9700\u8981/, /\u80FD\u4E0D\u80FD/, /\u53EF\u4EE5/, /\u662F\u5426/,
    /\u98CE\u9669/, /\u6750\u6599/, /\u6700\u65B0/, /\u67E5\u8BE2/,
    /\u641C\u7D22/, /\u652F\u6301/, /\u8FD4\u56DE/,
  ]);
  const hasTimeScope = hasAny(raw, [
    /\u73B0\u5728/, /\u76EE\u524D/, /202[0-9]\u5E74/, /\u4ECA\u5E74/,
    /\u6700\u65B0/, /\u5B9E\u65F6/, /\u4E94\u6708/, /5\u6708/,
    /today/i, /current/i, /latest/i,
  ]);
  const vagueTerms = [
    '\u8FD9\u4E2A', '\u90A3\u4E2A', '\u5B83', '\u4E1C\u897F',
    '\u968F\u4FBF', '\u600E\u4E48\u5F04', '\u548B\u529E',
    '\u54EA\u4E2A\u597D', '\u80FD\u884C\u5417',
  ];
  const ambiguityHits = vagueTerms.filter(term => raw.includes(term)).length;

  const asksBusinessFeasibility = hasAny(raw, [
    /\u8D5A\u94B1/, /\u76C8\u5229/, /\u6536\u76CA/, /\u5546\u4E1A\u5316/,
    /profit/i, /business/i,
  ]);
  const hasBusinessSpecifics = hasAny(raw, [
    /\u6210\u672C/, /\u6536\u5165/, /\u6295\u8D44/, /\u8FD0\u8F93/,
    /\u5408\u540C/, /\u5E02\u573A/, /\u5468\u671F/, /\u91D1\u989D/,
    /\u5546\u4E1A\u6A21\u5F0F/, /cost/i, /revenue/i, /market/i,
  ]);

  const lengthPenalty = raw.length < 4 ? 0.55 : raw.length < 8 ? 0.25 : 0;
  const missingSubjectPenalty = hasSubject ? 0 : 0.22;
  const missingIntentPenalty = hasIntent ? 0 : 0.18;
  const ambiguityPenalty = Math.min(0.4, ambiguityHits * 0.18);
  const businessFeasibilityPenalty = asksBusinessFeasibility && !hasBusinessSpecifics ? 0.45 : 0;
  const questionBonus = isQuestion ? 0.08 : 0;
  const timeBonus = hasTimeScope ? 0.03 : 0;

  const uncertainty = Math.max(
    0,
    lengthPenalty +
      missingSubjectPenalty +
      missingIntentPenalty +
      ambiguityPenalty +
      businessFeasibilityPenalty -
      questionBonus -
      timeBonus,
  );
  const hPrompt = parseFloat(Math.min(1, uncertainty).toFixed(4));
  const promptRisk = parseFloat(Math.min(
    1,
    hPrompt * 0.9 + Math.max(0, 0.55 - lexicalEntropy) * 0.1,
  ).toFixed(4));

  let label = '\u8F93\u5165\u8F83\u6E05\u6670';
  if (promptRisk > 0.55) label = '\u8F93\u5165\u8F83\u542B\u7CCA';
  else if (promptRisk > 0.25) label = '\u8F93\u5165\u4E00\u822C';

  return {
    hPrompt,
    promptRisk,
    label,
    length: raw.length,
    tokenCount: tokens.length,
    distinctTerms: tokenStats.distinct,
    ambiguityHits,
    lexicalEntropy: parseFloat(lexicalEntropy.toFixed(4)),
  };
}

function computeRetrievalEntropy(scores) {
  if (scores.length === 0) return { hret: 1, probs: [] };
  if (scores.length === 1) return { hret: 0, probs: [1.0] };

  const maxS = Math.max(...scores);
  const minS = Math.min(...scores);
  const range = maxS - minS;
  const normalized = range > 1e-10
    ? scores.map(s => (s - minS) / range)
    : scores.map(() => 1 / scores.length);

  const tau = 0.15;
  const logits = normalized.map(s => s / tau);
  const probs = softmax(logits);
  const hret = normalizedEntropy(probs);

  return {
    hret: parseFloat(hret.toFixed(4)),
    probs: probs.map(p => parseFloat(p.toFixed(4))),
  };
}

function computeOutputEntropy(tokens) {
  if (!tokens || tokens.length === 0) {
    return { hans: 0, isStrictEntropy: false, tokenDetails: [] };
  }

  const hasTopLogprobs = tokens.some(t => t.topLogprobs && t.topLogprobs.length > 1);

  if (hasTopLogprobs) {
    const tokenDetails = tokens.map(t => {
      if (!t.topLogprobs || t.topLogprobs.length <= 1) {
        return { text: t.text, logprob: t.logprob, entropy: 0, risk: 'safe' };
      }
      const lps = t.topLogprobs.map(x => x.logprob);
      const probs = softmax(lps);
      const entropy = normalizedEntropy(probs);
      let risk = 'safe';
      if (entropy > 0.90) risk = 'danger';
      else if (entropy > 0.80) risk = 'risky';
      else if (entropy > 0.65) risk = 'uncertain';
      return {
        text: t.text,
        logprob: t.logprob,
        entropy: parseFloat(entropy.toFixed(4)),
        risk,
        topLogprobs: t.topLogprobs,
      };
    });

    const avgEntropy = tokenDetails.reduce((sum, t) => sum + t.entropy, 0) / tokenDetails.length;
    return {
      hans: parseFloat(avgEntropy.toFixed(4)),
      isStrictEntropy: true,
      tokenDetails,
    };
  }

  const tokenDetails = tokens.map(t => {
    const negLogp = -t.logprob;
    let risk = 'safe';
    if (negLogp > 3) risk = 'danger';
    else if (negLogp > 2) risk = 'risky';
    else if (negLogp > 1) risk = 'uncertain';
    return {
      text: t.text,
      logprob: t.logprob,
      entropy: parseFloat(negLogp.toFixed(4)),
      risk,
    };
  });
  const avgNegLogprob = tokenDetails.reduce((sum, t) => sum + t.entropy, 0) / tokenDetails.length;
  return {
    hans: parseFloat(avgNegLogprob.toFixed(4)),
    isStrictEntropy: false,
    tokenDetails,
  };
}

module.exports = {
  computePromptEntropy,
  computeRetrievalEntropy,
  computeOutputEntropy,
  softmax,
  normalizedEntropy,
};
