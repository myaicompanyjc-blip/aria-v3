/**
 * RetrievalEvaluator — Evalúa calidad de recuperación RAG
 *
 * Mide:
 *   - Precision@k: fracción de chunks relevantes en top-k
 *   - Recall@k: fracción de chunks relevantes recuperados del total relevante
 *   - MRR (Mean Reciprocal Rank): posición del primer chunk relevante
 *   - NDCG@k: ganancia acumulada descontada normalizada
 *   - Hit Rate: si al menos un chunk relevante fue recuperado
 */

class RetrievalEvaluator {
  constructor() {
    this._evalLog = [];
  }

  /**
   * Evalúa una consulta de recuperación.
   * @param {Object} params
   * @param {string} params.query - Consulta
   * @param {Array<{chunkId: string, score: number, text: string}>} params.retrievedChunks - Chunks recuperados
   * @param {Array<string>} params.relevantChunkIds - IDs de chunks considerados relevantes (ground truth)
   * @param {number} params.k - Top-k para métricas (default: retrievedChunks.length)
   * @returns {Object} Métricas de evaluación
   */
  evaluate({ query, retrievedChunks, relevantChunkIds, k }) {
    k = k || retrievedChunks.length;
    const topK = retrievedChunks.slice(0, k);

    const totalRelevant = relevantChunkIds.length;
    const retrievedRelevant = topK.filter(c => relevantChunkIds.includes(c.chunkId));
    const retrievedCount = retrievedRelevant.length;

    const precision = k > 0 ? retrievedCount / k : 0;
    const recall = totalRelevant > 0 ? retrievedCount / totalRelevant : 0;
    const hitRate = retrievedCount > 0 ? 1 : 0;

    const firstRelevantIdx = topK.findIndex(c => relevantChunkIds.includes(c.chunkId));
    const mrr = firstRelevantIdx >= 0 ? 1 / (firstRelevantIdx + 1) : 0;

    const dcg = topK.reduce((sum, c, i) => {
      const rel = relevantChunkIds.includes(c.chunkId) ? 1 : 0;
      return sum + rel / Math.log2(i + 2);
    }, 0);
    const idealDcg = Array(Math.min(totalRelevant, k)).fill(1)
      .reduce((sum, _, i) => sum + 1 / Math.log2(i + 2), 0);
    const ndcg = idealDcg > 0 ? dcg / idealDcg : 0;

    const entry = {
      ts: new Date().toISOString(),
      query: query.substring(0, 100),
      k,
      totalRelevant,
      retrievedRelevant: retrievedCount,
      precision: Math.round(precision * 1000) / 1000,
      recall: Math.round(recall * 1000) / 1000,
      mrr: Math.round(mrr * 1000) / 1000,
      ndcg: Math.round(ndcg * 1000) / 1000,
      hitRate: hitRate ? 1 : 0,
    };

    this._evalLog.push(entry);
    if (this._evalLog.length > 1000) this._evalLog.shift();

    return entry;
  }

  /**
   * Obtiene estadísticas agregadas de las últimas N evaluaciones.
   */
  getStats(lastN = 100) {
    const recent = this._evalLog.slice(-lastN);
    if (recent.length === 0) {
      return { avgPrecision: 0, avgRecall: 0, avgMrr: 0, avgNdcg: 0, hitRate: 0, count: 0 };
    }
    return {
      avgPrecision: Math.round(recent.reduce((s, e) => s + e.precision, 0) / recent.length * 1000) / 1000,
      avgRecall: Math.round(recent.reduce((s, e) => s + e.recall, 0) / recent.length * 1000) / 1000,
      avgMrr: Math.round(recent.reduce((s, e) => s + e.mrr, 0) / recent.length * 1000) / 1000,
      avgNdcg: Math.round(recent.reduce((s, e) => s + e.ndcg, 0) / recent.length * 1000) / 1000,
      hitRate: Math.round(recent.reduce((s, e) => s + e.hitRate, 0) / recent.length * 1000) / 1000,
      count: recent.length,
    };
  }
}

module.exports = new RetrievalEvaluator();
