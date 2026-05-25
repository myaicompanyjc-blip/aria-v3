class ConfidenceScorer {
  constructor() {
    this.HIGH_THRESHOLD = 0.75;
    this.MEDIUM_THRESHOLD = 0.5;
  }

  /**
   * Evalúa la confianza de los resultados de búsqueda para una query.
   *
   * @param {string} query - Pregunta del usuario
   * @param {Array} chunks - Resultados de búsqueda (ya rerankeados)
   * @param {Object} opts
   * @param {Array} opts.exactResults - Resultados de búsqueda exacta (lexical)
   * @returns {{ score: number, level: 'high'|'medium'|'low', reasons: string[], details: Object }}
   */
  evaluate(query, chunks, opts = {}) {
    const reasons = [];
    const { exactResults = [] } = opts;

    if (!chunks || chunks.length === 0) {
      return {
        score: 0,
        level: 'low',
        reasons: ['No se encontraron fragmentos relevantes'],
        details: { hasResults: false },
      };
    }

    // Factor 1: Score del mejor chunk (0-1)
    const topScore = chunks[0]?.score || chunks[0]?.rerankScore || 0;
    const scoreFactor = Math.min(topScore / 0.8, 1);

    // Factor 2: Coincidencia de términos de la query en los chunks
    const queryTerms = query.toLowerCase()
      .replace(/[^\wáéíóúüñ\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    let termMatchRatio = 0;
    if (queryTerms.length > 0) {
      const combinedText = chunks.map(c => c.text?.toLowerCase() || '').join(' ');
      const matchedTerms = queryTerms.filter(t => combinedText.includes(t));
      termMatchRatio = matchedTerms.length / queryTerms.length;
    }

    // Factor 3: Exact match (búsqueda exacta encontró resultados)
    const exactMatchBonus = exactResults.length > 0 ? 0.2 : 0;

    // Factor 4: Page number presente (indica chunk bien estructurado)
    const hasPageNumbers = chunks.some(c => c.pageNumber !== null && c.pageNumber !== undefined);
    const pageBonus = hasPageNumbers ? 0.1 : 0;

    // Factor 5: Cantidad de chunks relevantes
    const chunkCountFactor = Math.min(chunks.filter(c => (c.score || c.rerankScore || 0) > 0.1).length / 3, 1);

    // Puntaje compuesto ponderado
    const score = Math.min(
      scoreFactor * 0.35 +
      termMatchRatio * 0.25 +
      chunkCountFactor * 0.2 +
      exactMatchBonus +
      pageBonus,
      1
    );

    // Determinar nivel
    let level;
    if (score >= this.HIGH_THRESHOLD) {
      level = 'high';
    } else if (score >= this.MEDIUM_THRESHOLD) {
      level = 'medium';
    } else {
      level = 'low';
    }

    // Generar razones
    if (scoreFactor < 0.3) reasons.push('La relevancia semántica del mejor fragmento es baja');
    if (termMatchRatio < 0.3) reasons.push('Pocos términos de la búsqueda aparecen en los resultados');
    if (!hasPageNumbers) reasons.push('Los fragmentos no tienen referencia de página');
    if (chunks.length === 0) reasons.push('No hay fragmentos disponibles');

    return {
      score: Math.round(score * 100) / 100,
      level,
      reasons,
      details: {
        topScore: Math.round(topScore * 100) / 100,
        termMatchRatio: Math.round(termMatchRatio * 100) / 100,
        hasPageNumbers,
        chunkCount: chunks.length,
        exactMatchCount: exactResults.length,
      },
    };
  }

  /**
   * Evalúa si se debe responder o no basado en la confianza.
   * @returns {{ shouldRespond: boolean, confidence: Object, instruction: string }}
   */
  decide(query, chunks, opts = {}) {
    const confidence = this.evaluate(query, chunks, opts);
    const hasActiveDoc = opts.activeDoc || false;

    if (confidence.level === 'high') {
      return {
        shouldRespond: true,
        confidence,
        instruction: 'responder_normal',
      };
    }

    if (confidence.level === 'medium') {
      return {
        shouldRespond: true,
        confidence,
        instruction: 'responder_con_advertencia',
      };
    }

    if (hasActiveDoc) {
      return {
        shouldRespond: true,
        confidence: { ...confidence, level: 'low' },
        instruction: 'responder_con_advertencia',
      };
    }

    return {
      shouldRespond: false,
      confidence,
      instruction: 'no_responder',
    };
  }

  /**
   * Formatea las citas exactas para incluir en la respuesta.
   * @param {Array} chunks - Chunks con metadata de página
   * @param {Array} exactResults - Resultados de búsqueda exacta
   * @returns {string} Texto formateado de citas
   */
  formatCitations(chunks, exactResults = []) {
    const citations = [];

    // Priorizar resultados exactos (tienen posición exacta)
    for (const r of exactResults.slice(0, 3)) {
      let citation = `- ${r.docTitle || 'Documento'}`;
      if (r.pageNumber) citation += `, Página ${r.pageNumber}`;
      if (r.startChar !== null) citation += `, caracter ${r.startChar}`;
      citations.push(citation);
    }

    // Completar con chunks del reranker que tengan página
    for (const c of chunks.slice(0, 3)) {
      if (citations.length >= 3) break;
      if (c.pageNumber) {
        let citation = `- ${c.docTitle || 'Documento'}`;
        citation += `, Página ${c.pageNumber}`;
        if (c.startChar !== null) citation += `, caracter ${c.startChar}`;
        citations.push(citation);
      }
    }

    if (citations.length === 0) return '';
    return `\n\n📎 Fuentes:\n${citations.join('\n')}`;
  }
}

module.exports = ConfidenceScorer;
