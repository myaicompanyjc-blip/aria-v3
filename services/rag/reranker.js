/**
 * Reranker v5.0 — Sistema multi-proveedor de reranking enterprise
 *
 * Proveedores:
 *   - jina: jina-reranker-v2 (API cloud, recomendado)
 *   - bge: bge-reranker-v2-m3 (via HuggingFace Inference API)
 *   - llm: LLM-based reranking (fallback)
 *
 * Config: RERANKER_PROVIDER=jina|bge|llm
 */

const llm = require('../../lib/llm_client');

const PROVIDERS = {
  JINA: 'jina',
  BGE: 'bge',
  LLM: 'llm',
};

class Reranker {
  constructor() {
    this.provider = process.env.RERANKER_PROVIDER || PROVIDERS.LLM;
    this.jinaApiKey = process.env.JINA_API_KEY;
    this.jinaModel = process.env.JINA_RERANKER_MODEL || 'jina-reranker-v2-base-multilingual';
    this.hfApiKey = process.env.HF_API_KEY;
    this.hfModel = process.env.HF_RERANKER_MODEL || 'BAAI/bge-reranker-v2-m3';
    this.topKDefault = parseInt(process.env.RERANKER_TOP_K || '8');
    this._stats = { totalCalls: 0, errors: 0, lastProvider: null };
  }

  async rerank(query, chunks, topK = this.topKDefault) {
    if (chunks.length <= topK) return chunks;
    this._stats.totalCalls++;

    const candidates = chunks.slice(0, 20);

    if (this.provider === PROVIDERS.JINA && this.jinaApiKey) {
      try {
        const result = await this._callJina(query, candidates, topK);
        this._stats.lastProvider = 'jina';
        return result;
      } catch (err) {
        console.warn(`[Reranker] Jina falló: ${err.message}`);
        this._stats.errors++;
      }
    }

    if (this.provider === PROVIDERS.BGE && this.hfApiKey) {
      try {
        const result = await this._callBGE(query, candidates, topK);
        this._stats.lastProvider = 'bge';
        return result;
      } catch (err) {
        console.warn(`[Reranker] BGE falló: ${err.message}`);
        this._stats.errors++;
      }
    }

    try {
      this._stats.lastProvider = 'llm';
      return await this._llmRerank(query, candidates, topK);
    } catch (err) {
      console.warn('[Reranker] LLM rerank falló, usando heurístico:', err.message);
      this._stats.lastProvider = 'heuristic';
      return this._heuristicRerank(query, chunks, topK);
    }
  }

  async _callJina(query, chunks, topK) {
    const res = await axios.post('https://api.jina.ai/v1/rerank', {
      model: this.jinaModel,
      query,
      documents: chunks.map(c => c.text.substring(0, 2000)),
      top_n: topK,
    }, {
      timeout: 15000,
      headers: {
        'Authorization': `Bearer ${this.jinaApiKey}`,
        'Content-Type': 'application/json',
      },
    });
    return (res.data?.results || []).map(r => ({
      ...chunks[r.index],
      rerankScore: r.relevance_score,
    }));
  }

  async _callBGE(query, chunks, topK) {
    const pairs = chunks.map(c => ({ text: query, text_pair: c.text.substring(0, 2000) }));
    const res = await axios.post(
      `https://api-inference.huggingface.co/models/${this.hfModel}`,
      { inputs: pairs, parameters: {} },
      {
        timeout: 30000,
        headers: { 'Authorization': `Bearer ${this.hfApiKey}` },
      }
    );
    const scores = Array.isArray(res.data) ? res.data : [];
    return chunks
      .map((chunk, i) => ({ ...chunk, rerankScore: scores[i] || 0 }))
      .sort((a, b) => b.rerankScore - a.rerankScore)
      .slice(0, topK);
  }

  async _llmRerank(query, chunks, topK) {
    const RERANK_PROMPT = `Eres un sistema de reranking especializado. Dada la pregunta del usuario y los fragmentos de documentos, selecciona los ${topK} más relevantes y ordénalos por importancia descendente.

Pregunta: "${query}"

Fragmentos:
${chunks.map((c, i) => `[${i}] ${c.text.substring(0, 300)}`).join('\n\n')}

Responde SOLO con JSON: {"ranking": [indices en orden de relevancia, máximo ${topK}], "reasons": ["por qué cada uno es relevante"]}`;

    const raw = await llm.chat([
      { role: 'user', content: RERANK_PROMPT }
    ], { maxTokens: 150, temperature: 0.1 });

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Respuesta inválida del LLM reranker');

    const { ranking } = JSON.parse(match[0]);
    return ranking
      .filter(i => i >= 0 && i < chunks.length)
      .slice(0, topK)
      .map(i => ({ ...chunks[i], rerankScore: (topK - ranking.indexOf(i)) / topK }));
  }

  _heuristicRerank(query, chunks, topK) {
    const queryTerms = query.toLowerCase()
      .replace(/[^\wáéíóúüñ\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    return chunks
      .map(chunk => {
        const text = chunk.text.toLowerCase();
        let termScore = 0;
        for (const term of queryTerms) {
          termScore += (text.match(new RegExp(term, 'g')) || []).length;
        }
        const finalScore = (chunk.score || 0) * 0.7 + (termScore / (queryTerms.length + 1)) * 0.3;
        return { ...chunk, rerankScore: finalScore };
      })
      .sort((a, b) => b.rerankScore - a.rerankScore)
      .slice(0, topK);
  }

  getStats() {
    return { ...this._stats, provider: this.provider };
  }
}

const axios = require('axios');

module.exports = Reranker;
