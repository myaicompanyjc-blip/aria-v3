/**
 * CognitiveRouter v5.0 — Enrutador + Recursive Multi-Hop Retrieval
 *
 * MEJORAS v5.0:
 *   1. Query Decomposition: divide preguntas complejas en sub-preguntas
 *   2. Sub-question Generation via LLM con plan de recuperación
 *   3. Recursive Retrieval Chains con verificación por hop
 *   4. Cross-retrieval Synthesis: combina resultados de múltiples hops
 *   5. Parallel sub-queries: ejecuta sub-preguntas en paralelo
 *
 * Diferencia con v4.0:
 *   v4.0: multi-hop secuencial simple (query → follow-up → query)
 *   v5.0: recursive tree con sub-queries paralelas + síntesis
 */

const llm = require('../../lib/llm_client');

const PIPELINE_TYPES = {
  DOC_SUMMARY: 'doc_summary',
  DOC_EXACT_QUERY: 'doc_exact_query',
  DOC_COMPARE: 'doc_compare',
  DOC_EXTRACT: 'doc_extract',
  DOC_MULTI_HOP: 'doc_multi_hop',
  WEB_SEARCH: 'web_search',
  WEB_RESEARCH: 'web_research',
  CREATIVE_GENERATION: 'creative',
  STRATEGIC_PLANNING: 'strategic',
  DATA_ANALYSIS: 'data_analysis',
  COMPARATIVE: 'comparative',
  DIRECT_CHAT: 'direct_chat',
  MEMORY_RECALL: 'memory_recall',
};

const PIPELINE_PATTERNS = [
  {
    pipeline: PIPELINE_TYPES.DOC_SUMMARY,
    patterns: [
      /res[uú]me(me|n)?\s+(el|este|la|este)\s+(documento|pdf|archivo|contrato|informe)/i,
      /de\s+qu[eé]\s+trata\s+(el|este)/i,
      /cu[eé]ntame\s+(de\s+qu[eé]\s+trata|sobre\s+el)/i,
      /haz\s+un\s+resumen/i,
      /overview\s+del\s+documento/i,
    ],
    config: { useFullDoc: true, maxChunks: 20, compressionNeeded: true }
  },
  {
    pipeline: PIPELINE_TYPES.DOC_EXACT_QUERY,
    patterns: [
      /cl[aá]usula\s*\d+/i, /art[ií]culo\s*\d+/i, /p[aá]gina\s*\d+/i,
      /secci[oó]n\s*\d+/i, /punto\s*\d+/i,
      /exactamente\s+(qu[eé]|c[oó]mo|cu[aá]nto)/i,
      /cu[aá]l\s+es\s+el\s+valor\s+exacto/i,
      /cu[aá]nto\s+(dice|indica|establece)/i,
    ],
    config: { prioritizeExact: true, requireCitation: true, maxChunks: 3 }
  },
  {
    pipeline: PIPELINE_TYPES.DOC_MULTI_HOP,
    patterns: [
      /qu[eé]\s+(relaci[oó]n|conexi[oó]n)\s+hay\s+entre/i,
      /c[oó]mo\s+se\s+relaciona[n]?\s+(con|el|la)/i,
      /consecuencias\s+(de|del|en\s+caso\s+de)/i,
      /implicaciones\s+(de|del|si)/i,
      /(incumplimiento|penalización|sanci[oó]n)\s+y\s+(condici[oó]n|consecuencia)/i,
      /impacto\s+(de|del|en|financiero|legal|tributario)/i,
      /qu[eé]\s+(implica|conlleva|significa)\s+(el|la|este)/i,
    ],
    config: { multiHop: true, maxHops: 3, maxChunks: 8 }
  },
  {
    pipeline: PIPELINE_TYPES.DOC_COMPARE,
    patterns: [
      /compar[ae]\s+(el|los|esta|estos|la|las)\s+(contrato|documento|secci[oó]n)/i,
      /diferencia\s+entre/i, /vs\.?\s+|versus/i,
      /cu[aá]l\s+(es\s+mejor|conviene\s+m[aá]s|es\s+m[aá]s)/i,
    ],
    config: { dualRetrieval: true, comparativeReasoning: true }
  },
  {
    pipeline: PIPELINE_TYPES.DOC_EXTRACT,
    patterns: [
      /lista\s+(todos|todas|los|las)\s+/i, /extrae\s+(toda[s]?|los|las)\s+/i,
      /cu[aá]les\s+son\s+(todos|todas)\s+/i,
      /d[aá]me\s+(la\s+lista|el\s+listado)\s+de/i, /enumera\s+(todos|todas)/i,
    ],
    config: { structuredExtraction: true, formatAsTable: true }
  },
  {
    pipeline: PIPELINE_TYPES.WEB_RESEARCH,
    patterns: [
      /investiga\s+(sobre|acerca\s+de|el\s+tema)/i,
      /qu[eé]\s+dicen\s+(los\s+expertos|las\s+fuentes|varios\s+sitios)/i,
      /an[aá]lisis\s+(del?\s+mercado|de\s+la\s+industria|competitivo)/i,
      /tendencias\s+(actuales|recientes|del?\s+mercado)/i,
    ],
    config: { multiSource: true, synthesis: true, maxSources: 5 }
  },
  {
    pipeline: PIPELINE_TYPES.STRATEGIC_PLANNING,
    patterns: [
      /crea\s+(una?\s+)?(estrategia|plan\s+de|propuesta)/i,
      /c[oó]mo\s+(puedo|podr[ií]a)\s+(mejorar|aumentar|crecer|escalar)/i,
      /qu[eé]\s+estrategia\s+(recomiendas|debo|usar[ía])/i,
      /plan\s+de\s+(acci[oó]n|negocios|ventas|marketing)/i,
    ],
    config: { useMemory: true, useWebSearch: true, longform: true }
  },
  {
    pipeline: PIPELINE_TYPES.DATA_ANALYSIS,
    patterns: [
      /analiza\s+(estos|los|las|esta)\s+(datos|cifras|n[uú]meros|tabla|excel)/i,
      /qu[eé]\s+(concluyes|se\s+puede\s+concluir|indican\s+estos)/i,
      /calcula\s+(el\s+)?(total|promedio|porcentaje|variaci[oó]n)/i,
      /cu[aá]l\s+(es\s+el\s+)?(rendimiento|desempe[nñ]o|performance)/i,
    ],
    config: { numericalAnalysis: true, formatResults: true }
  },
  {
    pipeline: PIPELINE_TYPES.MEMORY_RECALL,
    patterns: [
      /qu[eé]\s+(te\s+)?(dije|mencion[eé]|cont[eé]|pregunté)\s+(antes|anteriormente|hace)/i,
      /recuerdas\s+(cuando|lo\s+que|qu[eé])/i,
      /en\s+conversaciones\s+anteriores/i,
      /lo\s+que\s+(acordamos|dijimos|decidimos)/i,
    ],
    config: { useEpisodicMemory: true, useSemanticMemory: true }
  },
  {
    pipeline: PIPELINE_TYPES.COMPARATIVE,
    patterns: [
      /cu[aá]l\s+(es\s+la\s+mejor\s+opci[oó]n|recomiendas|conviene\s+m[aá]s)/i,
      /beneficios\s+y\s+riesgos\s+de/i,
      /ventajas\s+y\s+desventajas/i,
      /pr[oó]s\s+y\s+contras/i,
    ],
    config: { comparativeReasoning: true, dualRetrieval: true }
  },
];

class CognitiveRouter {
  route(message, plan, context = {}) {
    const detected = this._detectPipeline(message);
    const pipeline = this._reconcileWithPlan(detected, plan, context);

    const decision = {
      pipeline: pipeline.type,
      config: pipeline.config,
      reasoning: pipeline.reasoning,
      requiresMultiHop: pipeline.config.multiHop || false,
      requiresCitation: pipeline.config.requireCitation || plan.intent === 'doc_query',
      requiresCompression: pipeline.config.compressionNeeded || false,
      requiresDualRetrieval: pipeline.config.dualRetrieval || false,
      maxChunks: pipeline.config.maxChunks || 6,
      structuredOutput: pipeline.config.formatAsTable || pipeline.config.structuredExtraction || false,
      comparativeReasoning: pipeline.config.comparativeReasoning || false,
    };

    console.log(`[CognitiveRouter] Pipeline: ${decision.pipeline} | Intent: ${plan.intent}`);
    return decision;
  }

  _detectPipeline(message) {
    for (const rule of PIPELINE_PATTERNS) {
      for (const pattern of rule.patterns) {
        if (pattern.test(message)) {
          return { type: rule.pipeline, config: rule.config, reasoning: `Detectado por patrón: ${pattern.toString().substring(0, 60)}` };
        }
      }
    }
    return null;
  }

  _reconcileWithPlan(detected, plan, context) {
    const { intent } = plan;
    const hasDoc = context.hasActiveDoc || false;
    if (detected) {
      if (hasDoc && detected.type === PIPELINE_TYPES.WEB_SEARCH) {
        return { ...detected, type: PIPELINE_TYPES.DOC_EXACT_QUERY, reasoning: 'Redirigido a doc_exact por documento activo' };
      }
      return detected;
    }
    if (intent === 'doc_query') return { type: PIPELINE_TYPES.DOC_EXACT_QUERY, config: { maxChunks: 6, requireCitation: true }, reasoning: 'Plan indica doc_query' };
    if (intent === 'web_search') return { type: PIPELINE_TYPES.WEB_SEARCH, config: { maxSources: 5 }, reasoning: 'Plan indica web_search' };
    return { type: PIPELINE_TYPES.DIRECT_CHAT, config: {}, reasoning: 'Conversación directa' };
  }

  /**
   * RECURSIVE MULTI-HOP RETRIEVAL v5.0
   *
   * 1. Descompone la pregunta en sub-preguntas (query decomposition)
   * 2. Ejecuta sub-preguntas en paralelo
   * 3. Por cada sub-pregunta, hace retrieval recursivo
   * 4. Síntesis cross-retrieval
   */
  async executeRecursiveMultiHop(query, userId, ragSystem, maxHops = 3) {
    console.log('[CognitiveRouter] Recursive Multi-Hop Retrieval v5.0');

    // 1. Query Decomposition
    const subQueries = await this._decomposeQuery(query);
    console.log(`[CognitiveRouter] Sub-queries: ${subQueries.length}`);

    // 2. Ejecutar sub-queries en paralelo
    const hopResults = await Promise.all(
      subQueries.map(sq => this._recursiveRetrieve(sq, userId, ragSystem, maxHops))
    );

    // 3. Reunir todos los chunks únicos
    const allChunks = new Map();
    for (const chunks of hopResults) {
      for (const chunk of chunks) {
        const key = `${chunk.docId}_${chunk.chunkIndex}`;
        if (!allChunks.has(key) || chunk.score > allChunks.get(key).score) {
          allChunks.set(key, chunk);
        }
      }
    }

    const result = Array.from(allChunks.values())
      .sort((a, b) => (b.score || 0) - (a.score || 0));

    console.log(`[CognitiveRouter] Total chunks after recursive retrieval: ${result.length}`);
    return result;
  }

  /**
   * Query Decomposition: divide una pregunta compleja en sub-preguntas.
   */
  async _decomposeQuery(query) {
    try {
      const raw = await llm.chat([{
        role: 'user',
        content: `Descompón la siguiente pregunta en sus preguntas más específicas y atómicas.
Cada sub-pregunta debe poder responderse buscando una sección específica de un documento.
Devuelve SOLO un array JSON de strings, sin explicación.

Pregunta: "${query}"

Ejemplo:
Input: "¿Qué riesgos legales y financieros hay en este contrato?"
Output: ["¿Cuáles son las cláusulas de penalización?", "¿Cuáles son los montos y condiciones de pago?", "¿Qué dice sobre terminación anticipada?", "¿Cuáles son las obligaciones de las partes?"]

Input: "${query}"
Output:`
      }], { maxTokens: 200, temperature: 0.2 });
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed.slice(0, 5);
      }
    } catch {}
    return [query];
  }

  /**
   * Retrieval recursivo para una sub-pregunta.
   */
  async _recursiveRetrieve(query, userId, ragSystem, maxHops) {
    const allChunks = new Map();
    let currentQuery = query;
    let hop = 0;

    while (hop < maxHops) {
      const hopChunks = await ragSystem.query(userId, currentQuery, 5);
      if (hopChunks.length === 0) break;

      let newInfo = false;
      for (const chunk of hopChunks) {
        const key = `${chunk.docId}_${chunk.chunkIndex}`;
        if (!allChunks.has(key)) {
          allChunks.set(key, { ...chunk, hopNumber: hop + 1 });
          newInfo = true;
        }
      }

      if (!newInfo) break;

      // Generar follow-up query si hay más hops
      if (hop < maxHops - 1) {
        const contextSoFar = hopChunks.map(c => c.text.substring(0, 200)).join('\n');
        currentQuery = await this._generateFollowUpQuery(query, contextSoFar);
        if (!currentQuery || currentQuery === query) break;
        console.log(`[Recursive] Hop ${hop + 2}: "${currentQuery.substring(0, 80)}"`);
      }
      hop++;
    }

    return Array.from(allChunks.values());
  }

  /**
   * Multi-hop legacy (para compatibilidad con CEOAgent v4.0)
   */
  async executeMultiHopRetrieval(query, userId, ragSystem, maxHops = 3) {
    return await this.executeRecursiveMultiHop(query, userId, ragSystem, maxHops);
  }

  async _generateFollowUpQuery(originalQuery, partialContext) {
    try {
      const raw = await llm.chat([{
        role: 'user',
        content: `Pregunta original: "${originalQuery}"\n\nContexto encontrado hasta ahora:\n${partialContext}\n\nGenera UNA pregunta de seguimiento para encontrar información complementaria que falta. Solo la pregunta, sin explicación.`
      }], { maxTokens: 80, temperature: 0.3 });
      return raw.trim().replace(/^["']|["']$/g, '');
    } catch {
      return null;
    }
  }
}

module.exports = new CognitiveRouter();
module.exports.PIPELINE_TYPES = PIPELINE_TYPES;
