/**
 * AnswerEvaluator — Evalúa calidad de respuestas generadas
 *
 * Mide:
 *   - Groundedness: qué tanto se basa la respuesta en los chunks recuperados
 *   - Faithfulness: qué tanto se contradice la respuesta con los chunks recuperados
 *   - Completeness: qué tanto cubre la respuesta los puntos clave de la consulta
 *   - Relevancia: qué tan pertinente es la respuesta a la consulta
 *
 * Usa el LLM como juez (LLM-as-judge) para evaluaciones automáticas.
 */

const llm = require('../../lib/llm_client');

class AnswerEvaluator {
  constructor() {
    this._evalLog = [];
  }

  /**
   * Evalúa una respuesta usando LLM-as-judge.
   * @param {Object} params
   * @param {string} params.query - Consulta original
   * @param {string} params.answer - Respuesta generada
   * @param {Array<string>} params.contextChunks - Chunks usados como contexto
   * @returns {Promise<Object>} Puntajes de evaluación
   */
  async evaluate({ query, answer, contextChunks }) {
    const context = (contextChunks || []).join('\n\n').substring(0, 3000);
    const truncatedAnswer = answer.substring(0, 2000);

    const EVAL_PROMPT = `Evalúa la siguiente respuesta de un asistente empresarial.

## Contexto recuperado:
${context || '(sin contexto)'}

## Consulta del usuario:
${query}

## Respuesta del asistente:
${truncatedAnswer}

Evalúa las siguientes dimensiones del 0.0 al 1.0 (1.0 = perfecto):

1. **groundedness**: ¿La respuesta se basa en el contexto, o inventa información?
2. **faithfulness**: ¿La respuesta contradice el contexto en algún punto?
3. **completeness**: ¿La respuesta cubre todos los aspectos de la consulta?
4. **relevance**: ¿La respuesta es pertinente a la consulta?

Responde SOLO con JSON:
{"groundedness": 0.95, "faithfulness": 1.0, "completeness": 0.8, "relevance": 1.0, "reasoning": "Breve justificación"}`;

    try {
      const raw = await llm.chat([{ role: 'user', content: EVAL_PROMPT }], {
        maxTokens: 300, temperature: 0.1,
      });
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return this._fallback();

      const scores = JSON.parse(match[0]);
      const entry = {
        ts: new Date().toISOString(),
        query: query.substring(0, 100),
        ...scores,
        contextLength: (contextChunks || []).length,
      };

      this._evalLog.push(entry);
      if (this._evalLog.length > 1000) this._evalLog.shift();

      return {
        groundedness: Math.min(1, Math.max(0, scores.groundedness || 0)),
        faithfulness: Math.min(1, Math.max(0, scores.faithfulness || 0)),
        completeness: Math.min(1, Math.max(0, scores.completeness || 0)),
        relevance: Math.min(1, Math.max(0, scores.relevance || 0)),
        overall: Math.round(
          ((scores.groundedness || 0) + (scores.faithfulness || 0) +
           (scores.completeness || 0) + (scores.relevance || 0)) / 4 * 1000
        ) / 1000,
        reasoning: scores.reasoning || '',
      };
    } catch {
      return this._fallback();
    }
  }

  /**
   * Evalúa sin LLM (heurístico basado en solapamiento de tokens).
   */
  evaluateHeuristic({ query, answer, contextChunks }) {
    const context = (contextChunks || []).join(' ').toLowerCase();
    const ans = answer.toLowerCase();
    const qTokens = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);

    const tokensFound = qTokens.filter(t => ans.includes(t)).length;
    const completeness = qTokens.length > 0 ? tokensFound / qTokens.length : 0;

    const ansWords = new Set(ans.split(/\s+/));
    const ctxWords = new Set(context.split(/\s+/));
    const overlap = [...ansWords].filter(w => ctxWords.has(w) && w.length > 3).length;
    const groundedness = ansWords.size > 0 ? overlap / Math.min(ansWords.size, ctxWords.size) : 0;

    return {
      groundedness: Math.round(groundedness * 1000) / 1000,
      faithfulness: 1,
      completeness: Math.round(completeness * 1000) / 1000,
      relevance: Math.round((groundedness + completeness) / 2 * 1000) / 1000,
      overall: Math.round((groundedness + 1 + completeness + (groundedness + completeness) / 2) / 4 * 1000) / 1000,
      reasoning: 'Evaluación heurística (sin LLM)',
    };
  }

  getStats(lastN = 100) {
    const recent = this._evalLog.slice(-lastN);
    if (recent.length === 0) {
      return { avgGroundedness: 0, avgFaithfulness: 0, avgCompleteness: 0, avgRelevance: 0, avgOverall: 0, count: 0 };
    }
    return {
      avgGroundedness: Math.round(recent.reduce((s, e) => s + (e.groundedness || 0), 0) / recent.length * 1000) / 1000,
      avgFaithfulness: Math.round(recent.reduce((s, e) => s + (e.faithfulness || 0), 0) / recent.length * 1000) / 1000,
      avgCompleteness: Math.round(recent.reduce((s, e) => s + (e.completeness || 0), 0) / recent.length * 1000) / 1000,
      avgRelevance: Math.round(recent.reduce((s, e) => s + (e.relevance || 0), 0) / recent.length * 1000) / 1000,
      avgOverall: Math.round(recent.reduce((s, e) => s + (e.overall || 0), 0) / recent.length * 1000) / 1000,
      count: recent.length,
    };
  }

  _fallback() {
    return { groundedness: 0, faithfulness: 1, completeness: 0, relevance: 0, overall: 0.25, reasoning: 'Error en evaluación LLM' };
  }
}

module.exports = new AnswerEvaluator();
