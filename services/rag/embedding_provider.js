/**
 * EmbeddingProvider — Sistema multi-proveedor de embeddings enterprise
 *
 * Proveedores:
 *   - jina: jina-embeddings-v3 (recomendado, 1024d)
 *   - openai: text-embedding-3-large (2560d, requiere API key)
 *   - lmstudio: cualquier modelo local (default: nomic-embed-text-v1.5)
 *
 * Config: EMBEDDING_PROVIDER=jina|openai|lmstudio
 */

const axios = require('axios');

const PROVIDERS = {
  JINA: 'jina',
  OPENAI: 'openai',
  LMSTUDIO: 'lmstudio',
};

class EmbeddingProvider {
  constructor() {
    this.provider = process.env.EMBEDDING_PROVIDER || PROVIDERS.LMSTUDIO;
    this.jinaApiKey = process.env.JINA_API_KEY;
    this.jinaModel = process.env.JINA_EMBEDDING_MODEL || 'jina-embeddings-v3';
    this.openaiApiKey = process.env.OPENAI_API_KEY;
    this.openaiModel = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-large';
    this.lmStudioUrl = process.env.LM_STUDIO_URL || 'http://localhost:1234';
    this.lmStudioModel = process.env.EMBEDDING_MODEL || 'text-embedding-nomic-embed-text-v1.5';
    this.dimension = parseInt(process.env.EMBEDDING_DIMENSION || '1024');
    this.fallbackDim = this.dimension;
    this._useFallback = false;
    this._stats = { totalCalls: 0, totalTokens: 0, errors: 0, lastProvider: null };
  }

  async embed(texts) {
    this._stats.totalCalls++;
    if (this.provider === PROVIDERS.JINA && this.jinaApiKey) {
      try {
        const result = await this._callJina(texts);
        this._stats.lastProvider = 'jina';
        return result;
      } catch (err) {
        console.warn(`[EmbeddingProvider] Jina falló: ${err.message}`);
        this._stats.errors++;
      }
    }
    if (this.provider === PROVIDERS.OPENAI && this.openaiApiKey) {
      try {
        const result = await this._callOpenAI(texts);
        this._stats.lastProvider = 'openai';
        return result;
      } catch (err) {
        console.warn(`[EmbeddingProvider] OpenAI falló: ${err.message}`);
        this._stats.errors++;
      }
    }
    // Fallback LM Studio
    try {
      const result = await this._callLMStudio(texts);
      this._stats.lastProvider = 'lmstudio';
      return result;
    } catch (err) {
      console.warn(`[EmbeddingProvider] LM Studio falló: ${err.message}`);
      this._stats.errors++;
      this._useFallback = true;
    }
    return texts.map(t => this._hashEmbed(t, this.fallbackDim));
  }

  async _callJina(texts) {
    const res = await axios.post('https://api.jina.ai/v1/embeddings', {
      model: this.jinaModel,
      input: texts,
      normalized: true,
      embedding_type: 'float',
    }, {
      timeout: 30000,
      headers: {
        'Authorization': `Bearer ${this.jinaApiKey}`,
        'Content-Type': 'application/json',
      },
    });
    const usage = res.data?.usage;
    if (usage?.total_tokens) this._stats.totalTokens += usage.total_tokens;
    return res.data.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding);
  }

  async _callOpenAI(texts) {
    const res = await axios.post('https://api.openai.com/v1/embeddings', {
      model: this.openaiModel,
      input: texts,
      dimensions: this.dimension,
    }, {
      timeout: 30000,
      headers: {
        'Authorization': `Bearer ${this.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
    });
    const usage = res.data?.usage;
    if (usage?.total_tokens) this._stats.totalTokens += usage.total_tokens;
    return res.data.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding);
  }

  async _callLMStudio(texts) {
    if (this._useFallback) throw new Error('LM Studio en fallback');
    const res = await axios.post(`${this.lmStudioUrl}/v1/embeddings`, {
      model: this.lmStudioModel,
      input: texts,
    }, { timeout: 30000 });
    return res.data.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding);
  }

  _hashEmbed(text, dim) {
    const vec = new Array(dim).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % dim] += text.charCodeAt(i) / 255;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map(v => v / norm);
  }

  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
  }

  getStats() {
    return { ...this._stats, provider: this.provider };
  }
}

module.exports = EmbeddingProvider;
