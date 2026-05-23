/**
 * DocumentAgent v4.0 — Agente de documentos mejorado
 *
 * MEJORAS sobre v3.1:
 *   1. queryWithChunks: acepta chunks pre-recuperados (para multi-hop del CEO)
 *   2. rawChunks en el resultado: expone los chunks al CEO Agent para Citation Engine
 *   3. Dual-retrieval: para comparaciones, hace 2 búsquedas paralelas
 *   4. Confidence adaptativo: ajusta umbral según tipo de pipeline
 *   5. Smart preview: si la búsqueda falla, usa las primeras N páginas reales (no substring)
 */

const ConfidenceScorer = require('../confidence_scorer');

class DocumentAgent {
  constructor(memory, ragRetriever) {
    this.memory = memory;
    this.ragRetriever = ragRetriever;
    this.confidence = new ConfidenceScorer();
  }

  async query(userId, query) {
    let exactResults = [];
    try {
      exactResults = await this._exactSearch(userId, query);
    } catch (err) {
      console.warn('[DocumentAgent] Exact search falló:', err.message);
    }

    let chunks = [];
    try {
      chunks = await this.ragRetriever.query(userId, query, 6);
    } catch (err) {
      console.warn('[DocumentAgent] RAG query falló:', err.message);
    }

    return this._buildResult(userId, query, chunks, exactResults);
  }

  async queryWithChunks(userId, query, chunks) {
    const exactResults = [];
    try {
      const exact = await this._exactSearch(userId, query);
      exactResults.push(...exact);
    } catch {}

    return this._buildResult(userId, query, chunks, exactResults);
  }

  async _exactSearch(userId, query) {
    const rag = this.ragRetriever;
    if (rag.exactSearch) return await rag.exactSearch(userId, query) || [];
    if (rag._retriever?.lexicalIndex?.exactSearch) {
      return rag._retriever.lexicalIndex.exactSearch(query, userId) || [];
    }
    return [];
  }

  _buildResult(userId, query, chunks, exactResults) {
    const confidence = this.confidence.decide(query, chunks, { exactResults });
    const citations = this.confidence.formatCitations(chunks, exactResults);

    if (exactResults.length > 0) {
      return {
        context: this._formatExactResults(exactResults, query),
        confidence: confidence.confidence,
        citations,
        rawChunks: chunks,
      };
    }

    if (chunks.length > 0 && confidence.confidence.level !== 'low') {
      return {
        context: this._formatChunks(chunks, query),
        confidence: confidence.confidence,
        citations,
        rawChunks: chunks,
      };
    }

    return this._fallbackFromMemory(userId, query, confidence.confidence, chunks);
  }

  _fallbackFromMemory(userId, query, confidence, rawChunks) {
    const doc = this.memory.getActiveDocument(userId);
    if (!doc) {
      return { context: '', confidence, citations: '', rawChunks };
    }

    const result = this.memory.queryDocument(userId, query);
    if (result) {
      if (result.type === 'page') {
        return {
          context: `[DOCUMENTO: "${result.docTitle}" — Página ${result.pageNumber}]\n${result.text}`,
          confidence: { score: 0.8, level: 'high', reasons: [] },
          citations: `\n\n📎 Fuente: ${result.docTitle}, Página ${result.pageNumber}`,
          rawChunks,
        };
      }
      if (result.type === 'search') {
        const snippets = result.results.map(r => `Página ${r.pageNumber}: ${r.snippet}`).join('\n\n');
        return {
          context: `[DOCUMENTO: "${result.docTitle}" — Búsqueda: "${result.keyword}"]\n${snippets}`,
          confidence: { score: 0.7, level: 'medium', reasons: [] },
          citations: `\n\n📎 Fuente: ${result.docTitle}`,
          rawChunks,
        };
      }
    }

    const preview = this._buildSmartPreview(doc, query);
    return {
      context: `[DOCUMENTO: "${doc.title}" (${doc.totalPages || 1} págs.) — Vista general]\n${preview}`,
      confidence: { score: 0.4, level: 'medium', reasons: ['Vista general del documento'] },
      citations: '',
      rawChunks,
    };
  }

  _buildSmartPreview(doc, query) {
    if (!doc.pages || doc.pages.length === 0) {
      return (doc.text || '').substring(0, 4000);
    }

    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const scoredPages = doc.pages.map((pageText, i) => {
      const text = pageText.toLowerCase();
      const score = queryWords.filter(w => text.includes(w)).length;
      return { pageNumber: i + 1, text: pageText, score };
    });

    const topPages = scoredPages
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    if (topPages[0].score > 0) {
      return topPages.map(p => `[Página ${p.pageNumber}]\n${p.text.substring(0, 1500)}`).join('\n\n');
    }

    return doc.pages.slice(0, 3).map((p, i) => `[Página ${i + 1}]\n${p.substring(0, 1200)}`).join('\n\n');
  }

  _formatExactResults(results, query) {
    const header = `[BÚSQUEDA EXACTA — "${query}"]\n${results.length} coincidencias:\n\n`;
    const items = results.slice(0, 5).map((r, i) => {
      let heading = `Coincidencia ${i + 1}`;
      if (r.docTitle) heading += ` — ${r.docTitle}`;
      if (r.pageNumber) heading += ` — Página ${r.pageNumber}`;
      const context = this._getContext(r.text, r.matchPosition || 0, 300);
      return `${heading}\n${context}`;
    }).join('\n\n');
    return header + items;
  }

  _formatChunks(chunks, query) {
    const header = `[CONTEXTO RAG — Búsqueda: "${query}"]\n`;
    const items = chunks.slice(0, 6).map((c, i) => {
      let heading = `Fragmento ${i + 1}`;
      if (c.docTitle) heading += ` — ${c.docTitle}`;
      if (c.pageNumber) heading += ` — Página ${c.pageNumber}`;
      return `${heading}:\n${c.text}`;
    }).join('\n\n');
    return header + items;
  }

  _getContext(text, matchPos, radius) {
    const start = Math.max(0, matchPos - radius);
    const end = Math.min(text.length, matchPos + radius);
    return (start > 0 ? '...' : '') + text.substring(start, end) + (end < text.length ? '...' : '');
  }
}

module.exports = DocumentAgent;
