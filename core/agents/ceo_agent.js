/**
 * CEOAgent v4.0 — Orquestador multi-agent mejorado
 *
 * MEJORAS sobre v3.1:
 *   1. Routing-aware: recibe routing del CognitiveRouter y ajusta agentes
 *   2. Multi-hop execution: para pipelines doc_multi_hop
 *   3. Parallel + fallback: agentes en paralelo con circuit breaker individual
 *   4. Timeout por agente: si un agente tarda demasiado, continuar sin él
 *   5. Context deduplication: elimina contexto duplicado antes de pasar al Reasoner
 */

const ResearchAgent = require('./research_agent');
const DocumentAgent = require('./document_agent');
const cognitiveRouter = require('../cognitive-router/cognitive_router');

const AGENT_TIMEOUT_MS = parseInt(process.env.AGENT_TIMEOUT_MS || '15000');

class CEOAgent {
  constructor(memory, ragRetriever) {
    this.memory = memory;
    this.ragRetriever = ragRetriever;
    this.researchAgent = new ResearchAgent();
    this.documentAgent = new DocumentAgent(memory, ragRetriever);
  }

  async orchestrate(userId, message, plan, opts = {}) {
    const { requiredTools, intent } = plan;
    const routing = opts.routing || { pipeline: 'direct_chat', config: {} };
    const jobs = [];
    const agentsUsed = [];

    if (intent === 'doc_query' || requiredTools.includes('rag')) {
      const docJob = this._withTimeout(
        this._runDocumentAgent(userId, message, routing),
        AGENT_TIMEOUT_MS,
        'DocumentAgent'
      );
      jobs.push(docJob.then(result => ({ type: 'document', ...result })));
      agentsUsed.push('document');
    }

    if (intent === 'web_search' || requiredTools.includes('web_search')) {
      const webJob = this._withTimeout(
        this.researchAgent.research(message).then(ctx => ({ context: ctx, confidence: null, citations: '' })),
        AGENT_TIMEOUT_MS,
        'ResearchAgent'
      );
      jobs.push(webJob.then(result => ({ type: 'research', ...result })));
      agentsUsed.push('research');
    }

    if (jobs.length === 0) {
      return { enrichedContext: '', agentsUsed: [], confidence: null, citations: '', chunks: [] };
    }

    const results = await Promise.all(jobs);

    const contextParts = results.map(r => r.context).filter(Boolean);
    const enrichedContext = this._deduplicateContext(contextParts);

    const chunks = results
      .filter(r => r.type === 'document' && r.chunks)
      .flatMap(r => r.chunks || []);

    const docResult = results.find(r => r.type === 'document');
    const confidence = docResult?.confidence || null;
    const citations = docResult?.citations || '';

    return { enrichedContext, agentsUsed, confidence, citations, chunks };
  }

  async _runDocumentAgent(userId, message, routing) {
    try {
      if (routing.requiresMultiHop) {
        console.log('[CEO] Ejecutando multi-hop retrieval...');
        const multiHopChunks = await cognitiveRouter.executeMultiHopRetrieval(
          message, userId, this.ragRetriever, 3
        );
        if (multiHopChunks.length > 0) {
          const result = await this.documentAgent.queryWithChunks(userId, message, multiHopChunks);
          return { ...result, chunks: multiHopChunks };
        }
      }

      const result = await this.documentAgent.query(userId, message);
      return { ...result, chunks: result.rawChunks || [] };
    } catch (err) {
      console.warn('[CEO] DocumentAgent falló:', err.message);
      return { context: '', confidence: null, citations: '', chunks: [] };
    }
  }

  async _withTimeout(promise, timeoutMs, agentName) {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${agentName} timeout`)), timeoutMs)
    );
    try {
      return await Promise.race([promise, timeout]);
    } catch (err) {
      console.warn(`[CEO] ${agentName} falló/timeout:`, err.message);
      return { context: '', confidence: null, citations: '', chunks: [] };
    }
  }

  _deduplicateContext(parts) {
    if (parts.length <= 1) return parts.join('\n\n');
    const seen = new Set();
    const deduplicated = [];

    for (const part of parts) {
      const lines = part.split('\n').filter(l => l.trim().length > 20);
      const filteredLines = lines.filter(line => {
        const fp = line.trim().substring(0, 80);
        if (seen.has(fp)) return false;
        seen.add(fp);
        return true;
      });
      if (filteredLines.length > 0) {
        deduplicated.push(filteredLines.join('\n'));
      }
    }

    return deduplicated.join('\n\n');
  }
}

module.exports = CEOAgent;
