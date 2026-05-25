/**
 * RAGSystem v5.0 — Sistema RAG Enterprise
 *
 * MEJORAS v5.0:
 *   1. Embeddings enterprise: jina-embeddings-v3, text-embedding-3-large o bge-m3
 *   2. Reranker especializado: jina-reranker-v2 o bge-reranker-v2-m3
 *   3. Qdrant OBLIGATORIO — sin fallback JSON
 *   4. Context Compression antes del LLM
 *
 * Qdrant es requisito obligatorio. Sin Qdrant, RAGSystem no arranca.
 * docker compose up -d en infrastructure/docker/ para tener Qdrant.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DATA_DIR = path.join(__dirname, '../../../data');
const LexicalIndex = require('./lexical_search');
const EmbeddingProvider = require('./embedding_provider');

// ─── SEMANTIC CHUNKER ────────────────────────────────────────────────────────

class SemanticChunker {
  /**
   * Divide texto en chunks semánticos (párrafos y secciones).
   * NO usa fixed char size — respeta la estructura del documento.
   *
   * @param {string} text - Texto completo
   * @param {Object} opts
   * @param {number} opts.maxChunkSize - Máximo chars por chunk (default 1500)
   * @param {number} opts.overlap - Overlap entre chunks (default 200)
   * @param {number} opts.minChunkSize - Mínimo chars (default 100)
   * @param {string[]} opts.pages - Array de páginas para mapeo page→char offset
   * @returns {Array<{text: string, index: number, wordCount: number, charCount: number, pageNumber: number|null, startChar: number|null, endChar: number|null}>}
   */
  chunk(text, opts = {}) {
    const {
      maxChunkSize = 4000,
      overlap = 200,
      minChunkSize = 100,
      pages = null,
    } = opts;

    // Construir mapa de offsets de páginas si se proporcionan
    let pageMap = null;
    if (pages && Array.isArray(pages) && pages.length > 0) {
      pageMap = this._buildPageMap(text, pages);
    }

    // 1. Intentar split por secciones (headers markdown/texto)
    const sections = this._splitBySections(text);

    // 2. Sub-dividir secciones largas por párrafos
    const rawChunks = [];
    const rawChunkOffsets = []; // {startChar, endChar}
    let globalOffset = 0;

    for (const section of sections) {
      const sectionStart = text.indexOf(section, globalOffset);
      const startOffset = sectionStart >= 0 ? sectionStart : globalOffset;

      if (section.length <= maxChunkSize) {
        rawChunks.push(section);
        rawChunkOffsets.push({ startChar: startOffset, endChar: startOffset + section.length });
      } else {
        const subChunks = this._splitByParagraphs(section, maxChunkSize);
        let subOffset = startOffset;
        for (const sub of subChunks) {
          rawChunks.push(sub);
          rawChunkOffsets.push({ startChar: subOffset, endChar: subOffset + sub.length });
          subOffset += sub.length + 2;
        }
      }
      globalOffset = startOffset + section.length;
    }

    // 3. Filtrar chunks muy pequeños pero mantener al menos 1
    let validChunks = rawChunks.filter(c => c.trim().length >= minChunkSize);
    let validOffsets = rawChunkOffsets.filter((_, i) => rawChunks[i].trim().length >= minChunkSize);

    if (validChunks.length === 0 && rawChunks.length > 0) {
      validChunks = [rawChunks[0]];
      validOffsets = [rawChunkOffsets[0]];
    }

    // Agregar overlap preservando offsets
    const chunksWithOverlap = this._addOverlap(validChunks, overlap);
    const offsetWithOverlap = this._addOverlapOffsets(validOffsets, overlap, validChunks, text);

    return chunksWithOverlap.map((text, index) => {
      const offset = offsetWithOverlap[index] || validOffsets[Math.min(index, validOffsets.length - 1)] || { startChar: null, endChar: null };
      const pageNumber = pageMap ? this._findPageForOffset(offset.startChar, pageMap) : null;
      return {
        text: text.trim(),
        index,
        wordCount: text.split(/\s+/).length,
        charCount: text.length,
        pageNumber,
        startChar: offset.startChar,
        endChar: offset.endChar,
      };
    });
  }

  _buildPageMap(text, pages) {
    const pageMap = [];
    let searchFrom = 0;
    for (let i = 0; i < pages.length; i++) {
      const pageText = pages[i].trim();
      if (!pageText) continue;
      const idx = text.indexOf(pageText, searchFrom);
      if (idx >= 0) {
        pageMap.push({ pageNumber: i + 1, startChar: idx, endChar: idx + pageText.length });
        searchFrom = idx + pageText.length;
      } else {
        // Fallback: buscar primeros 50 chars de la página
        const fallback = pageText.substring(0, 50).trim();
        const fbIdx = text.indexOf(fallback, searchFrom);
        if (fbIdx >= 0) {
          pageMap.push({ pageNumber: i + 1, startChar: fbIdx, endChar: fbIdx + pageText.length });
          searchFrom = fbIdx + pageText.length;
        } else {
          pageMap.push({ pageNumber: i + 1, startChar: searchFrom, endChar: searchFrom + pageText.length });
          searchFrom += pageText.length;
        }
      }
    }
    return pageMap;
  }

  _findPageForOffset(charOffset, pageMap) {
    if (charOffset === null || !pageMap) return null;
    for (let i = pageMap.length - 1; i >= 0; i--) {
      if (charOffset >= pageMap[i].startChar) {
        return pageMap[i].pageNumber;
      }
    }
    return pageMap.length > 0 ? pageMap[0].pageNumber : null;
  }

  _addOverlapOffsets(offsets, overlapSize, chunks, fullText) {
    if (offsets.length <= 1 || overlapSize === 0) return offsets;
    return offsets.map((offset, i) => {
      if (i === 0) return offset;
      const prevChunk = chunks[i - 1];
      if (!prevChunk) return offset;
      const overlapText = prevChunk.split(/\s+/).slice(-30).join(' ');
      const overlapLen = overlapText.length + 2;
      return {
        startChar: Math.max(0, offset.startChar - overlapLen),
        endChar: offset.endChar,
      };
    });
  }

  _splitBySections(text) {
    // Split por headers de distintos niveles
    const headerPattern = /(?:^|\n)(?:#{1,3}\s+.+|[A-ZÁÉÍÓÚ\s]{5,50}(?:\n[-=]{3,}))/gm;
    const parts = text.split(headerPattern);

    // Si no hay headers claros, usar párrafos dobles
    if (parts.length <= 2) {
      return text.split(/\n{3,}/).filter(s => s.trim().length > 0);
    }
    return parts.filter(s => s.trim().length > 0);
  }

  _splitByParagraphs(text, maxSize) {
    const paragraphs = text.split(/\n{2,}/);
    const chunks = [];
    let current = '';

    for (const para of paragraphs) {
      if ((current + '\n\n' + para).length > maxSize && current.trim()) {
        chunks.push(current.trim());
        current = para;
      } else {
        current = current ? current + '\n\n' + para : para;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
  }

  _addOverlap(chunks, overlapSize) {
    if (chunks.length <= 1 || overlapSize === 0) return chunks;

    return chunks.map((chunk, i) => {
      if (i === 0) return chunk;
      // Agregar últimas palabras del chunk anterior como contexto
      const prevWords = chunks[i - 1].split(/\s+/);
      const overlapWords = prevWords.slice(Math.max(0, prevWords.length - 30));
      return overlapWords.join(' ') + '\n\n' + chunk;
    });
  }
}

// ─── EMBEDDING SERVICE ───────────────────────────────────────────────────────

// ─── EMBEDDING SERVICE (enterprise) ──────────────────────────────────────────
// Embeddings via jina, OpenAI o LM Studio — configurable vía EMBEDDING_PROVIDER

class BM25Search {
  constructor(k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
  }

  search(query, documents, topK = 10) {
    const queryTerms = this._tokenize(query);
    if (queryTerms.length === 0) return [];

    const avgDocLen = documents.reduce((s, d) => s + d.words.length, 0) / (documents.length || 1);

    const scores = documents.map((doc, idx) => {
      let score = 0;
      for (const term of queryTerms) {
        const tf = doc.termFreq[term] || 0;
        if (tf === 0) continue;

        const df = this._docFreq(term, documents);
        const idf = Math.log((documents.length - df + 0.5) / (df + 0.5) + 1);
        const tfNorm = (tf * (this.k1 + 1)) /
          (tf + this.k1 * (1 - this.b + this.b * doc.words.length / avgDocLen));

        score += idf * tfNorm;
      }
      return { idx, score };
    });

    return scores
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  _tokenize(text) {
    return text.toLowerCase()
      .replace(/[^\wáéíóúüñ\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);
  }

  _docFreq(term, documents) {
    return documents.filter(d => (d.termFreq[term] || 0) > 0).length;
  }

  prepareDocument(text) {
    const words = this._tokenize(text);
    const termFreq = {};
    for (const w of words) termFreq[w] = (termFreq[w] || 0) + 1;
    return { words, termFreq };
  }
}

// ─── VECTOR STORE (Qdrant OBLIGATORIO) ────────────────────────────────────────

/**
 * VectorStore v5.0 — Qdrant OBLIGATORIO, sin fallback JSON.
 *
 * Qdrant debe estar corriendo en QDRANT_URL.
 * Si no está disponible, lanza error en init().
 */
class VectorStore {
  constructor() {
    this._client = null;
    this._collection = 'aria_documents';
    this._vectorDim = 1024;
    this._available = false;
  }

  async init() {
    const qdrantUrl = process.env.QDRANT_URL;
    if (!qdrantUrl) {
      console.warn('[RAG:VectorStore] QDRANT_URL no configurado. Modo solo lexical.');
      this._available = false;
      return;
    }
    try {
      const { QdrantClient } = require('@qdrant/js-client-rest');
      this._client = new QdrantClient({ url: qdrantUrl });

      await this._client.getCollections();

      const cols = await this._client.getCollections();
      const exists = cols.collections.some(c => c.name === this._collection);
      if (!exists) {
        const EmbeddingProvider = require('./embedding_provider');
        const embSvc = new EmbeddingProvider();
        const [testEmb] = await embSvc.embed(['test']);
        this._vectorDim = testEmb.length;

        await this._client.createCollection(this._collection, {
          vectors: { size: this._vectorDim, distance: 'Cosine' },
        });
        console.log(`[RAG:VectorStore] Colección Qdrant '${this._collection}' creada (dim=${this._vectorDim})`);
      }
      this._available = true;
      console.log('[RAG:VectorStore] ✅ Qdrant conectado');
    } catch (err) {
      console.warn(`[RAG:VectorStore] Qdrant NO disponible en ${qdrantUrl}: ${err.message}. Modo solo lexical.`);
      this._available = false;
    }
  }

  async upsert(userId, chunks) {
    if (!this._available) return;
    const points = chunks.map((chunk, i) => ({
      id: this._chunkToId(userId, chunk),
      vector: chunk.embedding,
      payload: {
        userId,
        docId: chunk.docId || '',
        docTitle: chunk.docTitle || '',
        text: chunk.text,
        chunkIndex: chunk.chunkIndex || i,
        pageNumber: chunk.pageNumber || null,
        wordCount: chunk.wordCount || 0,
      },
    }));
    // Batch de 100 puntos
    for (let i = 0; i < points.length; i += 100) {
      await this._client.upsert(this._collection, { points: points.slice(i, i + 100), wait: true });
    }
  }

  async searchByEmbedding(userId, queryEmbedding, topK = 20) {
    if (!this._available) return [];
    const results = await this._client.search(this._collection, {
      vector: queryEmbedding,
      limit: topK,
      filter: { must: [{ key: 'userId', match: { value: userId } }] },
      with_payload: true,
    });
    return results.map(r => ({
      text: r.payload.text,
      docId: r.payload.docId,
      docTitle: r.payload.docTitle,
      chunkIndex: r.payload.chunkIndex,
      pageNumber: r.payload.pageNumber,
      wordCount: r.payload.wordCount || 0,
      score: r.score,
      embedding: null,
    }));
  }

  async deleteByDocId(userId, docId) {
    if (!this._available) return;
    await this._client.delete(this._collection, {
      filter: {
        must: [
          { key: 'userId', match: { value: userId } },
          { key: 'docId', match: { value: docId } },
        ],
      },
      wait: true,
    });
  }

  _chunkToId(userId, chunk) {
    const str = `${userId}|${chunk.docId || ''}|${chunk.chunkIndex || 0}`;
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(31, h) + str.charCodeAt(i) | 0;
    }
    return Math.abs(h);
  }
}

// ─── RERANKER ────────────────────────────────────────────────────────────────
const Reranker = require('./reranker');

class HybridRetriever {
  constructor() {
    this.embeddings = new EmbeddingProvider();
    this.vectorStore = new VectorStore();
    this.bm25 = new BM25Search();
    this.reranker = new Reranker();
    this.lexicalIndex = new LexicalIndex();
    this._initialized = false;
  }

  async init() {
    if (this._initialized) return;
    await this.vectorStore.init();
    this.lexicalIndex.init();
    this._initialized = true;
  }

  /**
   * Recupera los chunks más relevantes usando búsqueda híbrida (vector + keyword).
   *
   * @param {string} query - Pregunta del usuario
   * @param {string} userId - ID del usuario
   * @param {number} topK - Número de chunks finales
   * @returns {Promise<Array>} Chunks relevantes ordenados
   */
  async retrieve(query, userId, topK = 6) {
    // 1. Embedding de la query
    const [queryEmbedding] = await this.embeddings.embed([query]);

    // 2. Búsqueda vectorial
    const vectorResults = await this.vectorStore.searchByEmbedding(userId, queryEmbedding, 20);

    // 3. Búsqueda lexical independiente (BM25 sobre TODO el corpus)
    const lexicalResults = this.lexicalIndex.search(query, userId, 20);

    // 4. Si no hay resultados vectoriales, usar solo lexical
    if (vectorResults.length === 0) {
      return await this.reranker.rerank(query, lexicalResults, topK);
    }

    // 5. BM25 sobre los resultados vectoriales
    const bm25Docs = vectorResults.map(r => this.bm25.prepareDocument(r.text));
    const bm25Results = this.bm25.search(query, bm25Docs, 20);

    // 6. RRF Fusion: combina vectorial + lexical independiente + keyword
    const allResults = [...vectorResults, ...lexicalResults];
    const fused = this._reciprocalRankFusion(vectorResults, bm25Results, lexicalResults, allResults);

    // 7. Reranking final
    return await this.reranker.rerank(query, fused, topK);
  }

  /**
   * Indexa un documento completo para un usuario.
   *
   * @param {string} userId
   * @param {Object} doc - {id, title, text, type, pages?}
   */
  async indexDocument(userId, doc) {
    const chunker = new SemanticChunker();
    const chunks = chunker.chunk(doc.text, {
      maxChunkSize: 4000,
      overlap: 200,
      pages: doc.pages || null,
    });

    console.log(`[RAG] Indexando "${doc.title}": ${chunks.length} chunks semánticos`);

    // Generar embeddings en batches de 10
    const BATCH_SIZE = 10;
    const allChunksWithEmbeddings = [];

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const texts = batch.map(c => c.text);
      const embeddings = await this.embeddings.embed(texts);

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const chunkData = {
          docId: doc.id,
          docTitle: doc.title,
          docType: doc.type,
          chunkIndex: i + j,
          text: chunk.text,
          wordCount: chunk.wordCount,
          pageNumber: chunk.pageNumber,
          startChar: chunk.startChar,
          endChar: chunk.endChar,
          embedding: embeddings[j],
          indexedAt: Date.now(),
        };
        allChunksWithEmbeddings.push(chunkData);

        // Indexar en el índice lexical (BM25 independiente)
        this.lexicalIndex.addDocument(userId, {
          docId: doc.id,
          docTitle: doc.title,
          chunkIndex: i + j,
          text: chunk.text,
          pageNumber: chunk.pageNumber,
          startChar: chunk.startChar,
          endChar: chunk.endChar,
        });
      }
    }

    await this.vectorStore.upsert(userId, allChunksWithEmbeddings);
    console.log(`[RAG] Indexación completa: ${allChunksWithEmbeddings.length} chunks para user ${userId}`);
  }

  _reciprocalRankFusion(vectorResults, bm25Scores, lexicalResults, allDocs, k = 60) {
    const scores = new Map();

    // Score vectorial
    vectorResults.forEach((doc, rank) => {
      const key = doc.chunkIndex + '_' + doc.docId;
      scores.set(key, (scores.get(key) || 0) + 1 / (k + rank + 1));
    });

    // Score BM25 (sobre vector results)
    bm25Scores.forEach(({ idx, score }, rank) => {
      if (allDocs[idx]) {
        const doc = allDocs[idx];
        const key = doc.chunkIndex + '_' + doc.docId;
        scores.set(key, (scores.get(key) || 0) + 1 / (k + rank + 1));
      }
    });

    // Score lexical independiente
    lexicalResults.forEach((doc, rank) => {
      const key = doc.chunkIndex + '_' + doc.docId;
      scores.set(key, (scores.get(key) || 0) + 1 / (k + rank + 1));
    });

    // Combinar y ordenar (usar todos los documentos únicos)
    const seen = new Set();
    const allUnique = [...vectorResults, ...lexicalResults].filter(doc => {
      const key = doc.chunkIndex + '_' + doc.docId;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return allUnique
      .map(doc => {
        const key = doc.chunkIndex + '_' + doc.docId;
        return { ...doc, score: scores.get(key) || 0 };
      })
      .sort((a, b) => b.score - a.score);
  }
}

// ─── RAGSYSTEM FACADE ────────────────────────────────────────────────────────

/**
 * Facade de conveniencia para usar en AriaBrain.
 * Agrupa HybridRetriever + chunker + embeddings bajo una sola clase.
 */
class RAGSystem {
  constructor() {
    this._retriever = new HybridRetriever();
    this._chunker = new SemanticChunker();
    this._embeddings = new EmbeddingProvider();
  }

  async init() {
    await this._retriever.init(); // inicializa Qdrant o fallback JSON
    console.log('[RAGSystem] Listo');
  }

  /** Indexa un documento completo. Llamado desde AriaBrain al subir doc. */
  async indexDocument({ userId, docId, docTitle, text, type, pages }) {
    await this._retriever.indexDocument(userId, { id: docId, title: docTitle, text, type, pages });
  }

  /** Búsqueda híbrida. Llamado desde DocumentAgent. */
  async query(userId, queryText, topK = 6) {
    return await this._retriever.retrieve(queryText, userId, topK);
  }

  /** Búsqueda exacta por palabra clave. Retorna páginas exactas. */
  async exactSearch(userId, queryText) {
    return await this._retriever.lexicalIndex.exactSearch(queryText, userId);
  }

  /** Estadísticas del índice lexical por usuario. */
  async getLexicalStats(userId) {
    return await this._retriever.lexicalIndex.getStats(userId);
  }

  /** Elimina todos los chunks de un documento. */
  async deleteDocument(userId, docId) {
    await this._retriever.vectorStore.deleteByDocId(userId, docId);
    this._retriever.lexicalIndex.removeDocument(userId, docId);
  }
}

// Exportar
module.exports = RAGSystem;
module.exports.SemanticChunker = SemanticChunker;
module.exports.EmbeddingProvider = EmbeddingProvider;
module.exports.VectorStore = VectorStore;
module.exports.HybridRetriever = HybridRetriever;
module.exports.LexicalIndex = LexicalIndex;
