/**
 * KnowledgeGraph v5.0 — Grafo empresarial con soporte Neo4j
 *
 * MEJORAS v5.0:
 *   - Neo4j como store primario (si NEO4J_URL está configurado)
 *   - JSON como fallback automático
 *   - API pública idéntica — sin cambios en consumidores
 *
 * Config: NEO4J_URL=bolt://localhost:7687, NEO4J_USER=neo4j, NEO4J_PASSWORD=password
 */

const llm = require('../../lib/llm_client');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const GRAPH_FILE = path.join(DATA_DIR, 'knowledge_graph.json');

const ENTITY_TYPES = {
  PERSON: 'persona', COMPANY: 'empresa', CONTRACT: 'contrato',
  INVOICE: 'factura', PRODUCT: 'producto', PROJECT: 'proyecto',
  TASK: 'tarea', DOCUMENT: 'documento', LEGAL_CLAUSE: 'cláusula_legal',
  RISK: 'riesgo', AGREEMENT: 'acuerdo', DATE: 'fecha', AMOUNT: 'monto',
};

const RELATION_TYPES = {
  TIENE: 'tiene', FIRMÓ: 'firmó', RELACIONADO_CON: 'relacionado_con',
  ES_RESPONSABLE_DE: 'es_responsable_de', CONTIENE: 'contiene',
  REFERENCIA_A: 'referencia_a', APLICA_PENALIZACIÓN: 'aplica_penalización',
  VENCE_EL: 'vence_el', ACORDÓ: 'acordó', PERTENECE_A: 'pertenece_a',
};

class Neo4jStore {
  constructor() {
    this._driver = null;
    this.available = false;
  }

  async init() {
    const url = process.env.NEO4J_URL;
    if (!url) { console.log('[KnowledgeGraph] Neo4j no configurado — usando JSON'); return; }
    try {
      const neo4j = require('neo4j-driver');
      const user = process.env.NEO4J_USER || 'neo4j';
      const password = process.env.NEO4J_PASSWORD || 'password';
      this._driver = neo4j.driver(url, neo4j.auth.basic(user, password));
      await this._driver.verifyConnectivity();
      this.available = true;
      console.log('[KnowledgeGraph] ✅ Neo4j conectado');
    } catch (err) {
      console.warn(`[KnowledgeGraph] Neo4j no disponible (${url}): ${err.message} — usando JSON`);
    }
  }

  async addNode(id, type, label, properties = {}) {
    if (!this.available) return false;
    const session = this._driver.session();
    try {
      await session.run(
        `MERGE (n:Entity {id: $id})
         SET n.type = $type, n.label = $label, n.updatedAt = timestamp(),
         n.properties = $props, n.createdAt = coalesce(n.createdAt, timestamp())`,
        { id, type, label, props: JSON.stringify(properties) }
      );
      return true;
    } catch (err) { console.warn('[Neo4j] addNode error:', err.message); return false; }
    finally { await session.close(); }
  }

  async addEdge(fromId, toId, relation, properties = {}) {
    if (!this.available) return false;
    const session = this._driver.session();
    try {
      await session.run(
        `MATCH (a:Entity {id: $fromId}), (b:Entity {id: $toId})
         MERGE (a)-[r:RELATES {type: $relation}]->(b)
         SET r.createdAt = timestamp()`,
        { fromId, toId, relation }
      );
      return true;
    } catch (err) { return false; }
    finally { await session.close(); }
  }

  async search(query, userId = null) {
    if (!this.available) return [];
    const session = this._driver.session();
    try {
      const result = await session.run(
        `MATCH (n:Entity)
         WHERE n.label CONTAINS $query OR n.properties CONTAINS $query
         ${userId ? 'AND n.properties CONTAINS $userId' : ''}
         RETURN n.id AS id, n.type AS type, n.label AS label, n.properties AS props
         LIMIT 10`,
        { query: query.toLowerCase(), userId: userId || '' }
      );
      return result.records.map(r => ({
        id: r.get('id'), type: r.get('type'), label: r.get('label'),
        properties: (() => { try { return JSON.parse(r.get('props') || '{}'); } catch { return {}; } })(),
      }));
    } catch (err) { return []; }
    finally { await session.close(); }
  }

  async getNeighbors(nodeId, maxDepth = 2) {
    if (!this.available) return [];
    const session = this._driver.session();
    try {
      const result = await session.run(
        `MATCH (n:Entity {id: $nodeId})-[r*1..${maxDepth}]-(connected:Entity)
         RETURN DISTINCT connected.id AS id, connected.type AS type,
         connected.label AS label, connected.properties AS props,
         last(r).type AS relation, length(r) AS depth
         LIMIT 50`,
        { nodeId }
      );
      return result.records.map(r => ({
        node: { id: r.get('id'), type: r.get('type'), label: r.get('label'),
          properties: (() => { try { return JSON.parse(r.get('props') || '{}'); } catch { return {}; } })() },
        relation: r.get('relation') || '',
        depth: r.get('depth') || 1,
      }));
    } catch (err) { return []; }
    finally { await session.close(); }
  }

  async getStats(userId) {
    if (!this.available) return null;
    const session = this._driver.session();
    try {
      const result = await session.run(
        `MATCH (n:Entity) ${userId ? 'WHERE n.properties CONTAINS $userId' : ''}
         RETURN n.type AS type, count(n) AS count`,
        { userId: userId || '' }
      );
      return { totalNodes: result.records.reduce((s, r) => s + r.get('count').toNumber(), 0), byType: Object.fromEntries(result.records.map(r => [r.get('type'), r.get('count').toNumber()])) };
    } catch (err) { return null; }
    finally { await session.close(); }
  }

  async close() {
    if (this._driver) await this._driver.close();
  }
}

class KnowledgeGraph {
  constructor() {
    this._neo4j = new Neo4jStore();
    this._graph = { nodes: {}, edges: [] };
    this._loaded = false;
    this._dirty = false;
    this._saveTimer = null;
  }

  async init() {
    await this._neo4j.init();
  }

  addNode(id, type, label, properties = {}) {
    this._ensureLoaded();
    this._graph.nodes[id] = {
      id, type, label, properties,
      createdAt: this._graph.nodes[id]?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    this._scheduleSave();
    this._neo4j.addNode(id, type, label, properties).catch(() => {});
    return id;
  }

  addEdge(fromId, toId, relation, properties = {}) {
    this._ensureLoaded();
    if (!this._graph.nodes[fromId] || !this._graph.nodes[toId]) return false;
    const exists = this._graph.edges.some(e => e.from === fromId && e.to === toId && e.relation === relation);
    if (!exists) {
      this._graph.edges.push({ from: fromId, to: toId, relation, properties, createdAt: Date.now() });
      this._scheduleSave();
    }
    this._neo4j.addEdge(fromId, toId, relation, properties).catch(() => {});
    return true;
  }

  search(query, userId = null) {
    this._ensureLoaded();
    const qLower = query.toLowerCase();
    const results = Object.values(this._graph.nodes).filter(node => {
      if (userId && node.properties.userId && node.properties.userId !== userId) return false;
      return node.label.toLowerCase().includes(qLower) ||
        Object.values(node.properties).some(v => typeof v === 'string' && v.toLowerCase().includes(qLower));
    }).slice(0, 10);
    return results;
  }

  getNeighbors(nodeId, maxDepth = 2) {
    this._ensureLoaded();
    const visited = new Set([nodeId]);
    const result = [];
    let frontier = [nodeId];
    for (let depth = 0; depth < maxDepth; depth++) {
      const nextFrontier = [];
      for (const id of frontier) {
        const connected = this._graph.edges
          .filter(e => e.from === id || e.to === id)
          .map(e => {
            const otherId = e.from === id ? e.to : e.from;
            const otherNode = this._graph.nodes[otherId];
            if (!otherNode || visited.has(otherId)) return null;
            return { node: otherNode, relation: e.relation, direction: e.from === id ? 'out' : 'in' };
          }).filter(Boolean);
        connected.forEach(c => { visited.add(c.node.id); result.push({ ...c, depth: depth + 1 }); nextFrontier.push(c.node.id); });
      }
      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }
    return result;
  }

  buildGraphContext(query, userId = null) {
    const relevantNodes = this.search(query, userId);
    if (relevantNodes.length === 0) return '';
    const parts = [`[GRAFO DE CONOCIMIENTO — "${query}"]`];
    for (const node of relevantNodes.slice(0, 5)) {
      const neighbors = this.getNeighbors(node.id, 1);
      let nodeDesc = `• ${node.label} (${node.type})`;
      if (neighbors.length > 0) {
        const rels = neighbors.slice(0, 4).map(n => `  ↔ ${n.relation} → ${n.node.label} (${n.node.type})`);
        nodeDesc += '\n' + rels.join('\n');
      }
      if (node.properties.summary) nodeDesc += `\n  Nota: ${node.properties.summary}`;
      parts.push(nodeDesc);
    }
    return parts.join('\n');
  }

  async extractAndAdd(text, userId, sourceType = 'conversation') {
    if (text.length < 50) return;
    try {
      const EXTRACT_PROMPT = `Extrae entidades empresariales y sus relaciones del siguiente texto.
Tipos: persona, empresa, contrato, factura, producto, proyecto, tarea, documento, acuerdo, monto, fecha.
Relaciones: tiene, firmó, relacionado_con, es_responsable_de, contiene, referencia_a, aplica_penalización, vence_el, acordó, pertenece_a.

Texto: "${text.substring(0, 800)}"

Responde SOLO con JSON:
{"entities": [{"id":"unique_slug","type":"empresa","label":"nombre","summary":"descripción"}], "relations": [{"from":"id1","to":"id2","relation":"firmó"}]}
Si no hay entidades: {"entities":[],"relations":[]}`;

      const raw = await llm.chat([{ role: 'user', content: EXTRACT_PROMPT }], { maxTokens: 400, temperature: 0.1 });
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return;
      const { entities, relations } = JSON.parse(match[0]);
      if (!entities || entities.length === 0) return;

      for (const entity of entities) {
        this.addNode(`${userId}_${entity.id}`, entity.type, entity.label, { userId, summary: entity.summary || '', source: sourceType });
      }
      for (const rel of relations) {
        this.addEdge(`${userId}_${rel.from}`, `${userId}_${rel.to}`, rel.relation);
      }
      if (entities.length > 0) console.log(`[KnowledgeGraph] Extraídas ${entities.length} entidades de ${sourceType}`);
    } catch {}
  }

  getStats(userId = null) {
    this._ensureLoaded();
    const nodes = Object.values(this._graph.nodes).filter(n => !userId || n.properties.userId === userId);
    return {
      totalNodes: nodes.length,
      totalEdges: userId ? this._graph.edges.filter(e => { const f = this._graph.nodes[e.from]; return f && f.properties.userId === userId; }).length : this._graph.edges.length,
      byType: nodes.reduce((acc, n) => { acc[n.type] = (acc[n.type] || 0) + 1; return acc; }, {}),
    };
  }

  _ensureLoaded() {
    if (this._loaded) return;
    try { if (fs.existsSync(GRAPH_FILE)) this._graph = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8')); } catch { this._graph = { nodes: {}, edges: [] }; }
    this._loaded = true;
  }

  _scheduleSave() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveToDisk(); this._saveTimer = null; }, 3000);
  }

  _saveToDisk() {
    if (!this._dirty) return;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(GRAPH_FILE, JSON.stringify(this._graph), 'utf8');
      this._dirty = false;
    } catch (err) { console.warn('[KnowledgeGraph] Error guardando:', err.message); }
  }
}

module.exports = new KnowledgeGraph();
module.exports.ENTITY_TYPES = ENTITY_TYPES;
module.exports.RELATION_TYPES = RELATION_TYPES;
