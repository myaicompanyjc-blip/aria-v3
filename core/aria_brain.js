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
const MarkItDownProcessor = require('../services/markitdown_processor');
const llm = require('../lib/llm_client');

const cognitiveRouter = require('./cognitive-router/cognitive_router');
const consolidationEngine = require('./memory-consolidation/consolidation_engine');
const knowledgeGraph = require('./knowledge-graph/knowledge_graph');
const contextCompressor = require('../services/rag/context_compressor');
const topicManager = require('./context/topic_manager');
const reflectionAgent = require('./agents/reflection_agent');
const taskMemory = require('./memory/task_memory');

class AriaBrain {
  constructor(memory) {
    this.memory = memory || new MemorySystem();
    this.planner = PlannerEngine;
    this.reasoning = ReasoningEngine;
    this.rag = new RAGSystem();
    this._ceoAgent = null;
  }

  async init() {
    try {
      if (this.rag.init) await this.rag.init();
    } catch (err) {
      console.warn('[AriaBrain] RAG init falló, continuando sin vector store:', err.message);
    }
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

    // BYPASS: consulta de página específica o seguimiento
    const pageMatch = text.match(/(?:p[aá]gina\s*#?(\d+))|(?:es[ae]\s+p[aá]gina|que\s+(?:sabes|contiene|dice)\s+(?:de\s+)?(?:esa|la|esta)\s+p[aá]gina)/i);
    if (pageMatch && activeDoc && activeDoc.pages) {
      let pageNum = parseInt(pageMatch[1]);
      // Si no hay número en el match, buscar la última página consultada
      if (!pageNum) {
        const lastPageFact = this.memory.getFacts?.(userId)?.['ultima_pagina_consultada'];
        pageNum = lastPageFact ? parseInt(lastPageFact) : null;
      }
      if (!pageNum || pageNum < 1 || pageNum > activeDoc.pages.length) {
        pageNum = 1;
      }
      let pageText = activeDoc.pages[pageNum - 1];
      if (pageText) {
        // Limpiar: si empieza con minúscula (palabra partida de página anterior),
        // unir con el final de la página anterior
        if (/^[a-zñáéíóú]/.test(pageText.trim()) && pageNum > 1 && activeDoc.pages[pageNum - 2]) {
          const prevPage = activeDoc.pages[pageNum - 2];
          const lastWord = prevPage.trim().split(/\s+/).pop() || '';
          pageText = lastWord + pageText;
        }

        // Eliminar encabezados/pies de página repetitivos
        const cleanText = pageText
          .replace(/FO-COP-\d+\s*V\d+/gi, '')
          .replace(/(?:Edificio World Business Port|Conmutador:.*?348\s*78\s*00|Línea Gratuita:.*?018000\s*910\s*110|Correo institucional:.*?ssf@ssf\.gov\.co)/gi, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

        const processingMs = Date.now() - startTime;

        // Enviar al LLM para que explique el contenido de la página
        try {
          const llmResponse = await llm.chat([
            { role: 'system', content: `Eres ARIA, asistente de Anhermer Investment LLC.
El usuario te preguntó qué contiene la página ${pageNum} de un documento.

INSTRUCCIÓN CRÍTICA: NO incluyas tu proceso de razonamiento. Responde ÚNICAMENTE con tu respuesta final. No expliques cómo llegaste a la respuesta. No incluyas listas de pasos ni análisis.

Aquí está el texto exacto extraído de esa página:

${cleanText}

Tu tarea: Explica de forma CLARA y ORDENADA qué contiene esta página.
- Si hay tablas, describe las columnas y la información principal.
- Si hay cifras, menciónalas en contexto.
- Si es un listado, enumera los elementos principales.
- Si es texto narrativo, resúmelo.
NO inventes información que no esté en el texto.
Responde en español colombiano, tono profesional y directo.` }
          ], { maxTokens: 1000, temperature: 0.3 });

          if (llmResponse && llmResponse.length > 10) {
            // Guardar hecho: última página consultada + contenido
            if (this.memory.extractAndSaveFacts) {
              try {
                this.memory.extractAndSaveFacts(userId, `ultima_pagina_consultada=${pageNum}`);
                this.memory.extractAndSaveFacts(userId, `La página ${pageNum} del documento "${activeDoc.title}" contiene información sobre: ${llmResponse.substring(0, 300)}`);
              } catch {}
            }
            observability.requestEnd(runId, { phone: userId, processingMs, chain: ['page_bypass_llm'] });
            return { text: llmResponse, type: 'text' };
          }
        } catch (llmErr) {
          console.warn('[AriaBrain] LLM en bypass de página falló:', llmErr.message);
        }

        // Fallback: texto limpio sin LLM
        observability.requestEnd(runId, { phone: userId, processingMs, chain: ['page_bypass'] });
        return {
          text: `*Página ${pageNum}* del documento "${activeDoc.title}":\n\n${cleanText}`,
          type: 'text',
        };
      }
    }

    // 1. PLANNER: qué quiere el usuario
    const plan = await this.planner.plan(text, {
      session,
      memory: this.memory,
      activeDocTitle: activeDoc?.title || null,
    });
    // 2. COGNITIVE ROUTER: cómo procesarlo (NUEVO v4.0)
    const routing = cognitiveRouter.route(text, plan, { hasActiveDoc });
    console.log(`[DEBUG] Pipeline: ${routing.pipeline} | Intent: ${plan.intent}`);

    // 3. TOPIC ISOLATION: decidir qué contexto puede entrar (con detección semántica v5.0)
    const topicPolicy = await topicManager.buildPolicy(session, text, plan, routing);
    session = await sessionEngine.updateFromPlan(userId, plan, text, { topicPolicy });
    console.log(`[DEBUG] Topic: ${topicPolicy.previousTopic || 'none'} → ${topicPolicy.activeTopic} | ${topicPolicy.reason}`);

    // 4. KNOWLEDGE GRAPH: contexto de entidades relacionadas (solo fuera de web aislada)
    const graphContext = topicPolicy.activeTopic === 'web'
      ? ''
      : knowledgeGraph.buildGraphContext(text, userId);

    // 5. COGNITIVE PROFILE: perfil semántico del usuario
    const profileContext = topicPolicy.memoryMode === 'facts_only'
      ? ''
      : consolidationEngine.buildProfileContext(userId);

    // 6. MEMORIA: historial + episódica + hechos, según política de aislamiento
    const memoryContext = await this._buildMemoryContext(userId, session, {
      mode: topicPolicy.memoryMode,
      query: text,
    });

    // 7. CEO AGENT: orquesta agentes según plan + routing
    const ceo = this._getCEOAgent();
    const { enrichedContext, agentsUsed, confidence, citations, chunks } = await ceo.orchestrate(
      userId, text, plan, { routing }
    );

    // 7b. TASK MEMORY: seguimiento persistente de tareas
    const taskContext = taskMemory.formatForLLM(userId);
    let activeTask = taskMemory.getActiveTask(userId);
    if (!activeTask || plan.intent !== activeTask.intent) {
      activeTask = taskMemory.createTask(userId, {
        title: plan.objective || text.substring(0, 80),
        intent: plan.intent,
        documents: session.activeDocuments || [],
        tools: plan.requiredTools || [],
        context: text,
      });
    } else {
      taskMemory.updateTask(activeTask.id, { contextSummary: text });
    }

    // 8. CONSTRUIR CONTEXTO COMPLETO
    const contextParts = [memoryContext];
    if (taskContext) contextParts.push('[TAREAS]\n' + taskContext);
    if (profileContext) contextParts.push(profileContext);
    if (graphContext) contextParts.push(graphContext);
    if (enrichedContext) contextParts.push(enrichedContext);
    const fullContext = contextParts.filter(Boolean).join('\n\n');

    console.log('[DEBUG] Plan intent:', plan.intent, '| strategy:', plan.reasoningStrategy);
    console.log('[DEBUG] Context total chars:', fullContext.length);
    console.log('[DEBUG] Agents used:', agentsUsed);

    // 8b. CONTEXT COMPRESSION (NUEVO v5.0)
    const compressedContext = await contextCompressor.compress(fullContext, { query: text });

    // 9. CONFIDENCE CHECK
    const shouldRespond = !confidence || confidence.level !== 'low' || enrichedContext?.length > 0 || hasActiveDoc;
    if (!shouldRespond && plan.intent === 'doc_query') {
      const processingMs = Date.now() - startTime;
      observability.requestEnd(runId, { phone: userId, processingMs, chain: agentsUsed, hadHallucination: false });
      return {
        text: 'No encontré información suficiente en los documentos para responder con precisión. ¿Podrías especificar mejor la búsqueda o indicarme una página concreta?',
        type: 'text',
      };
    }

    // 10. REASONING: genera la respuesta final (contexto comprimido v5.0)
    const result = await this.reasoning.reason(text, compressedContext, plan, { routing, citations, chunks });

    // 11. RESPUESTA FINAL con citas
    let finalResponse = result.finalResponse;
    if (citations && (confidence?.level !== 'low' || enrichedContext)) {
      finalResponse += citations;
    }

    // 11b. REFLECTION AGENT: gatekeeper final (NUEVO)
    const reflection = await reflectionAgent.reflect(finalResponse, compressedContext, {
      intent: plan.intent,
      activeTopic: topicPolicy.activeTopic,
      originalMessage: text,
    });
    if (reflection.verdict !== 'PASS') {
      console.log(`[ReflectionAgent] ${reflection.verdict}: ${reflection.reasoning}`);
      if (reflection.verdict === 'BLOCK') {
        finalResponse = 'No tengo suficiente información para responder con precisión. ¿Podrías reformular la pregunta?';
      } else if (reflection.verdict === 'REVISE') {
        const revised = await reflectionAgent.revise(finalResponse, reflection.revisionHint);
        if (revised && revised.length > 10) finalResponse = revised;
      }
    }

    // 11c. ACTUALIZAR TASK MEMORY con resultado
    if (activeTask) {
      taskMemory.updateTask(activeTask.id, {
        contextSummary: `Usuario: ${text}\nARIA: ${(result.response || finalResponse).substring(0, 300)}`,
      });
    }

    // 12. GUARDAR HECHOS del usuario
    this.memory.extractAndSaveFacts(userId, text);

    // 13. SHORT TERM MEMORY
    await sessionEngine.addToShortTermMemory(userId, text, result.response || finalResponse);
    if (this.memory.addEpisodic) {
      await this.memory.addEpisodic(userId, {
        userMessage: text,
        assistantResponse: result.response || finalResponse,
        intent: plan.intent,
      });
    }

    // 14. BACKGROUND: knowledge graph + consolidación (NUEVO v4.0)
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
      reflectionVerdict: reflection.verdict,
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
      let parsed = await MarkItDownProcessor.extract(message.buffer, message.mimetype, message.fileName);
      if (!parsed || !parsed.text) {
        console.log('[AriaBrain] MarkItDown falló, usando DocumentProcessor como fallback');
        const processor = new DocumentProcessor();
        parsed = await processor.extract(message.buffer, message.mimetype, message.fileName);
      }

      // Para PDFs: pdf-parse para páginas exactas (saltos \x0C) + MarkItDown para RAG
      let pdfPages = null;
      let pdfTotalPages = 0;
      const ext = (message.fileName || '').match(/\.(\w+)$/)?.[1]?.toLowerCase();
      if (ext === 'pdf') {
        try {
          const pdfParse = require('pdf-parse');
          const pdfData = await pdfParse(message.buffer, { max: 0 });
          const rawText = pdfData.text || '';
          pdfTotalPages = pdfData.numpages;
          pdfPages = rawText.split(/\x0C/).filter(p => p.trim().length > 0);
          if (pdfPages.length < pdfTotalPages * 0.5) {
            const cpp = Math.ceil(rawText.length / pdfTotalPages);
            pdfPages = [];
            for (let i = 0; i < pdfTotalPages; i++) {
              const s = i * cpp, e = Math.min(s + cpp, rawText.length);
              const pt = rawText.substring(s, e).trim();
              if (pt) pdfPages.push(pt);
            }
          }
          // pdf-parse para páginas exactas, MarkItDown (parsed.text) para RAG
          parsed.pages = pdfPages;
          parsed.totalPages = pdfTotalPages;
          console.log(`[AriaBrain] ${pdfTotalPages} páginas reales desde pdf-parse`);
        } catch (pdfErr) {
          console.warn('[AriaBrain] pdf-parse falló:', pdfErr.message);
        }
      }

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
        text: `✅ Documento "${message.fileName}" procesado e indexado.${parsed?.totalPages ? ` (${parsed.totalPages} ${parsed.totalPages === 1 ? 'página' : 'páginas'})` : ''}\n\n¿Sobre qué quieres consultar?`,
        type: 'text',
      };
    } catch (err) {
      console.error('[AriaBrain] Error procesando documento:', err);
      return { text: 'No pude procesar el documento. Asegúrate de que sea PDF, DOCX, Excel o TXT.', type: 'text' };
    }
  }

  async _buildMemoryContext(userId, session, opts = {}) {
    const parts = [];
    const mode = opts.mode || 'normal';

    try {
      const facts = this.memory.getFacts?.(userId);
      if (facts && Object.keys(facts).length > 0) {
        const f = Object.entries(facts).map(([k, v]) => `${k}: ${typeof v === 'object' ? v.value : v}`).join(', ');
        parts.push(`[PERFIL]\n${f}`);
      }
    } catch (_) {}

    if (mode === 'facts_only') {
      return parts.join('\n\n');
    }

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
      const insights = consolidationEngine.getRelevantInsights(userId, opts.query || '');
      if (insights.length > 0) {
        parts.push(`[INSIGHTS DE USUARIO]\n${insights.map(i => `• ${i}`).join('\n')}`);
      }
    } catch (_) {}

    return parts.join('\n\n');
  }
}

module.exports = AriaBrain;
