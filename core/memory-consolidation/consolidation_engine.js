/**
 * MemoryConsolidationEngine — Capa de aprendizaje persistente para ARIA v3
 *
 * PROBLEMA RESUELTO: ARIA "recordaba" pero no "aprendía".
 *
 * Este motor:
 *   1. Analiza conversaciones acumuladas y extrae patrones
 *   2. Construye perfiles cognitivos por usuario (intereses, estilo, objetivos)
 *   3. Genera memoria semántica comprimida (no texto crudo — abstracciones)
 *   4. Detecta temas recurrentes y preferencias implícitas
 *   5. Crea "insights" que ARIA puede usar en futuras conversaciones
 *
 * FRECUENCIA: Corre cada N conversaciones o en background cada hora.
 *
 * DIFERENCIA vs memoria episódica:
 *   Episódica = "el usuario mencionó X el martes"
 *   Consolidada = "el usuario es un gerente B2B enfocado en ventas con preferencia por respuestas técnicas"
 */

const llm = require('../../lib/llm_client');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const PROFILES_FILE = path.join(DATA_DIR, 'cognitive_profiles.json');
const INSIGHTS_FILE = path.join(DATA_DIR, 'user_insights.json');

const CONSOLIDATION_THRESHOLD = 10;
const PROFILE_VERSION = 2;

class MemoryConsolidationEngine {
  constructor() {
    this._profiles = {};
    this._insights = {};
    this._convCounters = new Map();
    this._consolidating = new Set();
    this._loadFromDisk();
  }

  async onConversation(userId, { userMessage, assistantResponse, intent, topics }) {
    const count = (this._convCounters.get(userId) || 0) + 1;
    this._convCounters.set(userId, count);

    if (count >= CONSOLIDATION_THRESHOLD && !this._consolidating.has(userId)) {
      this._convCounters.set(userId, 0);
      setImmediate(() => this._consolidate(userId, { userMessage, assistantResponse, intent }).catch(e =>
        console.warn('[Consolidation] Error en background:', e.message)
      ));
    }
  }

  getCognitiveProfile(userId) {
    return this._profiles[userId] || null;
  }

  getRelevantInsights(userId, query) {
    const insights = this._insights[userId] || [];
    if (insights.length === 0) return [];

    const queryLower = query.toLowerCase();
    return insights
      .filter(ins => {
        const keywords = (ins.keywords || []).map(k => k.toLowerCase());
        return keywords.some(k => queryLower.includes(k));
      })
      .slice(0, 3)
      .map(ins => ins.text);
  }

  buildProfileContext(userId) {
    const profile = this._profiles[userId];
    if (!profile) return '';

    const parts = [];

    if (profile.role) parts.push(`Rol: ${profile.role}`);
    if (profile.industry) parts.push(`Industria: ${profile.industry}`);
    if (profile.objectives?.length > 0) parts.push(`Objetivos principales: ${profile.objectives.join(', ')}`);
    if (profile.communicationStyle) parts.push(`Estilo preferido: ${profile.communicationStyle}`);
    if (profile.topTopics?.length > 0) parts.push(`Temas frecuentes: ${profile.topTopics.join(', ')}`);
    if (profile.prefersTechnical) parts.push('Prefiere respuestas técnicas y detalladas');
    if (profile.prefersConcise) parts.push('Prefiere respuestas concisas y directas');

    if (parts.length === 0) return '';

    return `[PERFIL COGNITIVO DEL USUARIO]\n${parts.map(p => `• ${p}`).join('\n')}`;
  }

  async forceConsolidate(userId, recentMessages) {
    return await this._consolidate(userId, recentMessages[recentMessages.length - 1] || {});
  }

  async _consolidate(userId, lastConversation) {
    this._consolidating.add(userId);
    try {
      console.log(`[Consolidation] Consolidando perfil para usuario ${userId}...`);

      const existingProfile = this._profiles[userId] || {};
      const existingInsights = this._insights[userId] || [];

      const CONSOLIDATION_PROMPT = `Eres un analizador de perfiles cognitivos empresariales.

Perfil existente del usuario:
${JSON.stringify(existingProfile, null, 2)}

Última conversación:
Usuario dijo: "${(lastConversation.userMessage || '').substring(0, 500)}"
Intent detectado: ${lastConversation.intent || 'conversation'}

Insights previos (${existingInsights.length}):
${existingInsights.slice(-5).map(i => `- ${i.text}`).join('\n') || 'Ninguno aún'}

Analiza y genera un perfil cognitivo actualizado. Responde SOLO con JSON válido:
{
  "role": "cargo o rol del usuario (ej: Gerente Comercial, CEO, Analista)",
  "industry": "industria (ej: B2B SaaS, Construcción, Finanzas)",
  "objectives": ["objetivo 1", "objetivo 2"],
  "communicationStyle": "formal|informal|técnico|ejecutivo",
  "topTopics": ["tema 1", "tema 2", "tema 3"],
  "prefersTechnical": true|false,
  "prefersConcise": true|false,
  "newInsight": {
    "text": "observación clave sobre el usuario en máx 100 chars",
    "keywords": ["keyword1", "keyword2"],
    "confidence": 0.0-1.0
  }
}`;

      const raw = await llm.chat([
        { role: 'user', content: CONSOLIDATION_PROMPT }
      ], { maxTokens: 600, temperature: 0.2 });

      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON en respuesta de consolidación');

      const result = JSON.parse(jsonMatch[0]);

      this._profiles[userId] = {
        ...existingProfile,
        ...result,
        lastUpdated: Date.now(),
        version: PROFILE_VERSION,
        newInsight: undefined,
      };

      if (result.newInsight && result.newInsight.confidence >= 0.6) {
        if (!this._insights[userId]) this._insights[userId] = [];
        this._insights[userId].push({
          ...result.newInsight,
          createdAt: Date.now(),
          id: Date.now().toString(36),
        });
        if (this._insights[userId].length > 50) {
          this._insights[userId] = this._insights[userId]
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 50);
        }
      }

      this._saveToDisk();
      console.log(`[Consolidation] ✅ Perfil actualizado para ${userId}: ${result.role || 'sin rol'}`);

    } catch (err) {
      console.warn('[Consolidation] Error:', err.message);
    } finally {
      this._consolidating.delete(userId);
    }
  }

  _loadFromDisk() {
    try {
      if (fs.existsSync(PROFILES_FILE)) {
        this._profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
      }
      if (fs.existsSync(INSIGHTS_FILE)) {
        this._insights = JSON.parse(fs.readFileSync(INSIGHTS_FILE, 'utf8'));
      }
    } catch {
      this._profiles = {};
      this._insights = {};
    }
  }

  _saveToDisk() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(PROFILES_FILE, JSON.stringify(this._profiles, null, 2));
      fs.writeFileSync(INSIGHTS_FILE, JSON.stringify(this._insights, null, 2));
    } catch (err) {
      console.warn('[Consolidation] Error guardando perfil:', err.message);
    }
  }
}

module.exports = new MemoryConsolidationEngine();
