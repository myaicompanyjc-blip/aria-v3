/**
 * EmbeddingService — Fachada de embeddings con proveedor enterprise
 *
 * Usa EmbeddingProvider internamente, que soporta:
 *   - jina-embeddings-v3 (recomendado, 1024d)
 *   - text-embedding-3-large (OpenAI)
 *   - LM Studio local (cualquier modelo)
 */

const EmbeddingProvider = require('./embedding_provider');

class EmbeddingService {
  constructor() {
    this._provider = new EmbeddingProvider();
  }

  async embed(texts) {
    return await this._provider.embed(texts);
  }

  cosineSimilarity(a, b) {
    return this._provider.cosineSimilarity(a, b);
  }

  getProvider() {
    return this._provider;
  }
}

module.exports = EmbeddingService;
