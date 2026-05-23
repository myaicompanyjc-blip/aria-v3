/**
 * Observability v5.0 — Telemetría empresarial con evaluación RAG
 *
 * MEJORAS v5.0:
 *   - RAG precision/recall tracking por run
 *   - Token cost tracking (input + output)
 *   - Groundedness scoring integrado con AnswerEvaluator
 *   - Hallucination rate por usuario
 *   - Weekly report con tendencias
 *   - Pipeline cost breakdown
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const retrievalEvaluator = require('../../services/evaluation/retrieval_evaluator');
const answerEvaluator = require('../../services/evaluation/answer_evaluator');

const DATA_DIR = path.join(__dirname, '../../data');
const METRICS_FILE = path.join(DATA_DIR, 'metrics.jsonl');
const HALLUCINATION_LOG = path.join(DATA_DIR, 'hallucination_log.jsonl');

const TOKEN_COST_PER_1K = {
  'qwen/qwen3-30b-a3b': { input: 0.0005, output: 0.0015 },
  'gpt-4o': { input: 0.005, output: 0.015 },
  'claude-3-opus': { input: 0.015, output: 0.075 },
  'default': { input: 0.001, output: 0.002 },
};

class ObservabilityV5 {
  constructor() {
    this._activeRequests = new Map();
    this._sessionStats = new Map();
    this._weeklyMetrics = [];
    this._dailyMetrics = {
      date: this._today(),
      totalRequests: 0,
      totalErrors: 0,
      avgLatencyMs: 0,
      pipelineBreakdown: {},
      hallucinationCount: 0,
      ragHits: 0,
      ragMisses: 0,
      ragHitRate: 0,
      tokenInput: 0,
      tokenOutput: 0,
      totalCost: 0,
      groundednessSum: 0,
      groundednessCount: 0,
      avgGroundedness: 0,
    };
    this._ensureDataDir();
    this._loadWeeklyMetrics();
  }

  newRunId() {
    return crypto.randomBytes(8).toString('hex');
  }

  requestStart(runId, meta = {}) {
    this._activeRequests.set(runId, {
      startTime: Date.now(),
      phases: {},
      meta,
    });
  }

  phaseStart(runId, phaseName) {
    const req = this._activeRequests.get(runId);
    if (!req) return;
    req.phaseStart = Date.now();
    req.currentPhase = phaseName;
  }

  phaseEnd(runId, phaseName) {
    const req = this._activeRequests.get(runId);
    if (!req || !req.phaseStart) return;
    req.phases[phaseName] = Date.now() - req.phaseStart;
  }

  ragMetrics(runId, { chunksFound, topScore, pipeline, exactHit }) {
    const req = this._activeRequests.get(runId);
    if (!req) return;
    req.rag = { chunksFound: chunksFound || 0, topScore: topScore || 0, pipeline, exactHit: !!exactHit };

    if (chunksFound > 0) {
      this._dailyMetrics.ragHits++;
    } else {
      this._dailyMetrics.ragMisses++;
    }
    const total = this._dailyMetrics.ragHits + this._dailyMetrics.ragMisses;
    this._dailyMetrics.ragHitRate = total > 0
      ? Math.round((this._dailyMetrics.ragHits / total) * 100)
      : 0;
  }

  /**
   * Registra métricas de evaluación RAG.
   */
  evaluationMetrics(runId, evalResult) {
    const req = this._activeRequests.get(runId);
    if (!req) return;
    req.evaluation = evalResult;

    if (evalResult && evalResult.groundedness !== undefined) {
      this._dailyMetrics.groundednessSum += evalResult.groundedness;
      this._dailyMetrics.groundednessCount++;
      this._dailyMetrics.avgGroundedness = Math.round(
        (this._dailyMetrics.groundednessSum / this._dailyMetrics.groundednessCount) * 1000
      ) / 1000;
    }
  }

  /**
   * Registra uso de tokens y costo.
   */
  tokenUsage(runId, { inputTokens, outputTokens, model }) {
    const req = this._activeRequests.get(runId);
    if (!req) return;

    const costKey = TOKEN_COST_PER_1K[model] || TOKEN_COST_PER_1K.default;
    const cost = ((inputTokens || 0) / 1000) * costKey.input + ((outputTokens || 0) / 1000) * costKey.output;

    req.tokens = { input: inputTokens || 0, output: outputTokens || 0, model: model || 'default', cost };
    this._dailyMetrics.tokenInput += inputTokens || 0;
    this._dailyMetrics.tokenOutput += outputTokens || 0;
    this._dailyMetrics.totalCost += cost;
  }

  async requestEnd(runId, details = {}) {
    const req = this._activeRequests.get(runId);
    if (!req) return;

    const processingMs = details.processingMs || (Date.now() - req.startTime);

    const entry = {
      runId,
      ts: new Date().toISOString(),
      phone: details.phone || req.meta?.phone || 'unknown',
      query: details.query || '',
      processingMs,
      chain: details.chain || [],
      pipeline: details.pipeline || 'unknown',
      error: details.error || null,
      hadHallucination: details.hadHallucination || false,
      phases: req.phases || {},
      rag: req.rag || null,
      evaluation: req.evaluation || null,
      tokens: req.tokens || null,
      intent: req.meta?.intent,
    };

    this._appendMetrics(entry);
    if (details.hadHallucination) this._logHallucination(entry);

    this._dailyMetrics.totalRequests++;
    if (details.error) this._dailyMetrics.totalErrors++;
    if (details.hadHallucination) this._dailyMetrics.hallucinationCount++;

    const pipeline = details.pipeline || 'unknown';
    this._dailyMetrics.pipelineBreakdown[pipeline] =
      (this._dailyMetrics.pipelineBreakdown[pipeline] || 0) + 1;

    const n = this._dailyMetrics.totalRequests;
    this._dailyMetrics.avgLatencyMs = Math.round(
      (this._dailyMetrics.avgLatencyMs * (n - 1) + processingMs) / n
    );

    this._updateSessionStats(details.phone || 'unknown', {
      processingMs, error: !!details.error, hallucination: !!details.hadHallucination,
    });
    this._activeRequests.delete(runId);

    const status = details.error ? 'X' : details.hadHallucination ? '!' : '+';
    console.log(
      `[OBS] ${status} ${entry.phone} | ${processingMs}ms | ${pipeline} | ${(details.chain || []).join('->')}${req.tokens ? ` | $${req.tokens.cost.toFixed(4)}` : ''}`
    );

    if (this._dailyMetrics.totalRequests % 100 === 0) {
      console.log(this.buildHealthReport());
    }
  }

  getDailyMetrics() {
    return { ...this._dailyMetrics };
  }

  getSessionStats(userId) {
    return this._sessionStats.get(userId) || {
      requests: 0, totalMs: 0, errors: 0, avgLatencyMs: 0, hallucinations: 0, totalCost: 0,
    };
  }

  buildHealthReport() {
    const daily = this.getDailyMetrics();
    const errorRate = daily.totalRequests > 0
      ? Math.round((daily.totalErrors / daily.totalRequests) * 100) : 0;
    const hallucinationRate = daily.totalRequests > 0
      ? Math.round((daily.hallucinationCount / daily.totalRequests) * 100) : 0;

    const lines = [
      `=== Reporte de Salud ARIA — ${daily.date} ===`,
      `Requests: ${daily.totalRequests}`,
      `Latencia promedio: ${daily.avgLatencyMs}ms`,
      `Tasa de error: ${errorRate}%`,
      `Tasa de alucinación: ${hallucinationRate}%`,
      `RAG hit rate: ${daily.ragHitRate}%`,
      `Costo total: $${daily.totalCost.toFixed(4)}`,
      `Tokens (in/out): ${daily.tokenInput}/${daily.tokenOutput}`,
    ];

    if (daily.avgGroundedness > 0) {
      lines.push(`Groundedness promedio: ${Math.round(daily.avgGroundedness * 100)}%`);
    }

    lines.push(`--- Pipelines ---`);
    Object.entries(daily.pipelineBreakdown)
      .sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => lines.push(`  ${k}: ${v} requests`));

    return lines.join('\n');
  }

  buildWeeklyReport() {
    this._checkWeeklyRollover();
    const total = this._weeklyMetrics.reduce((s, m) => ({
      requests: s.requests + (m.totalRequests || 0),
      errors: s.errors + (m.totalErrors || 0),
      hallucinations: s.hallucinations + (m.hallucinationCount || 0),
      cost: s.cost + (m.totalCost || 0),
    }), { requests: 0, errors: 0, hallucinations: 0, cost: 0 });

    const avgLatency = this._weeklyMetrics.length > 0
      ? Math.round(this._weeklyMetrics.reduce((s, m) => s + (m.avgLatencyMs || 0), 0) / this._weeklyMetrics.length)
      : 0;
    const avgHitRate = this._weeklyMetrics.length > 0
      ? Math.round(this._weeklyMetrics.reduce((s, m) => s + (m.ragHitRate || 0), 0) / this._weeklyMetrics.length)
      : 0;
    const avgGrounded = this._weeklyMetrics.length > 0
      ? Math.round(this._weeklyMetrics.reduce((s, m) => s + (m.avgGroundedness || 0), 0) / this._weeklyMetrics.length * 100) / 100
      : 0;

    return [
      `=== Reporte Semanal ARIA ===`,
      `Período: ${this._weeklyMetrics[0]?.date || 'N/A'} — ${this._today()}`,
      `Total requests: ${total.requests}`,
      `Latencia promedio: ${avgLatency}ms`,
      `Tasa de error: ${total.requests > 0 ? Math.round((total.errors / total.requests) * 100) : 0}%`,
      `Tasa de alucinación: ${total.requests > 0 ? Math.round((total.hallucinations / total.requests) * 100) : 0}%`,
      `Hit rate RAG: ${avgHitRate}%`,
      `Groundedness promedio: ${(avgGrounded * 100).toFixed(1)}%`,
      `Costo total: $${total.cost.toFixed(4)}`,
      `Días registrados: ${this._weeklyMetrics.length}`,
      `=== Fin Reporte Semanal ===`,
    ].join('\n');
  }

  async evaluateRun(runId, { query, answer, contextChunks }) {
    const req = this._activeRequests.get(runId);
    if (!req) return null;

    try {
      const result = await answerEvaluator.evaluate({ query, answer, contextChunks });
      this.evaluationMetrics(runId, result);
      return result;
    } catch {
      return null;
    }
  }

  getRetrievalStats(lastN = 100) {
    return retrievalEvaluator.getStats(lastN);
  }

  getAnswerStats(lastN = 100) {
    return answerEvaluator.getStats(lastN);
  }

  _updateSessionStats(userId, { processingMs, error, hallucination }) {
    const stats = this._sessionStats.get(userId) || {
      requests: 0, totalMs: 0, errors: 0, avgLatencyMs: 0, hallucinations: 0, totalCost: 0,
    };
    stats.requests++;
    stats.totalMs += processingMs;
    if (error) stats.errors++;
    if (hallucination) stats.hallucinations++;
    stats.avgLatencyMs = Math.round(stats.totalMs / stats.requests);
    this._sessionStats.set(userId, stats);
  }

  _appendMetrics(entry) {
    try { fs.appendFileSync(METRICS_FILE, JSON.stringify(entry) + '\n'); } catch {}
  }

  _logHallucination(entry) {
    try { fs.appendFileSync(HALLUCINATION_LOG, JSON.stringify({ ...entry, severity: 'hallucination' }) + '\n'); } catch {}
  }

  _checkWeeklyRollover() {
    const today = this._today();
    if (this._dailyMetrics.date !== today) {
      this._weeklyMetrics.push({ ...this._dailyMetrics });
      if (this._weeklyMetrics.length > 14) this._weeklyMetrics.shift();
      this._saveWeeklyMetrics();
      this._dailyMetrics = {
        date: today,
        totalRequests: 0, totalErrors: 0, avgLatencyMs: 0,
        pipelineBreakdown: {}, hallucinationCount: 0,
        ragHits: 0, ragMisses: 0, ragHitRate: 0,
        tokenInput: 0, tokenOutput: 0, totalCost: 0,
        groundednessSum: 0, groundednessCount: 0, avgGroundedness: 0,
      };
    }
  }

  _today() {
    return new Date().toISOString().split('T')[0];
  }

  _ensureDataDir() {
    try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  }

  _loadWeeklyMetrics() {
    try {
      const file = path.join(DATA_DIR, 'weekly_metrics.json');
      if (fs.existsSync(file)) this._weeklyMetrics = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
  }

  _saveWeeklyMetrics() {
    try { fs.writeFileSync(path.join(DATA_DIR, 'weekly_metrics.json'), JSON.stringify(this._weeklyMetrics)); } catch {}
  }
}

module.exports = new ObservabilityV5();
