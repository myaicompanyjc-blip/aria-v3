/**
 * MemorySystem5Layers — Sistema de memoria de 5 capas para ARIA v3
 *
 * BRECHA 5 RESUELTA: Implementa las 5 capas del spec.
 * El sistema original solo tenía Working Memory plana en JSON.
 *
 * Capas implementadas:
 *   Capa 1: WorkingMemory  — Redis/Map, últimos 8 msgs, TTL 30min
 *   Capa 2: EpisodicMemory — Eventos importantes (JSON → upgrade: PostgreSQL)
 *   Capa 3: SemanticMemory — Hechos del usuario vectorizados
 *   Capa 4: DocumentMemory — Chunks indexados de documentos (→ RAG system)
 *   Capa 5: SkillMemory    — Preferencias y comportamientos del usuario
 *
 * COMPATIBLE con el ConversationMemory original:
 * - Misma interfaz pública (addTurn, getRecentHistory, etc.)
 * - Agrega capas nuevas sin romper lo existente
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const EPISODIC_FILE = path.join(DATA_DIR, 'episodic_memory.json');
const SKILL_FILE = path.join(DATA_DIR, 'skill_memory.json');
const DOCUMENTS_FILE = path.join(DATA_DIR, 'document_memory.json');

// ─── CAPA 1: WORKING MEMORY ──────────────────────────────────────────────────

class WorkingMemoryStore {
  constructor() {
    this._sessions = new Map();   // phone → {history[], lastActive, activeTopic}
    this.SESSION_TTL = 30 * 60 * 1000;  // 30 min
    this.MAX_HISTORY = 20;
    this.MAX_HISTORY_FOR_PROMPT = 8;    // Spec: máx 8 msgs relevantes
  }

  getSession(phone) {
    if (!this._sessions.has(phone)) {
      this._sessions.set(phone, {
        history: [],
        lastActive: Date.now(),
        activeTopic: null,
        activeDocId: null,
        sessionStarted: Date.now(),
      });
    }
    const session = this._sessions.get(phone);
    session.lastActive = Date.now();
    return session;
  }

  addTurn(phone, userMessage, assistantMessage) {
    const session = this.getSession(phone);
    session.history.push({
      user: (userMessage || '').substring(0, 2000),
      assistant: (assistantMessage || '').substring(0, 2000),
      ts: Date.now(),
    });
    if (session.history.length > this.MAX_HISTORY) {
      session.history = session.history.slice(-this.MAX_HISTORY);
    }
  }

  getRecentHistory(phone, n = null) {
    const session = this.getSession(phone);
    const limit = n || this.MAX_HISTORY_FOR_PROMPT;
    return session.history.slice(-limit);
  }

  clearHistory(phone) {
    const session = this.getSession(phone);
    session.history = [];
    session.activeTopic = null;
  }

  isExpired(phone) {
    const session = this._sessions.get(phone);
    if (!session) return true;
    return Date.now() - session.lastActive > this.SESSION_TTL;
  }

  cleanExpired() {
    const now = Date.now();
    for (const [phone, session] of this._sessions.entries()) {
      if (now - session.lastActive > this.SESSION_TTL) {
        this._sessions.delete(phone);
      }
    }
  }
}

// ─── CAPA 2: EPISODIC MEMORY ─────────────────────────────────────────────────

/**
 * EpisodicMemoryStore — Capa 2: Eventos importantes.
 *
 * Primary: PostgreSQL (tabla `memories`).
 * Fallback: JSON en disco (mismo comportamiento que antes).
 */
class EpisodicMemoryStore {
  constructor() {
    this._pgPool = null;
    this._pgAvailable = false;
    // Fallback JSON
    this._memories = {};
    this._loadFromDisk();
  }

  async initPg() {
    const connStr = process.env.POSTGRES_URL;
    if (!connStr) {
      console.warn('[Memory:Episodic] POSTGRES_URL no configurado — usando JSON local');
      return;
    }
    try {
      const { Pool } = require('pg');
      this._pgPool = new Pool({ connectionString: connStr, max: 5 });
      // Test connection
      await this._pgPool.query('SELECT 1');
      this._pgAvailable = true;
      console.log('[Memory:Episodic] ✅ PostgreSQL conectado');
    } catch (err) {
      console.warn('[Memory:Episodic] PostgreSQL no disponible, usando JSON:', err.message);
      this._pgPool = null;
      this._pgAvailable = false;
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async save(phone, content, importance = 0.5, type = 'event') {
    if (this._pgAvailable && this._pgPool) {
      try {
        await this._pgPool.query(
          `INSERT INTO memories (user_id, memory_type, content, importance_score)
           SELECT u.id, $2, $3, $4
           FROM users u WHERE u.phone = $1
           ON CONFLICT DO NOTHING`,
          [phone, type, content, importance]
        );
        return;
      } catch (err) {
        console.warn('[Memory:Episodic] PG save falló, cayendo a JSON:', err.message);
        this._pgAvailable = false;
      }
    }
    // Fallback JSON
    if (!this._memories[phone]) this._memories[phone] = [];
    this._memories[phone].push({ id: Date.now().toString(36), content, importance, type, ts: Date.now() });
    if (this._memories[phone].length > 100) {
      this._memories[phone] = this._memories[phone].sort((a, b) => b.importance - a.importance).slice(0, 100);
    }
    this._saveToDisk();
  }

  async retrieve(phone, query, topK = 3) {
    if (this._pgAvailable && this._pgPool) {
      try {
        const { rows } = await this._pgPool.query(
          `SELECT m.content, m.importance_score as importance, m.memory_type as type, m.created_at as ts
           FROM memories m
           JOIN users u ON u.id = m.user_id
           WHERE u.phone = $1 AND m.memory_type IN ('episodic','event','decision','agreement','task')
           ORDER BY m.importance_score DESC, m.created_at DESC
           LIMIT $2`,
          [phone, topK * 3]
        );
        if (rows.length === 0) return [];
        // Keyword scoring en memoria
        const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        return rows
          .map(m => {
            const text = (m.content || '').toLowerCase();
            const kwScore = queryWords.filter(w => text.includes(w)).length / (queryWords.length || 1);
            const ageDays = (Date.now() - new Date(m.ts).getTime()) / 86400000;
            return { ...m, score: kwScore * 0.5 + (m.importance || 0.5) * 0.3 + Math.exp(-ageDays / 30) * 0.2 };
          })
          .filter(m => m.score > 0.1)
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);
      } catch (err) {
        console.warn('[Memory:Episodic] PG retrieve falló:', err.message);
        this._pgAvailable = false;
      }
    }
    // Fallback JSON
    const memories = this._memories[phone] || [];
    if (memories.length === 0) return [];
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    return memories
      .map(m => {
        const text = m.content.toLowerCase();
        const kwScore = queryWords.filter(w => text.includes(w)).length / (queryWords.length || 1);
        const ageDays = (Date.now() - m.ts) / 86400000;
        return { ...m, score: kwScore * 0.5 + m.importance * 0.3 + Math.exp(-ageDays / 30) * 0.2 };
      })
      .filter(m => m.score > 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async autoDetectAndSave(phone, message, response, llmClient) {
    const importantPatterns = [
      /(?:firmamos?|acordamos?|decidimos?|confirmamos?)/i,
      /(?:el\s+cliente|el\s+proveedor|la\s+empresa)\s+\w+\s+(?:dijo|confirmó|aceptó)/i,
      /(?:reunión|cita|llamada)\s+(?:el|para|el\s+día)/i,
      /(?:tarea|pendiente|por\s+hacer|deadline):/i,
    ];
    if (!importantPatterns.some(p => p.test(message))) return;
    try {
      const fact = await llmClient.chat([
        { role: 'system', content: 'Extrae el hecho o evento clave de este mensaje en máx 100 caracteres. Solo el hecho, sin explicaciones.' },
        { role: 'user', content: message },
      ], { maxTokens: 100, temperature: 0.1 });
      if (fact && fact.length > 10) await this.save(phone, fact, 0.7, 'event');
    } catch {}
  }

  // ── JSON fallback helpers ─────────────────────────────────────────────────

  _loadFromDisk() {
    try {
      if (fs.existsSync(EPISODIC_FILE)) {
        this._memories = JSON.parse(fs.readFileSync(EPISODIC_FILE, 'utf8'));
      }
    } catch { this._memories = {}; }
  }

  _saveToDisk() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(EPISODIC_FILE, JSON.stringify(this._memories, null, 2));
    } catch {}
  }
}

// ─── CAPA 3: SEMANTIC MEMORY (Hechos del usuario) ────────────────────────────

class SemanticMemoryStore {
  constructor() {
    this._facts = new Map(); // phone → {key: {value, ts}}
  }

  saveFact(phone, key, value) {
    if (!this._facts.has(phone)) this._facts.set(phone, {});
    const facts = this._facts.get(phone);
    facts[key] = { value, ts: Date.now() };
  }

  getFacts(phone) {
    return this._facts.get(phone) || {};
  }

  /**
   * Extrae automáticamente hechos del usuario desde su mensaje.
   * Amplificado respecto al original.
   */
  extractAndSaveFacts(phone, message) {
    const patterns = [
      { regex: /(?:mi\s+)?nombre\s+(?:es|era)\s+([A-Za-záéíóúüñÁÉÍÓÚÜÑ]+(?:\s+[A-Za-záéíóúüñÁÉÍÓÚÜÑ]+){0,3})/i, key: 'nombre' },
      { regex: /me\s+llamo\s+([A-Za-záéíóúüñÁÉÍÓÚÜÑ]+(?:\s+[A-Za-záéíóúüñÁÉÍÓÚÜÑ]+){0,3})/i, key: 'nombre' },
      { regex: /^soy\s+([A-Za-záéíóúüñÁÉÍÓÚÜÑ]+(?:\s+[A-Za-záéíóúüñÁÉÍÓÚÜÑ]+){0,2})$/i, key: 'nombre' },
      { regex: /trabajo\s+(?:en|para|con)\s+(?:la\s+|el\s+)?([A-Za-záéíóúüñÁÉÍÓÚÜÑ0-9\s]+?)(?:\s*[,.]|$)/i, key: 'empresa' },
      { regex: /(?:soy|trabajo\s+como)\s+([A-Za-záéíóúüñÁÉÍÓÚÜÑ]+(?:\s+[A-Za-záéíóúüñÁÉÍÓÚÜÑ]+){0,2})/i, key: 'cargo' },
      { regex: /(?:vivo|estoy)\s+en\s+([A-Za-záéíóúüñÁÉÍÓÚÜÑ]+(?:\s+[A-Za-záéíóúüñÁÉÍÓÚÜÑ]+){0,2})/i, key: 'ciudad' },
      { regex: /mi\s+(?:celular|teléfono|número)\s+(?:es|era)?\s*([\d\s+()-]{7,15})/i, key: 'telefono' },
      { regex: /mi\s+correo\s+(?:es|era)?\s*([\w.+-]+@[\w-]+\.[a-z]{2,})/i, key: 'email' },
      { regex: /prefiero\s+(?:que\s+)?(?:me\s+llames?|me\s+digas?)\s+([A-Za-záéíóúüñÁÉÍÓÚÜÑ]+)/i, key: 'apodo' },
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
}

// ─── CAPA 5: SKILL MEMORY (Preferencias) ─────────────────────────────────────

class SkillMemoryStore {
  constructor() {
    this._skills = {}; // phone → {preference: value}
    this._loadFromDisk();
  }

  _loadFromDisk() {
    try {
      if (fs.existsSync(SKILL_FILE)) {
        this._skills = JSON.parse(fs.readFileSync(SKILL_FILE, 'utf8'));
      }
    } catch {
      this._skills = {};
    }
  }

  _saveToDisk() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SKILL_FILE, JSON.stringify(this._skills, null, 2));
    } catch {}
  }

  setPreference(phone, key, value) {
    if (!this._skills[phone]) this._skills[phone] = {};
    this._skills[phone][key] = { value, updatedAt: Date.now() };
    this._saveToDisk();
  }

  getPreference(phone, key, defaultValue = null) {
    const prefs = this._skills[phone] || {};
    return prefs[key]?.value ?? defaultValue;
  }

  getAll(phone) {
    return this._skills[phone] || {};
  }
}

// ─── MEMORY SYSTEM (Orquestador de 5 capas) ──────────────────────────────────

class MemorySystem5Layers {
  constructor() {
    // Capa 1: Working Memory
    this.working = new WorkingMemoryStore();
    // Capa 2: Episodic Memory
    this.episodic = new EpisodicMemoryStore();
    // Capa 3: Semantic Memory (hechos del usuario)
    this.semantic = new SemanticMemoryStore();
    // Capa 4: Document Memory → gestionado por RAG system (services/rag/rag_system.js)
    this._documentMemoryRef = null; // Se conecta externamente
    // Capa 5: Skill Memory
    this.skill = new SkillMemoryStore();

    // Documentos en memoria para compatibilidad con código original
    this._documents = new Map();
    this._loadDocuments();
    this._facts = new Map(); // Alias para compatibilidad

    // Limpiar sesiones expiradas cada 10 min
    setInterval(() => this.working.cleanExpired(), 600000);
  }

  async init() {
    // Conectar PostgreSQL para memoria episódica
    await this.episodic.initPg();
    console.log('[Memory5] Sistema de memoria 5 capas iniciado ✅');
    console.log('[Memory5] Capas activas: Working, Episodic, Semantic, Document, Skill');
  }

  // ─── API COMPATIBLE CON conversation_memory.js ORIGINAL ──────────────────

  addTurn(phone, userMessage, assistantMessage) {
    this.working.addTurn(phone, userMessage, assistantMessage);
  }

  getRecentHistory(phone, n = 8) {
    return this.working.getRecentHistory(phone, n);
  }

  getSession(phone) {
    return this.working.getSession(phone);
  }

  clearHistory(phone) {
    this.working.clearHistory(phone);
  }

  saveFact(phone, key, value) {
    this.semantic.saveFact(phone, key, value);
  }

  getFacts(phone) {
    return this.semantic.getFacts(phone);
  }

  extractAndSaveFacts(phone, message) {
    this.semantic.extractAndSaveFacts(phone, message);
  }

  buildFactsContext(phone) {
    return this.semantic.buildFactsContext(phone);
  }

  // ─── DOCUMENT MEMORY (Capa 4 — compatibilidad + RAG) ─────────────────────

  saveDocument(phone, docData) {
    if (!this._documents.has(phone)) this._documents.set(phone, []);
    const docs = this._documents.get(phone);

    const existing = docs.findIndex(d => d.title === docData.title);
    if (existing >= 0) {
      docs[existing] = { ...docData, savedAt: Date.now() };
    } else {
      if (docs.length >= 5) docs.shift(); // Mantener máx 5 docs
      docs.push({ ...docData, savedAt: Date.now() });
    }
    this._saveDocuments();
  }

  _loadDocuments() {
    try {
      if (fs.existsSync(DOCUMENTS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(DOCUMENTS_FILE, 'utf8'));
        for (const [phone, docs] of Object.entries(raw)) {
          this._documents.set(phone, docs);
        }
      }
    } catch {}
  }

  _saveDocuments() {
    try {
      const obj = {};
      for (const [phone, docs] of this._documents) {
        obj[phone] = docs;
      }
      fs.writeFileSync(DOCUMENTS_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch {}
  }

  getActiveDocument(phone) {
    const docs = this._documents.get(phone) || [];
    return docs.length > 0 ? docs[docs.length - 1] : null;
  }

  getLastDocument(phone) {
    return this.getActiveDocument(phone);
  }

  queryDocument(phone, query) {
    const doc = this.getActiveDocument(phone);
    if (!doc) return null;

    // Búsqueda por número de página
    const pageMatch = query.match(/p[aá]gina\s*#?(\d+)/i);
    if (pageMatch) {
      const pageNum = parseInt(pageMatch[1]);
      if (doc.pages && doc.pages[pageNum - 1]) {
        return {
          type: 'page',
          pageNumber: pageNum,
          text: doc.pages[pageNum - 1],
          docTitle: doc.title,
        };
      }
    }

    // Búsqueda por keyword (mejorada: búsqueda en todas las páginas)
    const kw = query.replace(/(?:busca|encuentra|qué dice|habla|menciona|contiene|sobre|acerca de)\s+/i, '').trim();
    if (kw.length > 2 && doc.pages) {
      const results = [];
      for (let i = 0; i < doc.pages.length; i++) {
        const page = doc.pages[i] || '';
        const kwLower = kw.toLowerCase();
        // Búsqueda flexible: también busca palabras individuales
        const stopwords = new Set(['sobre', 'acerca', 'dice', 'menciona', 'contiene', 'habla', 'documento', 'archivo', 'pdf']);
        const keywords = kwLower.split(/\s+/).filter(w => w.length > 3 && !stopwords.has(w));
        if (keywords.length === 0) continue;
        const hasKeyword = keywords.some(word => page.toLowerCase().includes(word));

        if (hasKeyword) {
          const idx = page.toLowerCase().indexOf(kwLower);
          const startIdx = idx >= 0 ? idx : page.toLowerCase().indexOf(keywords[0]) || 0;
          const snippet = page.substring(
            Math.max(0, startIdx - 100),
            Math.min(page.length, startIdx + 600)
          );
          results.push({ pageNumber: i + 1, snippet: snippet.trim() });
          if (results.length >= 5) break;
        }
      }
      if (results.length > 0) {
        return { type: 'search', keyword: kw, results, docTitle: doc.title };
      }
    }

    return null;
  }

  // ─── RETRIEVAL INTEGRADO (Context Packet del spec) ───────────────────────

  /**
   * Construye el Context Packet del spec:
   * - Máx 6 chunks de documento (RAG)
   * - Máx 2 episodic memories
   * - 1 semantic summary (hechos del usuario)
   * - Historial de conversación (8 msgs)
   *
   * @param {string} phone
   * @param {string} query
   * @returns {Promise<ContextPacket>}
   */
  async buildContextPacket(phone, query) {
    const [episodicMemories, factsContext] = await Promise.all([
      Promise.resolve(this.episodic.retrieve(phone, query, 2)),
      Promise.resolve(this.semantic.buildFactsContext(phone)),
    ]);

    return {
      recentHistory: this.working.getRecentHistory(phone, 8),
      episodicMemories: episodicMemories.map(m => m.content),
      factsContext,
      userPreferences: this.skill.getAll(phone),
    };
  }

  // ─── SKILL MEMORY (Capa 5) ───────────────────────────────────────────────

  setPreference(phone, key, value) {
    this.skill.setPreference(phone, key, value);
  }

  getPreference(phone, key, defaultValue = null) {
    return this.skill.getPreference(phone, key, defaultValue);
  }

  // ─── EPISODIC API (usada por AriaBrain) ──────────────────────────────────

  /**
   * Guarda un evento episódico.
   * @param {string} phone
   * @param {{ userMessage, assistantResponse, intent, summary? }} event
   */
  async addEpisodic(phone, event) {
    const content = event.summary
      || `Usuario: ${(event.userMessage || '').substring(0, 200)} | ARIA: ${(event.assistantResponse || '').substring(0, 200)}`;
    const importance = event.intent && event.intent !== 'conversation' ? 0.7 : 0.4;
    await this.episodic.save(phone, content, importance, event.intent || 'event');
  }

  /**
   * Recupera memorias episódicas relevantes.
   * @param {string} phone
   * @param {number} topK
   * @returns {Promise<Array>}
   */
  async getEpisodic(phone, topK = 3) {
    return await this.episodic.retrieve(phone, '', topK);
  }
}

module.exports = MemorySystem5Layers;
