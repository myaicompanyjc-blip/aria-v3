/**
 * ReasoningEngine v5.0 — Self-Consistency + Verifier
 *
 * MEJORAS v5.0 sobre v4.0:
 *   1. Temperature sweep: múltiples drafts con distintas temperaturas
 *   2. Verifier pass: verificación factual contra el contexto
 *   3. Contradiction detection: detecta contradicciones draft vs contexto
 *   4. Answer ranking: scoring y selección del mejor draft
 *   5. Uncertainty modeling: confianza explícita por afirmación
 *
 * v4.0 era: Citation-First + Self-Consistency (2 drafts) + Structured Output
 * v5.0 es: Temperature Sweep → Verifier → Contradiction Detection → Rank → Synthesize
 */

const llm = require('../../lib/llm_client');
const citationEngine = require('../anti-hallucination/citation_enforcement');

// ─── REASONER v5.0 ────────────────────────────────────────────────────────────

const REASONER_PROMPT = `Eres el módulo Reasoner de ARIA. Tu función es generar una respuesta DRAFT de alta calidad.
Razona paso a paso antes de responder.
Basa tu respuesta EXCLUSIVAMENTE en la información provista en el contexto.
Si algo no está en el contexto, admítelo claramente.
Sé específico, útil y en español colombiano.`;

class Reasoner {
  async think(message, context, plan, opts = {}) {
    const strategy = plan.reasoningStrategy;
    const routing = opts.routing || {};

    if (routing.structuredOutput) return await this._thinkStructured(message, context);

    let prompt;
    if (strategy === 'chain-of-thought') {
      prompt = `Razona paso a paso para responder: "${message}"\n\nContexto:\n${context}\n\nPrimero piensa en voz alta (brevemente), luego da tu respuesta final.`;
    } else if (strategy === 'rag') {
      prompt = `El usuario pregunta: "${message}"\n\nDocumentos recuperados:\n${context}\n\nResponde SOLO con información que esté en los documentos. Si no está, dilo.`;
    } else if (strategy === 'research') {
      prompt = `El usuario quiere saber: "${message}"\n\nResultados de búsqueda:\n${context}\n\nSintetiza la información y cita fuentes.`;
    } else {
      prompt = `Responde al usuario: "${message}"\n\nContexto relevante:\n${context}`;
    }

    return await llm.chat([
      { role: 'system', content: REASONER_PROMPT },
      { role: 'user', content: prompt }
    ], { maxTokens: 1500, temperature: opts.temperature || 0.6 });
  }

  async _thinkStructured(message, context) {
    const prompt = `El usuario pide: "${message}"\n\nContexto disponible:\n${context}\n\nProporciona la respuesta en formato estructurado (lista o tabla si aplica). Sé completo y organizado.`;
    return await llm.chat([
      { role: 'system', content: REASONER_PROMPT + '\nCuando corresponda, usa formato de lista o tabla Markdown para mayor claridad.' },
      { role: 'user', content: prompt }
    ], { maxTokens: 2000, temperature: 0.4 });
  }
}

// ─── REFLECTOR (sin cambios) ─────────────────────────────────────────────────

const REFLECTOR_PROMPT = `Eres el módulo Reflector de ARIA. Evalúas si una respuesta es coherente y útil.
Analiza: 1. ¿Responde la pregunta? 2. ¿Es coherente con el contexto? 3. ¿Falta algo importante? 4. ¿Tono apropiado?
Responde con JSON: {"isCoherent":bool, "answersQuestion":bool, "missingElements":[], "score":0.0-1.0}`;

class Reflector {
  async evaluate(draft, originalMessage, context) {
    try {
      const raw = await llm.chat([
        { role: 'system', content: REFLECTOR_PROMPT },
        { role: 'user', content: `Pregunta: "${originalMessage}"\n\nDraft:\n${draft}\n\nContexto:\n${context.substring(0, 2000)}\n\nEvalúa:` }
      ], { maxTokens: 300, temperature: 0.2 });
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch {}
    return { isCoherent: true, answersQuestion: true, missingElements: [], score: 0.7, improvements: [] };
  }
}

// ─── CRITIC v5.0 — Verificador factual + detección de contradicciones ─────────

const CRITIC_PROMPT = `Eres el módulo Critic de ARIA. Detectas errores, alucinaciones e inconsistencias.
Busca: 1. Afirmaciones SIN soporte en el contexto (alucinación) 2. Contradicciones internas 3. Cifras sin fuente 4. Información potencialmente incorrecta
Responde con JSON:
{"hasHallucinations":bool, "hallucinatedFacts":[], "hasContradictions":bool, "contradictions":[], "unsourcedClaims":[], "overallRisk":"low|medium|high", "shouldRevise":bool, "revisionNote":"", "factualConsistency":0.0-1.0}`;

class Critic {
  async critique(draft, originalMessage, context) {
    try {
      const raw = await llm.chat([
        { role: 'system', content: CRITIC_PROMPT },
        { role: 'user', content: `Pregunta: "${originalMessage}"\n\nRespuesta:\n${draft}\n\nContexto:\n${context.substring(0, 2000)}\n\nAnaliza:` }
      ], { maxTokens: 300, temperature: 0.1 });
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch {}
    return { hasHallucinations: false, overallRisk: 'low', shouldRevise: false, factualConsistency: 0.85 };
  }
}

// ─── VERIFIER v5.0 — Verificación factual post-hoc ────────────────────────────

class Verifier {
  /**
   * Verifica afirmación por afirmación contra el contexto.
   * Retorna un score de veracidad por afirmación.
   */
  async verify(draft, context) {
    try {
      const raw = await llm.chat([{
        role: 'user',
        content: `Eres un verificador factual. Para cada afirmación en la respuesta, indica si está soportada por el contexto.

Contexto:
${context.substring(0, 3000)}

Respuesta:
${draft}

Responde SOLO con JSON:
{
  "claims": [
    {"claim": "afirmación textual", "supported": true/false, "confidence": 0.0-1.0, "evidence": "texto del contexto que la soporta o null"}
  ],
  "overallScore": 0.0-1.0,
  "uncertaintyNote": "si hay algo incierto, explicar"
}`
      }], { maxTokens: 400, temperature: 0.1 });

      const match = raw.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    } catch {}
    return { claims: [], overallScore: 0.7, uncertaintyNote: '' };
  }
}

// ─── SYNTHESIZER v5.0 — Síntesis con ranking ──────────────────────────────────

const SYNTHESIZER_PROMPT = `Eres el módulo Synthesizer de ARIA. Construyes la respuesta FINAL basándote en drafts, verificaciones y críticas.
Mantén tono profesional y cálido en español colombiano.
NO menciones el proceso interno. Responde directo y útil.`;

class Synthesizer {
  async synthesize(drafts, verifications, critique, originalMessage) {
    // Si hay drafts, elegir el mejor según verificación
    if (drafts.length > 1) {
      const ranked = drafts.map((draft, i) => ({
        draft,
        score: (verifications[i]?.overallScore || 0.7) * 0.5 + (verifications[i]?.claims?.filter(c => c.supported).length / Math.max(verifications[i]?.claims?.length || 1, 1)) * 0.3 + 0.2,
      })).sort((a, b) => b.score - a.score);

      const bestDraft = ranked[0].draft;

      // Si el mejor draft no necesita revisión, devolverlo
      if (!critique.hasHallucinations && critique.overallRisk !== 'high' && ranked[0].score > 0.75) {
        return bestDraft;
      }
    }

    const bestDraft = drafts[0];
    if (!critique.hasHallucinations && critique.overallRisk === 'low') return bestDraft;

    const improvements = [];
    if (critique.hallucinatedFacts?.length > 0) {
      improvements.push(`Eliminar afirmaciones sin base: ${critique.hallucinatedFacts.join(', ')}`);
    }
    if (critique.contradictions?.length > 0) {
      improvements.push(`Resolver contradicciones: ${critique.contradictions.join(', ')}`);
    }
    if (critique.revisionNote) improvements.push(critique.revisionNote);

    if (improvements.length === 0) return bestDraft;

    try {
      const improved = await llm.chat([
        { role: 'system', content: SYNTHESIZER_PROMPT },
        { role: 'user', content: `Pregunta: "${originalMessage}"\n\nDraft:\n${bestDraft}\n\nMejoras:\n${improvements.map(i => `- ${i}`).join('\n')}\n\nProduce respuesta mejorada final:` }
      ], { maxTokens: 1500, temperature: 0.5 });
      return improved || bestDraft;
    } catch { return bestDraft; }
  }
}

// ─── REASONING ENGINE v5.0 (Orquestador) ─────────────────────────────────────

class ReasoningEngine {
  constructor() {
    this.reasoner = new Reasoner();
    this.reflector = new Reflector();
    this.critic = new Critic();
    this.synthesizer = new Synthesizer();
    this.verifier = new Verifier();
  }

  async reason(message, context, plan, opts = {}) {
    const startTime = Date.now();
    const routing = opts.routing || {};
    const isComplex = plan.estimatedComplexity !== 'low' && plan.reasoningStrategy !== 'direct';
    const isHighRisk = routing.pipeline === 'doc_exact_query' || routing.pipeline === 'doc_multi_hop' || routing.pipeline === 'doc_compare';

    // ── CITATION-FIRST REASONING (cuando hay chunks) ──────────────────────
    if (opts.chunks && opts.chunks.length > 0 && plan.intent === 'doc_query') {
      try {
        const citationResult = await citationEngine.generateWithCitations(message, opts.chunks, plan);
        if (citationResult.response && citationResult.response.length > 50) {
          const footer = citationResult.citations.length > 0 ? citationEngine.formatCitationFooter(citationResult.citations) : '';
          return {
            finalResponse: citationResult.response + footer,
            draft: citationResult.response,
            reflection: null, critique: null,
            citations: citationResult.citations,
            processingMs: Date.now() - startTime,
            chain: ['citation_engine'],
            hadHallucination: false,
            factualConsistency: 0.95,
          };
        }
      } catch (err) {
        console.warn('[Reasoning] Citation-first falló:', err.message);
      }
    }

    if (!isComplex) {
      const draft = await this.reasoner.think(message, context, plan, { routing });
      return {
        finalResponse: draft, draft,
        reflection: null, critique: null,
        processingMs: Date.now() - startTime,
        chain: ['reasoner'],
        hadHallucination: false, factualConsistency: 0.8,
      };
    }

    // ── TEMPERATURE SWEEP v5.0 ────────────────────────────────────────────
    // Generar múltiples drafts con temperaturas variadas
    const temperatures = isHighRisk ? [0.2, 0.5, 0.7] : [0.5, 0.7];
    const drafts = await Promise.all(
      temperatures.map(temp =>
        this.reasoner.think(message, context, plan, { routing, temperature: temp })
          .catch(() => null)
      )
    );
    const validDrafts = drafts.filter(Boolean);
    if (validDrafts.length === 0) {
      const draft = await this.reasoner.think(message, context, plan, { routing, temperature: 0.6 });
      return { finalResponse: draft, draft, reflection: null, critique: null, processingMs: Date.now() - startTime, chain: ['reasoner'], hadHallucination: false, factualConsistency: 0.7 };
    }

    // ── VERIFIER PASS v5.0 ───────────────────────────────────────────────
    // Verificar cada draft contra el contexto
    const verifications = await Promise.all(
      validDrafts.map(d => this.verifier.verify(d, context).catch(() => ({ overallScore: 0.7, claims: [] })))
    );

    // ── CRITIC: evaluar el mejor draft ────────────────────────────────────
    const bestIdx = verifications.reduce((best, v, i, arr) =>
      (v.overallScore || 0) > (arr[best].overallScore || 0) ? i : best, 0);
    const bestDraft = validDrafts[bestIdx];
    const bestVerification = verifications[bestIdx];

    const [reflection, critique] = await Promise.all([
      this.reflector.evaluate(bestDraft, message, context),
      this.critic.critique(bestDraft, message, context),
    ]);

    console.log(`[Reasoning] Drafts: ${validDrafts.length} | Best score: ${bestVerification?.overallScore?.toFixed(2)} | Risk: ${critique.overallRisk}`);

    // ── SELF-CONSISTENCY CHECK (alto riesgo) ──────────────────────────────
    let finalResponse;
    if (critique.overallRisk === 'high' && plan.intent === 'doc_query') {
      finalResponse = await this._selfConsistencyFinal(message, context, plan, validDrafts, verifications, routing);
    } else {
      // ── SYNTHESIZER con ranking ────────────────────────────────────────
      finalResponse = await this.synthesizer.synthesize(validDrafts, verifications, critique, message);
    }

    return {
      finalResponse,
      draft: bestDraft,
      reflection,
      critique,
      processingMs: Date.now() - startTime,
      chain: ['reasoner_sweep', 'verifier', 'reflector', 'critic', 'synthesizer'],
      hadHallucination: critique.hasHallucinations || false,
      factualConsistency: bestVerification?.overallScore || 0.7,
      uncertaintyNote: bestVerification?.uncertaintyNote || '',
    };
  }

  async _selfConsistencyFinal(message, context, plan, drafts, verifications, routing) {
    // Tomar los 2 mejores drafts
    const ranked = drafts.map((d, i) => ({ draft: d, score: verifications[i]?.overallScore || 0.7 }))
      .sort((a, b) => b.score - a.score);

    if (ranked.length < 2) return ranked[0]?.draft || '';

    try {
      const selector = await llm.chat([{
        role: 'user',
        content: `Tienes dos respuestas para "${message}". Elige la más factualmente precisa o sintetiza solo lo que ambas confirman.\n\nA:\n${ranked[0].draft.substring(0, 600)}\n\nB:\n${ranked[1].draft.substring(0, 600)}\n\nElige o sintetiza:`
      }], { maxTokens: 1000, temperature: 0.2 });
      return selector || ranked[0].draft;
    } catch { return ranked[0].draft; }
  }
}

module.exports = new ReasoningEngine();
