/**
 * SessionEngine — BRECHA 6 RESUELTA
 *
 * Schema completo con sessionId, userId, currentTask, currentIntent,
 * activeDocuments[], activeTools[], shortTermMemory[].
 * Context Reset automático cuando cambia la tarea.
 * Persistencia en Redis con TTL. Fallback a Map en memoria.
 *
 * Spec:
 *   - sessionId: UUID único por sesión
 *   - userId: phone del usuario
 *   - currentTask: tarea actual detectada
 *   - currentIntent: último intent del Planner
 *   - activeDocuments: IDs de documentos activos
 *   - activeTools: herramientas activas en la sesión
 *   - shortTermMemory: últimos 8 mensajes relevantes
 *   - TTL: 30 minutos de inactividad
 */

const crypto = require('crypto');

const SESSION_TTL_SECONDS = parseInt(process.env.SESSION_TTL_MINUTES || '30') * 60;
const MAX_SHORT_TERM = 8;

// Detecta si el usuario cambió de tarea (para hacer context reset)
const TASK_CHANGE_SIGNALS = [
  /^(ok|listo|gracias|perfecto|entendido)[\s.,!]*$/i,
  /^(ahora|siguiente|otro tema|cambiando de tema|nueva pregunta)/i,
  /^(olvidemos|olvida|borremos|empecemos de nuevo)/i,
];

class SessionEngine {
  constructor() {
    this._redis = null;
    this._localSessions = new Map(); // fallback si Redis no disponible
    this._redisAvailable = false;
  }

  async init() {
    if (process.env.REDIS_URL) {
      try {
        const { createClient } = require('redis');
        this._redis = createClient({ url: process.env.REDIS_URL });
        this._redis.on('error', () => { this._redisAvailable = false; });
        await this._redis.connect();
        this._redisAvailable = true;
        console.log('[Session] Redis conectado');
      } catch (err) {
        console.warn('[Session] Redis no disponible, usando Map local:', err.message);
        this._redis = null;
      }
    }
  }

  /**
   * Obtiene o crea la sesión del usuario.
   * Si la sesión expiró, crea una nueva (context reset automático).
   */
  async getOrCreate(userId) {
    const existing = await this._load(userId);
    if (existing && !this._isExpired(existing)) {
      existing.updatedAt = new Date().toISOString();
      await this._save(userId, existing);
      return existing;
    }

    // Sesión nueva o expirada → context reset
    const session = this._createSession(userId);
    await this._save(userId, session);
    return session;
  }

  /**
   * Actualiza campos específicos de la sesión.
   */
  async update(userId, updates) {
    const session = await this.getOrCreate(userId);
    const updated = {
      ...session,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    await this._save(userId, updated);
    return updated;
  }

  /**
   * Actualiza la sesión con el resultado del Planner.
   * Detecta cambio de tarea para hacer context reset.
   */
  async updateFromPlan(userId, plan, userMessage) {
    const session = await this.getOrCreate(userId);

    // Detectar cambio de tarea
    const isNewTask = this._isNewTask(session, plan, userMessage);
    if (isNewTask) {
      console.log(`[Session] Cambio de tarea detectado para ${userId} — reseteando contexto`);
      session.shortTermMemory = [];
      session.activeDocuments = session.activeDocuments; // Mantener docs, limpiar historial
      session.currentTask = plan.objective;
    }

    const updated = {
      ...session,
      currentIntent: plan.intent,
      currentTask: plan.objective || session.currentTask,
      activeTools: plan.requiredTools || [],
      updatedAt: new Date().toISOString(),
    };

    await this._save(userId, updated);
    return updated;
  }

  /**
   * Agrega un mensaje al shortTermMemory de la sesión (máx 8).
   */
  async addToShortTermMemory(userId, userMessage, assistantMessage) {
    const session = await this.getOrCreate(userId);
    session.shortTermMemory.push({
      user: (userMessage || '').substring(0, 1000),
      assistant: (assistantMessage || '').substring(0, 1000),
      ts: Date.now(),
    });
    if (session.shortTermMemory.length > MAX_SHORT_TERM) {
      session.shortTermMemory = session.shortTermMemory.slice(-MAX_SHORT_TERM);
    }
    await this._save(userId, session);
  }

  /**
   * Agrega un documento activo a la sesión.
   */
  async addActiveDocument(userId, docId) {
    const session = await this.getOrCreate(userId);
    if (!session.activeDocuments.includes(docId)) {
      session.activeDocuments.push(docId);
      if (session.activeDocuments.length > 5) session.activeDocuments.shift();
    }
    await this._save(userId, session);
  }

  /**
   * Resetea el contexto de la sesión (nueva tarea).
   */
  async reset(userId) {
    const session = await this.getOrCreate(userId);
    const reset = {
      ...session,
      currentTask: null,
      currentIntent: null,
      activeTools: [],
      shortTermMemory: [],
      updatedAt: new Date().toISOString(),
    };
    await this._save(userId, reset);
    return reset;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  _createSession(userId) {
    return {
      sessionId: crypto.randomUUID(),
      userId,
      currentTask: null,
      currentIntent: null,
      activeDocuments: [],
      activeTools: [],
      shortTermMemory: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  _isExpired(session) {
    const updatedMs = new Date(session.updatedAt).getTime();
    return Date.now() - updatedMs > SESSION_TTL_SECONDS * 1000;
  }

  _isNewTask(session, plan, userMessage) {
    if (!session.currentTask) return false;
    if (TASK_CHANGE_SIGNALS.some(r => r.test(userMessage))) return true;
    // Si el intent cambia drásticamente
    const prevIntent = session.currentIntent;
    const newIntent = plan.intent;
    const majorChange = (
      (prevIntent === 'doc_query' && newIntent === 'web_search') ||
      (prevIntent === 'web_search' && newIntent === 'doc_query') ||
      (newIntent === 'image_generate' && prevIntent !== 'image_generate')
    );
    return majorChange;
  }

  async _load(userId) {
    const key = `aria:session:${userId}`;
    if (this._redisAvailable && this._redis) {
      try {
        const raw = await this._redis.get(key);
        return raw ? JSON.parse(raw) : null;
      } catch { this._redisAvailable = false; }
    }
    return this._localSessions.get(userId) || null;
  }

  async _save(userId, session) {
    const key = `aria:session:${userId}`;
    if (this._redisAvailable && this._redis) {
      try {
        await this._redis.set(key, JSON.stringify(session), { EX: SESSION_TTL_SECONDS });
        return;
      } catch { this._redisAvailable = false; }
    }
    this._localSessions.set(userId, session);
  }
}

module.exports = new SessionEngine();
