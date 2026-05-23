/**
 * ResearchAgent — BRECHA 7
 *
 * Agente especializado en búsqueda web + síntesis de resultados.
 * Usa WebSearch multi-fuente y sintetiza con LLM.
 */

const llm = require('../../lib/llm_client');

class ResearchAgent {
  constructor() {
    this._WebSearch = null;
    this._initialized = false;
  }

  _init() {
    if (this._initialized) return;
    try { this._WebSearch = require('../../services/web_search'); } catch {}
    this._initialized = true;
  }

  /**
   * Busca en internet y sintetiza los resultados.
   * @param {string} query
   * @returns {Promise<string>} Contexto formateado
   */
  async research(query) {
    this._init();
    if (!this._WebSearch) return '';

    try {
      const ws = new this._WebSearch();
      const results = await ws.search(query);
      if (!results || results.length === 0) return '';

      const snippets = results.slice(0, 5)
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\nFuente: ${r.url}`)
        .join('\n\n');

      return `[RESULTADOS WEB — ResearchAgent]\n${snippets}`;
    } catch (err) {
      console.warn('[ResearchAgent] Error:', err.message);
      return '';
    }
  }
}

module.exports = ResearchAgent;
