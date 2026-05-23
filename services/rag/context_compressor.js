/**
 * ContextCompressor v5.0 — Compresión de contexto antes del LLM
 *
 * PROBLEMA: Mandar 20 chunks enormes al LLM diluye la atención del modelo.
 *
 * Este motor:
 *   1. Resume chunks largos a su núcleo semántico
 *   2. Elimina redundancia entre chunks (dedup semántico)
 *   3. Fusiona chunks relacionados en un solo bloque cohesivo
 *   4. Prioriza chunks por señal informativa (no solo score)
 *   5. Recorta a un budget de tokens configurable
 *
 * USO: Se inyecta en AriaBrain antes de pasar contexto al ReasoningEngine.
 */

const llm = require('../../lib/llm_client');

const DEFAULT_MAX_TOKENS = 3000;
const CHUNK_SUMMARY_THRESHOLD = 800; // chars → resumir si excede
const SIMILARITY_FINGERPRINT_LENGTH = 100;

class ContextCompressor {
  constructor() {
    this.maxTokens = parseInt(process.env.CONTEXT_MAX_TOKENS || DEFAULT_MAX_TOKENS);
    this.enabled = process.env.CONTEXT_COMPRESSION_ENABLED !== 'false';
    this._stats = { totalCompressed: 0, totalOriginal: 0, totalSaved: 0 };
  }

  /**
   * Comprime un array de chunks o un string de contexto.
   * @param {Array|string} context - Chunks del RAG o string de contexto
   * @param {Object} opts
   * @returns {Promise<string>} Contexto comprimido
   */
  async compress(context, opts = {}) {
    if (!this.enabled) {
      return typeof context === 'string' ? context : context.map(c => c.text || c).join('\n\n');
    }

    const chunks = Array.isArray(context)
      ? context.map(c => typeof c === 'string' ? { text: c, score: 0 } : c)
      : [{ text: context, score: 0 }];

    if (chunks.length === 0) return '';

    const originalSize = chunks.reduce((s, c) => s + (c.text || '').length, 0);

    // 1. Deduplicación semántica
    const deduped = this._deduplicate(chunks);

    // 2. Resumir chunks largos
    const compressed = await this._summarizeLongChunks(deduped, opts.query);

    // 3. Fusionar chunks relacionados
    const fused = this._fuseRelated(compressed);

    // 4. Priorizar y recortar por token budget
    const result = this._trimToBudget(fused);

    const finalSize = result.length;
    this._stats.totalCompressed++;
    this._stats.totalOriginal += originalSize;
    this._stats.totalSaved += (originalSize - finalSize);

    console.log(`[ContextCompressor] ${originalSize} → ${finalSize} chars (${Math.round((1 - finalSize / Math.max(originalSize, 1)) * 100)}% ahorro)`);

    return result;
  }

  /**
   * Deduplicación semántica: elimina chunks con contenido casi idéntico.
   */
  _deduplicate(chunks) {
    const seen = new Map();
    return chunks.filter(chunk => {
      const text = (chunk.text || '').trim();
      if (!text) return false;
      const fp = this._fingerprint(text);
      if (seen.has(fp)) {
        const existing = seen.get(fp);
        // Mantener el de mayor score
        if (chunk.score > existing.score) {
          seen.set(fp, chunk);
          return true;
        }
        return false;
      }
      seen.set(fp, chunk);
      return true;
    });
  }

  /**
   * Fingerprint semántico: compara inicio y fin del chunk.
   */
  _fingerprint(text) {
    const cleaned = text.toLowerCase().replace(/[^\w\s]/g, '').trim();
    if (cleaned.length <= SIMILARITY_FINGERPRINT_LENGTH) return cleaned;
    return cleaned.substring(0, 60) + cleaned.substring(cleaned.length - 40);
  }

  /**
   * Resumir chunks que exceden el umbral usando el LLM.
   * Solo para chunks con score bajo o muy largos.
   */
  async _summarizeLongChunks(chunks, query) {
    const result = [];
    for (const chunk of chunks) {
      const text = chunk.text || '';
      if (text.length <= CHUNK_SUMMARY_THRESHOLD || chunk.score > 0.85) {
        result.push(chunk);
        continue;
      }
      try {
        const summary = await llm.chat([{
          role: 'user',
          content: `Resume el siguiente fragmento de documento en 1-2 oraciones, conservando SOLO los datos clave (cifras, fechas, nombres, cláusulas). Omite relleno.\n\nTexto:\n${text.substring(0, 2000)}`
        }], { maxTokens: 200, temperature: 0.2 });
        result.push({
          ...chunk,
          text: summary || text.substring(0, 500),
          compressed: true,
        });
      } catch {
        result.push({ ...chunk, text: text.substring(0, 500) });
      }
    }
    return result;
  }

  /**
   * Fusiona chunks consecutivos del mismo documento con contenido relacionado.
   */
  _fuseRelated(chunks) {
    if (chunks.length <= 1) return chunks;
    const fused = [];
    let current = chunks[0];

    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i];
      const sameDoc = current.docId && chunk.docId && current.docId === chunk.docId;
      const adjacent = sameDoc && Math.abs((chunk.chunkIndex || 0) - (current.chunkIndex || 0)) <= 1;
      const totalLen = (current.text || '').length + (chunk.text || '').length;

      if (adjacent && totalLen < CHUNK_SUMMARY_THRESHOLD) {
        current = {
          ...current,
          text: (current.text || '') + '\n\n' + (chunk.text || ''),
          chunkIndex: current.chunkIndex,
        };
      } else {
        fused.push(current);
        current = chunk;
      }
    }
    fused.push(current);
    return fused;
  }

  /**
   * Recorta al budget de tokens, priorizando chunks de mayor score y más cortos.
   */
  _trimToBudget(chunks) {
    if (chunks.length === 0) return '';

    // Estimar tokens: ~4 chars por token
    const maxChars = this.maxTokens * 4;
    let totalChars = 0;
    const selected = [];

    // Ordenar por score descendente, luego por longitud ascendente
    const scored = chunks
      .map(c => ({ ...c, effectiveScore: c.score || 0.5, charLen: (c.text || '').length }))
      .sort((a, b) => {
        const scoreDiff = b.effectiveScore - a.effectiveScore;
        if (Math.abs(scoreDiff) > 0.1) return scoreDiff;
        return a.charLen - b.charLen;
      });

    for (const chunk of scored) {
      const len = chunk.charLen;
      if (totalChars + len > maxChars) {
        // Si es el primero, recortarlo
        if (selected.length === 0) {
          const remaining = maxChars;
          selected.push(chunk.text.substring(0, remaining));
          totalChars += remaining;
        }
        break;
      }
      selected.push(chunk.text);
      totalChars += len;
    }

    return selected.join('\n\n');
  }

  getStats() {
    return { ...this._stats, enabled: this.enabled, maxTokens: this.maxTokens };
  }
}

module.exports = new ContextCompressor();
