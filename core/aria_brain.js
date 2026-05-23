/**
 * AriaBrain v4.0 — Orquestador Principal MEJORADO
 *
 * MEJORAS sobre v3.1:
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  NUEVO FLUJO COGNITIVO                                  │
 *   │                                                         │
 *   │  INPUT                                                  │
 *   │    ↓                                                    │
 *   │  SessionEngine.getOrCreate()                            │
 *   │    ↓                                                    │
 *   │  PlannerEngine.plan()                                   │
 *   │    ↓                                                    │
 *   │  CognitiveRouter.route()  ← NUEVO: pipeline inteligente │
 *   │    ↓                                                    │
 *   │  KnowledgeGraph.buildGraphContext()  ← NUEVO            │
 *   │    ↓                                                    │
 *   │  ConsolidationEngine.buildProfileContext()  ← NUEVO     │
 *   │    ↓                                                    │
 *   │  CEOAgent.orchestrate()  (con routing awareness)        │
 *   │    ↓                                                    │
 *   │  ReasoningEngine.reason()  (con citation enforcement)   │
 *   │    ↓                                                    │
 *   │  [BACKGROUND] KnowledgeGraph.extractAndAdd()  ← NUEVO  │
 *   │  [BACKGROUND] ConsolidationEngine.onConversation()      │
 *   │    ↓                                                    │
 *   │  Observability.requestEnd()                             │
 *   │    ↓                                                    │
 *   │  RESPONSE                                               │
 *   └─────────────────────────────────────────────────────────┘
 */

const MemorySystem = require('./memory-layers/memory_system');
const PlannerEngine = require('./planner/planner_engine');
const ReasoningEngine = require('./reasoning/reasoning_engine');
const CEOAgent = require('./agents/ceo_agent');
const sessionEngine = require('./session/session_engine');
const observability = require('./observability/observability');
const OCRPipeline = require('../services/ocr/ocr_pipeline');
const RAGSystem = require('../services/rag/rag_system');
const DocumentProcessor = require('../services/document_processor');

const cognitiveRouter = require('./cognitive-router/cognitive_router');
const consolidationEngine = require('./memory-consolidation/consolidation_engine');
const knowledgeGraph = require('./knowledge-graph/knowledge_graph');
const contextCompressor = require('../services/rag/context_compressor');

class AriaBrain {
  constructor(memory) {
    this.memory = memory || new MemorySystem();
    this.planner = PlannerEngine;
    this.reasoning = ReasoningEngine;
    this.rag = new RAGSystem();
    this._ceoAgent = null;
  }

  async init() {
    if (this.rag.init) await this.rag.init();
    console.log('[AriaBrain] Inicializado (v4.0 — CognitiveRouter + KnowledgeGraph + Consolidation)');
  }

  _getCEOAgent() {
    if (!this._ceoAgent) {
      this._ceoAgent = new CEOAgent(this.memory, this.rag);
    }
    return this._ceoAgent;
  }

  async process(userId, message, senderInfo, sendFn) {
    const runId = observability.newRunId();
    const startTime = Date.now();

    const session = await sessionEngine.getOrCreate(userId);
    observability.requestStart(runId, { phone: userId, type: message.type, intent: null });

    try {
      if (message.type === 'audio') {
        return await this._processAudio(userId, message, session, runId, startTime);
      }
      if (message.type === 'image') {
        return await this._processImage(userId, message, session, runId, startTime);
      }
      if (message.type === 'document') {
        return await this._processDocument(userId, message, session, runId, startTime);
      }
      return await this._processText(userId, message.text || '', session, runId, startTime);
    } catch (err) {
      const processingMs = Date.now() - startTime;
      observability.requestEnd(runId, { phone: userId, processingMs, error: err.message });
      console.error('[AriaBrain] Error:', err);
      return { text: 'Ocurrió un error. Por favor intenta de nuevo.', type: 'text' };
    }
  }

  async _processText(userId, text, session, runId, startTime) {
    const activeDoc = this.memory.getActiveDocument(userId);
    const hasActiveDoc = !!activeDoc || (session.activeDocuments?.length > 0);

    // 1. PLANNER: qué quiere el usuario
    const plan = await this.planner.plan(text, {
      session,
      memory: this.memory,
      activeDocTitle: activeDoc?.title || null,
    });
    await sessionEngine.updateFromPlan(userId, plan, text);

    // 2. COGNITIVE ROUTER: cómo procesarlo (NUEVO v4.0)
    const routing = cognitiveRouter.route(text, plan, { hasActiveDoc });
    console.log(`[DEBUG] Pipeline: ${routing.pipeline} | Intent: ${plan.intent}`);

    // 3. KNOWLEDGE GRAPH: contexto de entidades relacionadas (NUEVO v4.0)
    const graphContext = knowledgeGraph.buildGraphContext(text, userId);

    // 4. COGNITIVE PROFILE: perfil semántico del usuario (NUEVO v4.0)
    const profileContext = consolidationEngine.buildProfileContext(userId);

    // 5. MEMORIA: historial + episódica + hechos
    const memoryContext = await this._buildMemoryContext(userId, session);

    // 6. CEO AGENT: orquesta agentes según plan + routing
    const ceo = this._getCEOAgent();
    const { enrichedContext, agentsUsed, confidence, citations } = await ceo.orchestrate(
      userId, text, plan, { routing }
    );

    // 7. CONSTRUIR CONTEXTO COMPLETO
    const contextParts = [memoryContext];
    if (profileContext) contextParts.push(profileContext);
    if (graphContext) contextParts.push(graphContext);
    if (enrichedContext) contextParts.push(enrichedContext);
    const fullContext = contextParts.filter(Boolean).join('\n\n');

    console.log('[DEBUG] Plan intent:', plan.intent, '| strategy:', plan.reasoningStrategy);
    console.log('[DEBUG] Context total chars:', fullContext.length);
    console.log('[DEBUG] Agents used:', agentsUsed);

    // 7b. CONTEXT COMPRESSION (NUEVO v5.0)
    const compressedContext = await contextCompressor.compress(fullContext, { query: text });

    // 8. CONFIDENCE CHECK
    const shouldRespond = !confidence || confidence.level !== 'low' || enrichedContext?.length > 0;
    if (!shouldRespond && plan.intent === 'doc_query') {
      const processingMs = Date.now() - startTime;
      observability.requestEnd(runId, { phone: userId, processingMs, chain: agentsUsed, hadHallucination: false });
      return {
        text: 'No encontré información suficiente en los documentos para responder con precisión. ¿Podrías especificar mejor la búsqueda o indicarme una página concreta?',
        type: 'text',
      };
    }

    // 9. REASONING: genera la respuesta final (contexto comprimido v5.0)
    const result = await this.reasoning.reason(text, compressedContext, plan, { routing, citations });

    // 10. RESPUESTA FINAL con citas
    let finalResponse = result.finalResponse;
    if (citations && (confidence?.level !== 'low' || enrichedContext)) {
      finalResponse += citations;
    }

    // 11. GUARDAR HECHOS del usuario
    this.memory.extractAndSaveFacts(userId, text);

    // 12. SHORT TERM MEMORY
    await sessionEngine.addToShortTermMemory(userId, text, result.response || finalResponse);
    if (this.memory.addEpisodic) {
      await this.memory.addEpisodic(userId, {
        userMessage: text,
        assistantResponse: result.response || finalResponse,
        intent: plan.intent,
      });
    }

    // 13. BACKGROUND: knowledge graph + consolidación (NUEVO v4.0)
    setImmediate(() => {
      knowledgeGraph.extractAndAdd(text + ' ' + (result.response || finalResponse), userId, 'conversation')
        .catch(() => {});

      consolidationEngine.onConversation(userId, {
        userMessage: text,
        assistantResponse: result.response || finalResponse,
        intent: plan.intent,
        topics: plan.requiredTools,
      }).catch(() => {});
    });

    const processingMs = Date.now() - startTime;
    observability.requestEnd(runId, {
      phone: userId, processingMs, chain: agentsUsed, hadHallucination: result.hadHallucination,
      pipeline: routing.pipeline,
    });

    return { text: finalResponse, type: 'text' };
  }

  async _processAudio(userId, message, session, runId, startTime) {
    let transcription = '';
    try {
      const AudioTranscriber = require('../agents/audio_transcriber');
      const transcriber = new AudioTranscriber();
      transcription = await transcriber.transcribe(message.buffer, message.mimetype);
    } catch (err) {
      console.warn('[AriaBrain] STT falló:', err.message);
      return { text: 'No pude transcribir el audio. ¿Puedes escribirme el mensaje?', type: 'text' };
    }
    if (!transcription || transcription.length < 2) {
      return { text: 'No escuché nada en el audio. ¿Puedes intentarlo de nuevo?', type: 'text' };
    }
    const result = await this._processText(userId, transcription, session, runId, startTime);
    result.transcription = transcription;
    return result;
  }

  async _processImage(userId, message, session, runId, startTime) {
    try {
      const ocrResult = await OCRPipeline.recognize(message.buffer, { lang: 'es' });
      let contextText = message.text || '';
      if (ocrResult.text && ocrResult.text.length > 10) {
        contextText += `\n\n[Texto extraído (${ocrResult.engine})]:\n${ocrResult.text}`;
      }
      return await this._processText(userId, contextText || '¿Qué ves en esta imagen?', session, runId, startTime);
    } catch (err) {
      console.warn('[AriaBrain] Error procesando imagen:', err.message);
      return { text: 'No pude procesar la imagen.', type: 'text' };
    }
  }

  async _processDocument(userId, message, session, runId, startTime) {
    try {
      const processor = new DocumentProcessor();
      const parsed = await processor.extract(message.buffer, message.mimetype, message.fileName);

      if (parsed && parsed.text) {
        const docId = `doc_${Date.now()}`;
        await this.rag.indexDocument({
          userId, docId,
          docTitle: message.fileName || 'Documento',
          text: parsed.text,
          type: parsed.type,
          pages: parsed.pages || null,
        });
        await sessionEngine.addActiveDocument(userId, docId);
        this.memory.saveDocument(userId, {
          title: message.fileName || 'Documento',
          text: parsed.text,
          pages: parsed.pages || [],
          totalPages: parsed.totalPages || 0,
          type: parsed.type || 'document',
          docId,
        });

        setImmediate(() => {
          knowledgeGraph.extractAndAdd(
            parsed.text.substring(0, 1500),
            userId,
            'document'
          ).catch(() => {});
        });
      }

      const processingMs = Date.now() - startTime;
      observability.requestEnd(runId, { phone: userId, processingMs });

      return {
        text: `✅ Documento "${message.fileName}" procesado e indexado.${parsed?.totalPages ? ` (${parsed.totalPages} páginas)` : ''}\n\n¿Sobre qué quieres consultar?`,
        type: 'text',
      };
    } catch (err) {
      console.error('[AriaBrain] Error procesando documento:', err);
      return { text: 'No pude procesar el documento. Asegúrate de que sea PDF, DOCX, Excel o TXT.', type: 'text' };
    }
  }

  async _buildMemoryContext(userId, session) {
    const parts = [];
    if (session.shortTermMemory?.length > 0) {
      const h = session.shortTermMemory.slice(-4)
        .map(m => `Usuario: ${m.user}\nARIA: ${m.assistant}`).join('\n\n');
      parts.push(`[HISTORIAL RECIENTE]\n${h}`);
    }
    try {
      const episodic = await this.memory.getEpisodic?.(userId, 3);
      if (episodic?.length > 0) {
        const e = episodic.map(e => `- ${e.summary || e.userMessage?.substring(0, 100)}`).join('\n');
        parts.push(`[MEMORIA EPISÓDICA]\n${e}`);
      }
    } catch (_) {}
    try {
      const facts = this.memory.getFacts?.(userId);
      if (facts && Object.keys(facts).length > 0) {
        const f = Object.entries(facts).map(([k, v]) => `${k}: ${typeof v === 'object' ? v.value : v}`).join(', ');
        parts.push(`[PERFIL]\n${f}`);
      }
    } catch (_) {}

    try {
      const insights = consolidationEngine.getRelevantInsights(userId, '');
      if (insights.length > 0) {
        parts.push(`[INSIGHTS DE USUARIO]\n${insights.map(i => `• ${i}`).join('\n')}`);
      }
    } catch (_) {}

    return parts.join('\n\n');
  }
}

module.exports = AriaBrain;
