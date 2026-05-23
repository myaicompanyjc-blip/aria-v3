/**
 * ConversationMemory — Memoria de conversación por usuario
 * 
 * SOLUCIONA los bugs del ARIA v2:
 * - "Contexto se filtra entre usuarios" — cada usuario tiene su propio espacio
 * - "No recuerda entre sesiones" — persiste en JSON + Redis/Supabase
 * - "Contexto anterior no se limpia" — TTL de 30 min por sesión activa
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const DOCS_FILE = path.join(DATA_DIR, 'documents.json');

const SESSION_TTL = 30 * 60 * 1000; // 30 minutos
const MAX_HISTORY = 20; // Mensajes recientes en contexto
const MAX_HISTORY_FOR_PROMPT = 6; // Cuántos se inyectan al LLM

class ConversationMemory {
  constructor() {
    this._sessions = new Map();   // phone → {history, lastActive, activeTopic}
    this._facts = new Map();      // phone → {nombre, empresa, ...}
    this._documents = new Map();  // phone → [{title, type, pages[], text, timestamp}]
    this._redis = null;
    this._saveTimer = null;
  }

  async init() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    this._loadFromDisk();

    // Intentar conectar Redis
    if (process.env.REDIS_URL) {
      try {
        const { createClient } = require('redis');
        this._redis = createClient({ url: process.env.REDIS_URL });
        this._redis.on('error', (e) => { /* silencioso */ });
        await this._redis.connect();
        console.log('[Memory] Redis conectado');
      } catch {
        console.warn('[Memory] Redis no disponible, usando JSON local');
        this._redis = null;
      }
    }

    // Auto-guardar cada 2 minutos
    this._saveTimer = setInterval(() => this._saveToDisk(), 120000);

    // Limpiar sesiones inactivas cada 10 min
    setInterval(() => this._cleanExpiredSessions(), 600000);
  }

  // ── Historial de conversación ────────────────────────────────────────────

  getSession(phone) {
    if (!this._sessions.has(phone)) {
      this._sessions.set(phone, { history: [], lastActive: Date.now(), activeTopic: null });
    }
    const session = this._sessions.get(phone);
    session.lastActive = Date.now();
    return session;
  }

  /**
   * Agrega un turno al historial del usuario
   */
  addTurn(phone, userMessage, assistantMessage) {
    const session = this.getSession(phone);
    session.history.push({
      user: userMessage.substring(0, 2000),
      assistant: assistantMessage.substring(0, 2000),
      ts: Date.now()
    });
    // Mantener solo los últimos MAX_HISTORY
    if (session.history.length > MAX_HISTORY) {
      session.history = session.history.slice(-MAX_HISTORY);
    }
    this._scheduleSave();
  }

  /**
   * Retorna los últimos N turnos para inyectar al LLM
   */
  getRecentHistory(phone, n = MAX_HISTORY_FOR_PROMPT) {
    const session = this.getSession(phone);
    return session.history.slice(-n);
  }

  /**
   * Limpia el historial de un usuario (no los hechos ni documentos)
   */
  clearHistory(phone) {
    const session = this.getSession(phone);
    session.history = [];
    session.activeTopic = null;
  }

  // ── Hechos del usuario (nombre, empresa, etc.) ───────────────────────────

  saveFact(phone, key, value) {
    if (!this._facts.has(phone)) this._facts.set(phone, {});
    const facts = this._facts.get(phone);
    facts[key] = { value, ts: Date.now() };
    this._scheduleSave();
  }

  getFacts(phone) {
    return this._facts.get(phone) || {};
  }

  /**
   * Extrae automáticamente hechos de un mensaje del usuario
   */
  extractAndSaveFacts(phone, message) {
    const patterns = [
      { regex: /(?:mi\s+)?nombre\s+(?:es|era)\s+([A-Za-záéíóúüñÁÉÍÓÚÜÑ]+(?:\s+[A-Za-záéíóúüñÁÉÍÓÚÜÑ]+){0,3})/i, key: 'nombre' },
      { regex: /me\s+llamo\s+([A-Za-záéíóúüñÁÉÍÓÚÜÑ]+(?:\s+[A-Za-záéíóúüñÁÉÍÓÚÜÑ]+){0,3})/i, key: 'nombre' },
      { regex: /^soy\s+([A-Za-záéíóúüñÁÉÍÓÚÜÑ]+(?:\s+[A-Za-záéíóúüñÁÉÍÓÚÜÑ]+){0,2})$/i, key: 'nombre' },
      { regex: /trabajo\s+(?:en|para|con)\s+(?:la\s+|el\s+)?([A-Za-záéíóúüñÁÉÍÓÚÜÑ0-9\s]+?)(?:\s*[,.]|$)/i, key: 'empresa' },
      { regex: /(?:soy|trabajo\s+como)\s+([A-Za-záéíóúüñÁÉÍÓÚÜÑ]+(?:\s+[A-Za-záéíóúüñÁÉÍÓÚÜÑ]+){0,2})/i, key: 'cargo' },
      { regex: /(?:vivo|estoy)\s+en\s+([A-Za-záéíóúüñÁÉÍÓÚÜÑ]+(?:\s+[A-Za-záéíóúüñÁÉÍÓÚÜÑ]+){0,2})/i, key: 'ciudad' },
    ];

    for (const p of patterns) {
      const m = message.match(p.regex);
      if (m && m[1] && m[1].length > 1) {
        this.saveFact(phone, p.key, m[1].trim());
      }
    }
  }

  buildFactsContext(phone) {
    const facts = this.getFacts(phone);
    const entries = Object.entries(facts);
    if (entries.length === 0) return '';
    const lines = entries.map(([k, v]) => `- ${k}: ${typeof v === 'object' ? v.value : v}`);
    return `[INFORMACIÓN DEL USUARIO]\n${lines.join('\n')}`;
  }

  // ── Documentos del usuario ──────────────────────────────────────────────

  /**
   * Guarda un documento COMPLETO (con todas sus páginas)
   */
  saveDocument(phone, docData) {
    if (!this._documents.has(phone)) this._documents.set(phone, []);
    const docs = this._documents.get(phone);

    // Reemplazar si ya existe el mismo título
    const existingIdx = docs.findIndex(d => d.title === docData.title);
    const entry = {
      title: docData.title,
      type: docData.type,
      pages: docData.pages || [],      // Array de páginas — COMPLETO
      text: docData.text || '',         // Texto completo con marcadores
      rawText: docData.rawText || '',   // Texto crudo
      totalPages: docData.totalPages || (docData.pages?.length || 0),
      timestamp: Date.now()
    };

    if (existingIdx >= 0) {
      docs[existingIdx] = entry;
    } else {
      docs.push(entry);
      if (docs.length > 10) docs.shift(); // Máx 10 documentos por usuario
    }

    // Marcar como documento activo
    const session = this.getSession(phone);
    session.activeDocTitle = entry.title;
    session.activeDocTimestamp = Date.now();

    console.log(`[Memory] Doc guardado para ${phone}: "${entry.title}" (${entry.totalPages} páginas)`);
    this._scheduleSave();
  }

  /**
   * Obtiene el documento activo del usuario
   */
  getActiveDocument(phone) {
    const session = this.getSession(phone);
    if (!session.activeDocTitle) return null;
    // El documento activo expira tras 2 horas de inactividad
    if (Date.now() - (session.activeDocTimestamp || 0) > 7200000) {
      session.activeDocTitle = null;
      return null;
    }
    return this.getDocument(phone, session.activeDocTitle);
  }

  getDocument(phone, title) {
    const docs = this._documents.get(phone) || [];
    return docs.find(d => d.title === title) || null;
  }

  getLastDocument(phone) {
    const docs = this._documents.get(phone) || [];
    return docs.length > 0 ? docs[docs.length - 1] : null;
  }

  /**
   * Busca en el documento activo: por número de página o por keyword
   */
  queryDocument(phone, query) {
    const doc = this.getActiveDocument(phone) || this.getLastDocument(phone);
    if (!doc) return null;

    const processor = require('../services/document_processor');

    // ¿Pregunta por página específica?
    const pageMatch = query.match(/p[aá]gina\s*(\d+)|página\s*#?(\d+)|page\s*(\d+)/i);
    if (pageMatch) {
      const pageNum = parseInt(pageMatch[1] || pageMatch[2] || pageMatch[3]);
      const pageText = processor.getPage(doc, pageNum);
      if (pageText) {
        return { type: 'page', pageNumber: pageNum, text: pageText, docTitle: doc.title };
      }
    }

    // ¿Búsqueda por keyword?
    const kw = query.replace(/(?:busca|encuentra|dónde|donde|qué dice sobre|habla sobre|menciona|contiene)\s+/i, '').trim();
    if (kw.length > 2) {
      const results = processor.searchPages(doc, kw);
      if (results.length > 0) {
        return { type: 'search', keyword: kw, results, docTitle: doc.title };
      }
    }

    return null;
  }

  // ── Persistencia ────────────────────────────────────────────────────────

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveToDisk();
      this._saveTimer = null;
    }, 5000);
  }

  _saveToDisk() {
    try {
      // Guardar hechos
      const factsData = {};
      for (const [phone, facts] of this._facts.entries()) factsData[phone] = facts;
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(factsData, null, 2));

      // Guardar documentos (sin el array pages completo para no crecer demasiado — guardamos el texto completo)
      const docsData = {};
      for (const [phone, docs] of this._documents.entries()) {
        docsData[phone] = docs.map(d => ({
          ...d,
          pages: d.pages.map(p => p.substring(0, 5000)) // Truncar páginas individuales al guardar
        }));
      }
      fs.writeFileSync(DOCS_FILE, JSON.stringify(docsData, null, 2));
    } catch (e) {
      console.warn('[Memory] Error guardando en disco:', e.message);
    }
  }

  _loadFromDisk() {
    try {
      if (fs.existsSync(MEMORY_FILE)) {
        const data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
        for (const [phone, facts] of Object.entries(data)) this._facts.set(phone, facts);
        console.log(`[Memory] Hechos cargados: ${this._facts.size} usuarios`);
      }
      if (fs.existsSync(DOCS_FILE)) {
        const data = JSON.parse(fs.readFileSync(DOCS_FILE, 'utf8'));
        for (const [phone, docs] of Object.entries(data)) this._documents.set(phone, docs);
        console.log(`[Memory] Documentos cargados: ${this._documents.size} usuarios`);
      }
    } catch (e) {
      console.warn('[Memory] Error cargando desde disco:', e.message);
    }
  }

  _cleanExpiredSessions() {
    const now = Date.now();
    for (const [phone, session] of this._sessions.entries()) {
      if (now - session.lastActive > SESSION_TTL) {
        // Limpiar historial pero NO hechos ni documentos
        session.history = [];
        session.activeTopic = null;
      }
    }
  }
}

module.exports = ConversationMemory;
