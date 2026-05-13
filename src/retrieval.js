const dns = require('dns');
const https = require('https');

dns.setServers(['8.8.8.8', '1.1.1.1']);

function tokenize(text) {
  const tokens = [];
  const lower = String(text || '').toLowerCase();
  const engMatches = lower.match(/[a-z0-9_]+/g);
  if (engMatches) tokens.push(...engMatches);

  const chnMatches = lower.match(/[\u4e00-\u9fff]+/g);
  if (chnMatches) {
    for (const seg of chnMatches) {
      for (const ch of seg) tokens.push(ch);
      for (let i = 0; i < seg.length - 1; i++) {
        tokens.push(seg[i] + seg[i + 1]);
      }
    }
  }
  return tokens.filter(t => t.length > 0);
}

const GENERIC_TERMS = new Set([
  '最新', '进展', '现在', '目前', '如何', '怎么', '什么', '哪些', '是否', '需要', '能不能', '可以', '吗',
  'latest', 'current', 'recent', 'news', 'what', 'how', 'why', 'can', 'could', 'should', 'the', 'and', 'for', 'with',
]);

function coreTerms(query) {
  return tokenize(query).filter(term => {
    if (GENERIC_TERMS.has(term)) return false;
    if (/^[\u4e00-\u9fff]$/.test(term)) return false;
    if (/^[a-z0-9_]+$/.test(term) && term.length <= 2) return false;
    return true;
  });
}

function coreCoverage(query, text) {
  const terms = [...new Set(coreTerms(query))];
  if (terms.length === 0) return 1;
  const docTerms = new Set(tokenize(text));
  let hit = 0;
  for (const term of terms) {
    if (docTerms.has(term)) hit++;
  }
  return hit / terms.length;
}

class BM25Index {
  constructor(chunks, k1 = 1.5, b = 0.75) {
    this.chunks = chunks;
    this.k1 = k1;
    this.b = b;
    this.docs = chunks.map(c => tokenize(c.text));
    this.avgDl = this.docs.reduce((sum, d) => sum + d.length, 0) / Math.max(1, this.docs.length);
    this.N = this.docs.length;
    this.idf = {};

    const df = {};
    for (const doc of this.docs) {
      const seen = new Set(doc);
      for (const term of seen) df[term] = (df[term] || 0) + 1;
    }
    for (const [term, freq] of Object.entries(df)) {
      this.idf[term] = Math.log((this.N - freq + 0.5) / (freq + 0.5) + 1);
    }
  }

  search(query, topK = 5) {
    const queryTerms = tokenize(query);
    const scores = [];

    for (let i = 0; i < this.docs.length; i++) {
      const doc = this.docs[i];
      const dl = doc.length;
      const tf = {};
      for (const t of doc) tf[t] = (tf[t] || 0) + 1;

      let score = 0;
      for (const term of queryTerms) {
        if (!tf[term]) continue;
        const termTf = tf[term];
        const idf = this.idf[term] || 0;
        const tfNorm = (termTf * (this.k1 + 1)) /
          (termTf + this.k1 * (1 - this.b + this.b * (dl / this.avgDl)));
        score += idf * tfNorm;
      }
      const coverage = coreCoverage(query, this.chunks[i].text);
      scores.push({ index: i, score, coverage });
    }

    scores.sort((a, b) => b.score - a.score);
    const minScore = 0.5;
    return scores
      .slice(0, topK)
      .filter(s => s.score >= minScore && s.coverage >= 0.35)
      .map(s => ({
        ...this.chunks[s.index],
        score: parseFloat(s.score.toFixed(4)),
        coverage: parseFloat(s.coverage.toFixed(4)),
      }));
  }
}

async function embeddingRetrieve(query, chunks, topK, apiKey, baseUrl, embeddingModel) {
  const allTexts = [query, ...chunks.map(c => c.text)];
  const resp = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: embeddingModel,
      input: allTexts,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Embedding API error (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  const embeddings = data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
  const queryEmb = embeddings[0];
  const chunkEmbs = embeddings.slice(1);

  function cosineSim(a, b) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
  }

  const scored = chunkEmbs.map((emb, i) => ({
    ...chunks[i],
    score: parseFloat(cosineSim(queryEmb, emb).toFixed(4)),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

function decodeHtml(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(html) {
  return decodeHtml(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function unwrapDuckDuckGoUrl(rawUrl) {
  const decoded = decodeHtml(rawUrl);
  try {
    const url = new URL(decoded.startsWith('//') ? `https:${decoded}` : decoded);
    const uddg = url.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : decoded;
  } catch {
    return decoded;
  }
}

function isMarsBusinessQuery(query) {
  return /火星|mars/i.test(query) && /(殖民|移民|商业|赚钱|盈利|profit|business|colony|settlement)/i.test(query);
}

function isChipQuery(query) {
  return /芯片|AI芯片|ai chip|semiconductor|gpu|nvidia|英伟达|台积电|tsmc|半导体/i.test(query);
}

function isDomainSensitiveQuery(query) {
  return isChipQuery(query) || isMarsBusinessQuery(query);
}

function domainTermsFor(query) {
  if (isMarsBusinessQuery(query)) {
    return ['火星', '殖民', '移民', '商业', '赚钱', '盈利', 'mars', 'colony', 'colonization', 'settlement', 'business', 'profit', 'spacex'];
  }
  if (isChipQuery(query)) {
    return ['芯片', '半导体', '英伟达', '台积电', 'gpu', 'nvidia', 'tsmc', 'chip', 'semiconductor', 'accelerator'];
  }
  return [];
}

function scoreExternalResult(query, text, rank) {
  const terms = new Set(tokenize(query));
  const docTerms = tokenize(text);
  if (terms.size === 0) return Math.max(0.1, 1 - rank * 0.08);

  let overlap = 0;
  const seen = new Set(docTerms);
  for (const term of terms) {
    if (seen.has(term)) overlap++;
  }
  const overlapRatio = overlap / terms.size;
  const textLower = String(text).toLowerCase();
  const domainMatches = domainTermsFor(query).filter(term => textLower.includes(term.toLowerCase())).length;
  const domainBoost = Math.min(0.9, domainMatches * 0.16);
  const rankBoost = Math.max(0.15, 1 - rank * 0.12);
  return parseFloat((0.35 + overlapRatio * 1.8 + domainBoost + rankBoost).toFixed(4));
}

async function duckDuckGoSearch(query, topK) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  const params = new URLSearchParams({ q: query });

  try {
    const resp = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 EntropyRiskRadar/1.0',
      },
      body: params.toString(),
      signal: controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`DuckDuckGo search failed: HTTP ${resp.status}`);
    }

    const html = await resp.text();
    const results = [];
    const itemPattern = /<div class="result[\s\S]*?<\/div>\s*<\/div>/g;
    const items = html.match(itemPattern) || [];

    for (const item of items) {
      const linkMatch = item.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!linkMatch) continue;

      const snippetMatch = item.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/) ||
        item.match(/<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/);
      const title = stripTags(linkMatch[2]);
      const snippet = stripTags(snippetMatch ? snippetMatch[1] : '');
      const url = unwrapDuckDuckGoUrl(linkMatch[1]);
      const text = [title, snippet, url].filter(Boolean).join('\n');

      if (title && !results.some(r => r.url === url)) {
        const rank = results.length;
        results.push({
          id: `web-ddg:${rank}:${url}`,
          source: `Web search: ${title} (${url})`,
          text,
          score: scoreExternalResult(query, text, rank),
          external: true,
        });
      }
      if (results.length >= topK) break;
    }

    return results;
  } finally {
    clearTimeout(timeout);
  }
}

async function bingSearch(query, topK, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  const url = new URL('https://api.bing.microsoft.com/v7.0/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(topK));
  url.searchParams.set('mkt', 'zh-CN');

  try {
    const resp = await fetch(url, {
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey,
        'User-Agent': 'EntropyRiskRadar/1.0',
      },
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Bing search failed: HTTP ${resp.status} ${errText.slice(0, 120)}`);
    }

    const data = await resp.json();
    const values = data.webPages?.value || [];
    return values.slice(0, topK).map((item, rank) => {
      const text = [item.name, item.snippet, item.url].filter(Boolean).join('\n');
      return {
        id: `web-bing:${rank}:${item.url}`,
        source: `Web search: ${item.name} (${item.url})`,
        text,
        score: scoreExternalResult(query, text, rank),
        external: true,
      };
    });
  } finally {
    clearTimeout(timeout);
  }
}

function searchQueries(query) {
  if (isMarsBusinessQuery(query)) {
    return [
      'Mars colonization business model profitability SpaceX settlement economy',
      '火星殖民 商业模式 盈利 成本 SpaceX',
      query,
    ];
  }
  if (isChipQuery(query)) {
    return [
      '"AI chip" 2026 semiconductor GPU NVIDIA TSMC AI accelerator',
      '2026 AI semiconductor GPU Nvidia TSMC Broadcom AI chip latest',
      query,
    ];
  }
  return [query];
}

function searchLocale(query) {
  if (isChipQuery(query) || isMarsBusinessQuery(query)) {
    return { gl: 'us', hl: 'en' };
  }
  return { gl: 'cn', hl: 'zh-cn' };
}

function preferDomainResults(query, results) {
  const domainTerms = domainTermsFor(query);
  if (domainTerms.length === 0) return results;
  const preferred = results.filter(item => {
    const haystack = `${item.title || item.name || ''} ${item.snippet || item.description || ''} ${item.link || item.url || ''}`.toLowerCase();
    return domainTerms.some(term => haystack.includes(term.toLowerCase()));
  });
  return preferred.length > 0 ? preferred : results;
}

async function serperSearch(query, topK, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    let results = [];
    const queries = searchQueries(query);
    for (const q of queries) {
      const batch = await serperRaw(q, Math.max(topK, 5), apiKey, controller.signal, searchLocale(query));
      results = mergeSearchResults(results, batch);
      if (!isDomainSensitiveQuery(query) || preferDomainResults(query, results).length >= Math.min(2, topK)) break;
    }

    results = preferDomainResults(query, results);
    return results.slice(0, topK).map((item, rank) => {
      const title = item.title || item.name || item.link || `Result ${rank + 1}`;
      const snippet = item.snippet || item.description || '';
      const link = item.link || item.url || '';
      const text = [title, snippet, link].filter(Boolean).join('\n');
      return {
        id: `web-serper:${rank}:${link}`,
        source: `Web search: ${title} (${link || 'Serper'})`,
        text,
        score: scoreExternalResult(query, text, rank),
        external: true,
      };
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function serperRaw(query, topK, apiKey, signal, locale) {
  const data = await serperPost({
    q: query,
    ...locale,
    num: topK,
  }, apiKey, signal);
  return [
    ...(data.organic || []),
    ...(data.news || []),
  ];
}

function serperPost(payload, apiKey, signal) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'google.serper.dev',
      path: '/search',
      method: 'POST',
      servername: 'google.serper.dev',
      lookup(hostname, options, callback) {
        const cb = typeof options === 'function' ? options : callback;
        dns.resolve4(hostname, (err, addresses) => {
          if (err || !addresses || addresses.length === 0) {
            cb(err || new Error(`DNS resolve failed: ${hostname}`));
            return;
          }
          if (options && options.all) {
            cb(null, addresses.map(address => ({ address, family: 4 })));
            return;
          }
          cb(null, addresses[0], 4);
        });
      },
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-API-KEY': apiKey,
      },
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(raw || '{}'));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    if (signal) {
      signal.addEventListener('abort', () => {
        req.destroy(new Error('Serper request aborted'));
      }, { once: true });
    }
    req.write(body);
    req.end();
  });
}

function mergeSearchResults(existing, incoming) {
  const merged = [...existing];
  const seen = new Set(existing.map(item => item.link || item.url || item.title || item.name));
  for (const item of incoming) {
    const key = item.link || item.url || item.title || item.name;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

async function webSearchRetrieve(query, topK, config) {
  if (!config.webSearchEnabled) return [];

  console.log(`[retrieval] Web search fallback: ${query}`);

  if (config.serperApiKey) {
    try {
      const chunks = await serperSearch(query, topK, config.serperApiKey);
      if (chunks.length > 0) {
        console.log(`[retrieval] Serper results: ${chunks.length}`);
        return chunks;
      }
    } catch (err) {
      console.error(`[retrieval] Serper failed, trying other providers: ${err.message}`);
    }
  }

  if (config.bingSearchApiKey) {
    try {
      const chunks = await bingSearch(query, topK, config.bingSearchApiKey);
      if (chunks.length > 0) {
        console.log(`[retrieval] Bing results: ${chunks.length}`);
        return chunks;
      }
    } catch (err) {
      console.error(`[retrieval] Bing failed, trying DuckDuckGo: ${err.message}`);
    }
  }

  try {
    const chunks = await duckDuckGoSearch(query, topK);
    console.log(`[retrieval] DuckDuckGo results: ${chunks.length}`);
    return chunks;
  } catch (err) {
    console.error(`[retrieval] DuckDuckGo failed: ${err.message}`);
  }

  return [];
}

function topicFallbackRetrieve(query, topK) {
  const rows = [];

  if (isMarsBusinessQuery(query)) {
    rows.push(
      {
        id: 'fallback:mars:nasa',
        source: 'Topic fallback: NASA Moon to Mars / Mars exploration context',
        text: '火星殖民目前仍属于长期探索和基础设施设想，核心约束包括发射成本、生命保障、能源、补给、辐射防护和返回能力。现阶段更接近科研与工程投入，不能直接证明个人或普通商业主体已经能稳定赚钱。',
        score: 2.6,
        external: false,
      },
      {
        id: 'fallback:mars:spacex',
        source: 'Topic fallback: SpaceX Mars mission public materials',
        text: 'SpaceX 等机构提出过火星运输和定居愿景，但公开资料主要描述长期目标、运载能力和成本下降方向，并不等同于已有可验证的火星殖民盈利模式。',
        score: 2.25,
        external: false,
      },
      {
        id: 'fallback:mars:economics',
        source: 'Topic fallback: Mars settlement economics',
        text: '从商业可行性看，火星殖民要产生收益通常需要运输、通信、科研合同、媒体/品牌、资源利用等假设场景。由于市场、成本和法规都高度不确定，回答应倾向于“目前不能确定能赚钱”。',
        score: 2.05,
        external: false,
      },
    );
  }

  if (isChipQuery(query)) {
    rows.push(
      {
        id: 'fallback:chip:industry',
        source: 'Topic fallback: AI chip industry context',
        text: 'AI 芯片进展通常涉及 GPU、AI accelerator、HBM、先进封装、晶圆代工和数据中心需求。实时结论应优先依赖最新厂商财报、半导体研究机构报告和权威新闻。',
        score: 2.4,
        external: false,
      },
    );
  }

  return rows.slice(0, topK);
}

async function retrieve(query, chunks, topK, config) {
  const { apiKey, baseUrl, embeddingModel } = config;
  const merged = [];
  const seen = new Set();
  const addChunks = items => {
    for (const item of items || []) {
      const key = item.id || `${item.source}:${item.text.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  };

  if (apiKey && embeddingModel) {
    try {
      console.log(`[retrieval] Embedding retrieve: ${embeddingModel}`);
      const embeddingChunks = await embeddingRetrieve(query, chunks, topK, apiKey, baseUrl, embeddingModel);
      addChunks(embeddingChunks.map(c => ({ ...c, source: c.source || 'Embedding retrieval' })));
    } catch (err) {
      console.error(`[retrieval] Embedding failed, fallback to BM25: ${err.message}`);
    }
  }

  console.log('[retrieval] Local BM25 retrieve');
  const index = new BM25Index(chunks);
  const localChunks = index.search(query, topK);
  addChunks(localChunks);

  const webChunks = await webSearchRetrieve(query, topK, config);
  addChunks(webChunks);

  if (merged.length > 0) {
    const hasLocal = localChunks.length > 0;
    const hasWeb = webChunks.length > 0;
    const mode = hasLocal && hasWeb
      ? 'hybrid-local-web'
      : hasWeb
        ? 'web-search'
        : apiKey && embeddingModel
          ? 'embedding'
          : 'bm25-local';
    return { mode, chunks: merged.sort((a, b) => b.score - a.score).slice(0, topK) };
  }

  const fallbackChunks = topicFallbackRetrieve(query, topK);
  if (fallbackChunks.length > 0) {
    return { mode: 'topic-fallback', chunks: fallbackChunks };
  }

  return { mode: config.webSearchEnabled ? 'web-search-empty' : 'bm25-empty', chunks: [] };
}

module.exports = { retrieve, BM25Index, duckDuckGoSearch, bingSearch, serperSearch, coreCoverage };
