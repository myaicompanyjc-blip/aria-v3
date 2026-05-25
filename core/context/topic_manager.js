/**
 * TopicManager v5.0 — aislamiento de temas con detección SEMÁNTICA.
 *
 * Mejoras sobre v4.0:
 *   1. Similarity-based topic detection: usa embeddings para detectar cambios
 *   2. Configurable threshold: si similarity < threshold, se trata como cambio
 *   3. Hard rules como fallback: transiciones conocidas siguen aplicando
 *   4. Caché de embeddings de tópicos: evita re-embedding constante
 */

const TOPICS = {
  DOCUMENT: 'document',
  WEB: 'web',
  MEMORY: 'memory',
  CREATIVE: 'creative',
  CONVERSATION: 'conversation',
};

const DOCUMENT_PIPELINES = new Set([
  'doc_summary',
  'doc_exact_query',
  'doc_compare',
  'doc_extract',
  'doc_multi_hop',
]);

const HARD_TOPIC_BOUNDARIES = new Set([
  `${TOPICS.DOCUMENT}->${TOPICS.WEB}`,
  `${TOPICS.DOCUMENT}->${TOPICS.CONVERSATION}`,
  `${TOPICS.WEB}->${TOPICS.DOCUMENT}`,
  `${TOPICS.DOCUMENT}->${TOPICS.CREATIVE}`,
  `${TOPICS.CREATIVE}->${TOPICS.DOCUMENT}`,
]);

// Descriptores semánticos de cada tópico para comparación por embeddings
const TOPIC_DESCRIPTORS = {
  [TOPICS.DOCUMENT]: 'documentos PDF informes contratos especificaciones técnicas páginas contenido archivo documento',
  [TOPICS.WEB]: 'internet web online búsqueda noticias información actual precio dólar clima',
  [TOPICS.MEMORY]: 'recuerdo memoria conversación anterior hechos datos personales perfil usuario',
  [TOPICS.CREATIVE]: 'imagen diseño creativo generar crear arte logo banner visual',
  [TOPICS.CONVERSATION]: 'conversación charla saludo pregunta casual presentación ayuda capacidad',
};

const SIMILARITY_THRESHOLD = parseFloat(process.env.TOPIC_SIMILARITY_THRESHOLD || '0.35');

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

class TopicManager {
  constructor() {
    this._topicEmbeddings = {};
    this._embeddingService = null;
  }

  async _ensureEmbeddings() {
    if (Object.keys(this._topicEmbeddings).length > 0) return;
    try {
      const EmbeddingProvider = require('../../services/rag/embedding_provider');
      const provider = new EmbeddingProvider();
      const descriptors = Object.values(TOPICS).map(t => TOPIC_DESCRIPTORS[t] || t);
      const embeddings = await provider.embed(descriptors);
      Object.keys(TOPICS).forEach((key, i) => {
        this._topicEmbeddings[TOPICS[key]] = embeddings[i];
      });
    } catch (err) {
      console.warn('[TopicManager] Embedding falló, usando solo reglas:', err.message);
    }
  }

  async _computeTopicSimilarity(message, topic) {
    if (!message || !topic) return 0;
    if (!this._topicEmbeddings[topic]) return 0;
    try {
      const EmbeddingProvider = require('../../services/rag/embedding_provider');
      const provider = new EmbeddingProvider();
      const [msgEmb] = await provider.embed([message.substring(0, 500)]);
      return cosineSimilarity(msgEmb, this._topicEmbeddings[topic]);
    } catch {
      return 0;
    }
  }

  classify(message, plan = {}, routing = {}) {
    const intent = plan.intent || 'conversation';
    const pipeline = routing.pipeline || '';

    if (intent === 'doc_query' || DOCUMENT_PIPELINES.has(pipeline)) return TOPICS.DOCUMENT;
    if (intent === 'web_search' || pipeline === 'web_search' || pipeline === 'web_research') return TOPICS.WEB;
    if (intent === 'memory_question' || pipeline === 'memory_recall') return TOPICS.MEMORY;
    if (intent === 'image_generate' || pipeline === 'creative') return TOPICS.CREATIVE;
    if (intent === 'crm_action' || pipeline === 'crm_action') return TOPICS.CONVERSATION;

    return TOPICS.CONVERSATION;
  }

  async buildPolicy(session = {}, message, plan = {}, routing = {}) {
    const previousTopic = session.activeTopic || this._topicFromIntent(session.currentIntent) || null;
    const intentTopic = this.classify(message, plan, routing);
    let activeTopic = intentTopic;

    // Detección semántica: si el intent no es concluyente, usar similitud
    if (activeTopic === TOPICS.CONVERSATION && previousTopic && previousTopic !== TOPICS.CONVERSATION) {
      await this._ensureEmbeddings();
      const sim = await this._computeTopicSimilarity(message, previousTopic);
      console.log(`[TopicManager] Similitud con "${previousTopic}": ${sim.toFixed(3)} (threshold: ${SIMILARITY_THRESHOLD})`);
      if (sim >= SIMILARITY_THRESHOLD) {
        activeTopic = previousTopic;
      }
    }

    const transition = previousTopic && previousTopic !== activeTopic
      ? `${previousTopic}->${activeTopic}`
      : null;
    const hardSwitch = transition ? HARD_TOPIC_BOUNDARIES.has(transition) : false;

    return {
      previousTopic,
      activeTopic,
      topicChanged: !!transition,
      hardSwitch,
      clearShortTerm: hardSwitch || (transition && activeTopic === TOPICS.CONVERSATION),
      allowDocumentContext: activeTopic === TOPICS.DOCUMENT,
      allowWebContext: activeTopic === TOPICS.WEB,
      memoryMode: activeTopic === TOPICS.WEB ? 'facts_only' : 'normal',
      reason: transition ? `topic_transition:${transition}` : 'same_topic',
      similarity: transition ? 0 : undefined,
    };
  }

  _topicFromIntent(intent) {
    if (intent === 'doc_query') return TOPICS.DOCUMENT;
    if (intent === 'web_search') return TOPICS.WEB;
    if (intent === 'memory_question') return TOPICS.MEMORY;
    if (intent === 'image_generate') return TOPICS.CREATIVE;
    if (intent) return TOPICS.CONVERSATION;
    return null;
  }
}

module.exports = new TopicManager();
module.exports.TOPICS = TOPICS;
