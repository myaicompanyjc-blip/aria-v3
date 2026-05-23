/**
 * ContextBuilder — Construye el contexto óptimo para el LLM
 * 
 * SOLUCIONA el bug de "contexto anterior no se limpia":
 * - Cada usuario tiene su propio contexto completamente aislado
 * - El documento activo se inyecta solo cuando es relevante
 * - El historial se mantiene dentro del límite del modelo
 */

const fs = require('fs');
const path = require('path');

const SYSTEM_PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'aria_system.md');
const MAX_CONTEXT_CHARS = 50000; // Qwen3-30B tiene contexto grande, usamos bastante

class ContextBuilder {
  constructor(memory) {
    this.memory = memory;
    this._systemPrompt = this._loadSystemPrompt();
    this._skills = this._loadSkills();
  }

  _loadSystemPrompt() {
    try {
      if (fs.existsSync(SYSTEM_PROMPT_PATH)) {
        return fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
      }
    } catch {}
    return `Eres ARIA, asistente inteligente de Anhermer Investment LLC.
Hablas en español colombiano. Eres profesional, cálida y directa.
Piensas antes de responder. Si no sabes algo, lo dices honestamente.
NUNCA confundas información de un usuario con la de otro.`;
  }

  _loadSkills() {
    const skillsDir = path.join(__dirname, '..', 'skills');
    const skills = {};
    try {
      if (!fs.existsSync(skillsDir)) return skills;
      for (const skillDir of fs.readdirSync(skillsDir)) {
        const skillFile = path.join(skillsDir, skillDir, 'skill.md');
        if (fs.existsSync(skillFile)) {
          skills[skillDir] = fs.readFileSync(skillFile, 'utf8');
        }
      }
    } catch {}
    return skills;
  }

  /**
   * Construye el array de mensajes para el LLM
   * @param {string} phone - Teléfono del usuario
   * @param {string} currentMessage - Mensaje actual del usuario
   * @param {Object} opts - Opciones extra (activeDoc, skill, intent)
   * @returns {Array} Array de mensajes {role, content}
   */
  build(phone, currentMessage, opts = {}) {
    let systemContent = this._systemPrompt;

    // 1. Agregar hechos del usuario
    const factsCtx = this.memory.buildFactsContext(phone);
    if (factsCtx) {
      systemContent += `\n\n${factsCtx}\nUsa esta información para personalizar tus respuestas naturalmente.`;
    }

    // 2. Agregar contexto de skill si aplica
    if (opts.skill && this._skills[opts.skill]) {
      systemContent += `\n\n---SKILL ACTIVO---\n${this._skills[opts.skill]}`;
    }

    // 3. Agregar contexto de documento activo (solo si el mensaje parece referirse a él)
    let docContext = '';
    if (opts.activeDoc) {
      const doc = opts.activeDoc;
      if (opts.docQuery) {
        // Consulta específica: inyectar fragmento exacto
        docContext = this._buildDocQueryContext(doc, opts.docQuery);
      } else {
        // Referencia general: inyectar resumen + inicio del documento
        const preview = doc.text.substring(0, 8000);
        docContext = `\n\n[DOCUMENTO ACTIVO: "${doc.title}" — ${doc.totalPages} páginas]\n${preview}`;
        if (doc.text.length > 8000) {
          docContext += '\n\n[... El documento continúa. Pregúntame por una página específica o un tema concreto para ver más detalle ...]';
        }
      }
      systemContent += docContext;
    }

    // 4. Pruning con context budget (Mejora A)
    const { pruneContext, estimateTokens } = require('../packages/shared/dist/utils/index');
    const MAX_TOTAL = 6000; // tokens totales
    const MAX_DOC = 3000;
    const MAX_MEMORY = 1500;
    const MAX_HISTORY = 1500;

    const parts = [
      { text: systemContent, priority: 10, label: 'INSTRUCCIONES' },
    ];
    if (docContext) {
      parts.push({ text: docContext, priority: 8, label: 'DOCUMENTO' });
    }
    const memoryCtx = factsCtx || '';
    if (memoryCtx) {
      parts.push({ text: memoryCtx, priority: 7, label: 'MEMORIA' });
    }

    const pruned = pruneContext(parts, MAX_TOTAL);
    systemContent = pruned;

    const messages = [{ role: 'system', content: systemContent }];

    // 5. Agregar historial reciente (aislado por usuario)
    const history = this.memory.getRecentHistory(phone, 6);
    for (const turn of history) {
      if (turn.user) messages.push({ role: 'user', content: turn.user });
      if (turn.assistant) messages.push({ role: 'assistant', content: turn.assistant });
    }

    // 6. Mensaje actual
    messages.push({ role: 'user', content: currentMessage });

    return messages;
  }

  _buildDocQueryContext(doc, query) {
    const processor = require('../services/document_processor');

    // Por número de página
    const pageMatch = query.match(/p[aá]gina\s*#?(\d+)/i);
    if (pageMatch) {
      const pageNum = parseInt(pageMatch[1]);
      const pageText = processor.getPage(doc, pageNum);
      if (pageText) {
        return `\n\n[DOCUMENTO: "${doc.title}"]\n[PÁGINA ${pageNum} — solicitada específicamente]\n${pageText}`;
      }
    }

    // Por keyword — tomar las páginas relevantes con citado exacto
    const kw = query.replace(/(?:busca|encuentra|qué dice|habla|menciona|contiene|sobre|acerca de)\s+/i, '').trim();
    if (kw.length > 2) {
      const results = processor.searchPages(doc, kw);
      if (results.length > 0) {
        const snippets = results.slice(0, 5).map(r => {
          // Calcular línea aproximada (cada ~100 chars = 1 línea)
          const approxLine = Math.floor((r.snippet.indexOf(kw) >= 0 ? Math.max(0, r.snippet.indexOf(kw)) : 0) / 100) + 1;
          return `[Página ${r.pageNumber}, línea ~${approxLine}]: ${r.snippet}`;
        }).join('\n\n');
        return `\n\n[DOCUMENTO: "${doc.title}" — Páginas con "${kw}"]\n${snippets}`;
      }
    }

    // Sin match específico: primeras páginas + última
    const firstPages = doc.pages.slice(0, 3).join('\n\n');
    return `\n\n[DOCUMENTO: "${doc.title}" — ${doc.totalPages} páginas]\n${firstPages}`;
  }

  /**
   * ¿El mensaje del usuario se refiere al documento activo?
   */
  isDocumentQuery(message) {
    const docPatterns = [
      /p[aá]gina\s*\d+/i,
      /qu[eé]\s+dice/i,
      /qu[eé]\s+(hay|tiene|contiene|menciona|habla)/i,
      /busca\s+en\s+el\s+(documento|pdf|archivo)/i,
      /en\s+el\s+(documento|pdf|archivo)/i,
      /resumen\s+del\s+(documento|pdf)/i,
      /explicame\s+el/i,
      /de\s+qu[eé]\s+trata/i,
      /contenido\s+de/i,
    ];
    return docPatterns.some(p => p.test(message));
  }
}

module.exports = ContextBuilder;
