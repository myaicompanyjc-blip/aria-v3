/**
 * PlannerEngine — Motor de planificación de ARIA v3
 *
 * BRECHA 1 RESUELTA: El modelo NUNCA responde directo.
 * Siempre planifica primero (PlannerOutput) antes de ejecutar.
 *
 * Flujo correcto:
 *   INPUT → PLANNER → PLAN → EXECUTOR → REFLECTOR → CRITIC → RESPONSE
 *
 * Diferencia entre chatbot y Cognitive Operating System.
 */

const llm = require('../../lib/llm_client');

// Estrategias de razonamiento disponibles
const REASONING_STRATEGIES = {
  DIRECT: 'direct',               // Respuesta directa (saludos, preguntas simples)
  CHAIN_OF_THOUGHT: 'chain-of-thought', // Razonamiento paso a paso
  RESEARCH: 'research',           // Requiere búsqueda web
  RAG: 'rag',                     // Requiere búsqueda en documentos
  MULTIMODAL: 'multimodal',       // Involucra imagen o audio
  CREATIVE: 'creative',           // Generación creativa (imágenes, docs)
  ANALYTICAL: 'analytical',       // Análisis complejo de datos
};

const PLANNING_SYSTEM_PROMPT = `Eres el planificador de ARIA. Solo produces JSON. Sin explicaciones, sin markdown, sin texto extra.
Campos requeridos: objective, intent, reasoningStrategy, requiredTools, estimatedComplexity.
intent: conversation|doc_query|web_search|image_generate|help
reasoningStrategy: direct|chain-of-thought|rag|research
requiredTools: ["rag","web_search","ocr","stt"]
estimatedComplexity: low|medium|high

Ejemplo: {"objective":"responder salud","intent":"conversation","reasoningStrategy":"direct","requiredTools":[],"estimatedComplexity":"low"}`;

class PlannerEngine {
  constructor() {
    this._planCache = new Map(); // Cache de planes por hash de mensaje
    this._CACHE_TTL = 60000; // 1 minuto
  }

  /**
   * Genera un plan de ejecución para el mensaje del usuario.
   * NUNCA responde directamente al usuario.
   *
   * @param {string} message - Mensaje del usuario
   * @param {Object} context - Contexto de sesión
   * @returns {Promise<PlannerOutput>} Plan estructurado
   */
  async plan(message, context = {}) {
    // Para mensajes muy cortos o comandos exactos, usar fast-plan
    const fastPlan = this._fastPlan(message, context);
    if (fastPlan) return fastPlan;

    // LLM planning para casos complejos
    try {
      const hasActiveDoc = this._hasActiveDocument(context);
      const contextSummary = this._buildContextSummary(context);

      const planRaw = await llm.chat([
        { role: 'system', content: PLANNING_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Mensaje del usuario: "${message}"\n\nContexto de sesión:\n${contextSummary}\n\nGenera el plan JSON:`
        }
      ], {
        maxTokens: 2048,
        temperature: 0.1, // Baja temperatura para planificación determinista
      });

      const plan = this._parsePlan(planRaw, message);
      return plan;

    } catch (err) {
      console.warn('[Planner] LLM planning falló, usando fallback:', err.message);
      return this._fallbackPlan(message, context);
    }
  }

  /**
   * Plan rápido para casos conocidos (sin LLM call)
   * Para comandos exactos y patrones simples
   */
  _fastPlan(message, context) {
    const msg = message.trim().toLowerCase();

    // Comandos exactos
    const exactCommands = {
      '!help': { intent: 'help', strategy: REASONING_STRATEGIES.DIRECT, tools: [] },
      'ayuda': { intent: 'help', strategy: REASONING_STRATEGIES.DIRECT, tools: [] },
      'hola': { intent: 'conversation', strategy: REASONING_STRATEGIES.DIRECT, tools: [] },
      'buenas': { intent: 'conversation', strategy: REASONING_STRATEGIES.DIRECT, tools: [] },
    };

    if (exactCommands[msg]) {
      const cmd = exactCommands[msg];
      return this._buildPlan({
        objective: `Responder al comando: ${message}`,
        intent: cmd.intent,
        reasoningStrategy: cmd.strategy,
        requiredTools: cmd.tools,
        estimatedComplexity: 'low',
      });
    }

    // Patrones de imagen
    if (/^!imagen\s+|^genera\s+una?\s+imagen\s+/i.test(message)) {
      return this._buildPlan({
        objective: 'Generar imagen con IA',
        intent: 'image_generate',
        reasoningStrategy: REASONING_STRATEGIES.CREATIVE,
        requiredTools: ['image_generator', 'prompt_enhancer'],
        estimatedComplexity: 'medium',
      });
    }

    // Patrones de búsqueda web
    if (/^!buscar\s+|busca\s+en\s+internet\s+/i.test(message)) {
      return this._buildPlan({
        objective: 'Buscar información en internet',
        intent: 'web_search',
        reasoningStrategy: REASONING_STRATEGIES.RESEARCH,
        requiredTools: ['web_search'],
        estimatedComplexity: 'medium',
      });
    }

    return null; // No hay fast-plan → usar LLM
  }

  /**
   * Plan de fallback cuando el LLM no está disponible
   */
  _fallbackPlan(message, context) {
    // Lógica básica de clasificación
    let intent = 'conversation';
    let tools = [];
    let strategy = REASONING_STRATEGIES.DIRECT;

    if (/p[aá]gina\s*\d+|qu[eé]\s+dice\s+el\s+documento/i.test(message)) {
      intent = 'doc_query';
      tools = ['rag'];
      strategy = REASONING_STRATEGIES.RAG;
    } else if (/busca|investiga|noticias/i.test(message)) {
      intent = 'web_search';
      tools = ['web_search'];
      strategy = REASONING_STRATEGIES.RESEARCH;
    } else if (/genera\s+(?:una?\s+)?imagen|crea\s+(?:una?\s+)?foto/i.test(message)) {
      intent = 'image_generate';
      tools = ['image_generator'];
      strategy = REASONING_STRATEGIES.CREATIVE;
    } else if (message.length > 100) {
      strategy = REASONING_STRATEGIES.CHAIN_OF_THOUGHT;
    }

    // Siempre verificar si hay documentos activos (aunque el regex no matchee)
    if (this._hasActiveDocument(context)) {
      intent = 'doc_query';
      tools.push('rag');
      strategy = REASONING_STRATEGIES.RAG;
    }

    return this._buildPlan({
      objective: message.substring(0, 100),
      intent,
      reasoningStrategy: strategy,
      requiredTools: tools,
      estimatedComplexity: message.length > 200 ? 'high' : 'medium',
    });
  }

  /**
   * Parsea el JSON del plan generado por el LLM
   */
  _parsePlan(raw, originalMessage) {
    try {
      let jsonStr = raw;

      // 1. Extraer JSON de bloque markdown
      const mdMatch = jsonStr.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
      if (mdMatch) jsonStr = mdMatch[1];

      // 2. Extraer desde el primer { hasta el último } o final
      const startIdx = jsonStr.indexOf('{');
      if (startIdx === -1) throw new Error('No JSON found in response');
      jsonStr = jsonStr.substring(startIdx);

      const lastBrace = jsonStr.lastIndexOf('}');
      if (lastBrace > 0) {
        jsonStr = jsonStr.substring(0, lastBrace + 1);
      }

      // 3. Intentar parse directo primero (caso más común ahora)
      jsonStr = jsonStr.trim();
      try {
        const parsed = JSON.parse(jsonStr);
        const required = ['objective', 'intent', 'reasoningStrategy'];
        for (const field of required) {
          if (!parsed[field]) throw new Error(`Missing field: ${field}`);
        }
        return this._buildPlan(parsed);
      } catch (_) {
        // Si falla, intentar reparación
      }

      // 4. Reparar JSON truncado: cerrar strings y estructuras abiertas
      jsonStr = this._closeJson(jsonStr);

      // 5. Limpiar: trailing commas, keys sin comillas
      jsonStr = jsonStr
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":');

      const parsed = JSON.parse(jsonStr);

      // Validar campos requeridos
      const required = ['objective', 'intent', 'reasoningStrategy'];
      for (const field of required) {
        if (!parsed[field]) throw new Error(`Missing field: ${field}`);
      }

      return this._buildPlan(parsed);
    } catch (err) {
      console.warn('[Planner] Parse error, usando fallback:', err.message);
      console.warn('[Planner] Raw response was:', raw?.substring(0, 300));
      return this._fallbackPlan(originalMessage, {});
    }
  }

  /**
   * Construye un PlannerOutput normalizado
   */
  _buildPlan(data) {
    return {
      objective: data.objective || 'Procesar mensaje del usuario',
      intent: data.intent || 'conversation',
      reasoningStrategy: data.reasoningStrategy || REASONING_STRATEGIES.DIRECT,
      requiredTools: data.requiredTools || [],
      requiredMemories: data.requiredMemories || ['working'],
      requiredDocuments: data.requiredDocuments || [],
      executionSteps: data.executionSteps || [],
      validationRules: data.validationRules || [],
      confidenceScore: data.confidenceScore || 0.7,
      estimatedComplexity: data.estimatedComplexity || 'medium',
      needsUserClarification: data.needsUserClarification || false,
      clarificationQuestion: data.clarificationQuestion || null,
      plannedAt: Date.now(),
    };
  }

  /**
   * Resume el contexto de sesión para el LLM planner
   */
  _hasActiveDocument(context) {
    if (context.session?.activeDocuments?.length > 0) return true;
    return false;
  }

  _buildContextSummary(context) {
    const parts = [];

    if (this._hasActiveDocument(context)) {
      parts.push(`- Documento activo: "${context.activeDocTitle || 'Documento'}" en la sesión del usuario`);
    }
    if (context.recentTopics && context.recentTopics.length > 0) {
      parts.push(`- Temas recientes: ${context.recentTopics.slice(-3).join(', ')}`);
    }
    if (context.userName) {
      parts.push(`- Usuario: ${context.userName}`);
    }
    if (context.pendingImage) {
      parts.push('- Tiene imagen pendiente de analizar');
    }

    return parts.length > 0 ? parts.join('\n') : 'Sin contexto previo significativo.';
  }

  /**
   * Intenta cerrar un JSON truncado agregando coma, comillas y llaves faltantes.
   */
  _closeJson(str) {
    str = str.trim().replace(/,\s*$/, '');

    // Cerrar string abierto (solo si número impar de comillas)
    const quoteCount = str.split('"').length - 1;
    if (quoteCount % 2 !== 0) {
      str += '"';
    }

    // Recorrer carácter por carácter para contar aperturas/cierres en orden LIFO
    const stack = [];
    let inString = false;
    let escaped = false;
    for (const ch of str) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') stack.push('}');
      if (ch === '[') stack.push(']');
      if (ch === '}' || ch === ']') {
        if (stack.length > 0 && stack[stack.length - 1] === ch) stack.pop();
      }
    }

    // Cerrar en orden inverso (LIFO)
    while (stack.length > 0) {
      str += stack.pop();
      /* Si después de cerrar una estructura sigue abierta otra del mismo tipo,
         no es necesario hacer nada extra — el stack ya maneja el orden */
    }

    // Si hay un valor sin key después de la última coma (ej: después de ":", agregar null)
    if (/:\s*$/.test(str.replace(/"([^"]*)"/g, ''))) {
      const lastComma = str.lastIndexOf(',');
      const lastBrace = str.lastIndexOf('{');
      const insertionPoint = lastComma > lastBrace ? str.length : str.length;
      str = str.substring(0, insertionPoint) + 'null' + str.substring(insertionPoint);
    }

    return str;
  }
}

module.exports = new PlannerEngine();
