const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const INDEX_FILE = path.join(DATA_DIR, 'lexical_index.json');

class LexicalIndex {
  constructor() {
    this._docs = [];
    this._invertedIndex = {};
    this._loaded = false;
    this._dirty = false;
    this._saveTimer = null;
    this.k1 = 1.5;
    this.b = 0.75;
  }

  init() {
    this._load();
    console.log(`[LexicalIndex] Cargado: ${this._docs.length} documentos, ${Object.keys(this._invertedIndex).length} términos`);
  }

  addDocument(userId, chunk) {
    const terms = this._tokenize(chunk.text);
    const termFreq = {};
    for (const t of terms) termFreq[t] = (termFreq[t] || 0) + 1;

    const doc = {
      id: `${userId}|${chunk.docId}|${chunk.chunkIndex}`,
      userId,
      docId: chunk.docId,
      docTitle: chunk.docTitle,
      chunkIndex: chunk.chunkIndex,
      pageNumber: chunk.pageNumber || null,
      startChar: chunk.startChar || null,
      endChar: chunk.endChar || null,
      text: chunk.text,
      wordCount: terms.length,
      termFreq,
    };

    const existingIdx = this._docs.findIndex(d => d.id === doc.id);
    if (existingIdx >= 0) {
      this._removeFromIndex(this._docs[existingIdx]);
      this._docs[existingIdx] = doc;
    } else {
      this._docs.push(doc);
    }

    for (const term of Object.keys(termFreq)) {
      if (!this._invertedIndex[term]) this._invertedIndex[term] = [];
      if (!this._invertedIndex[term].includes(doc.id)) {
        this._invertedIndex[term].push(doc.id);
      }
    }

    this._scheduleSave();
  }

  removeDocument(userId, docId) {
    const toRemove = this._docs.filter(d => d.userId === userId && d.docId === docId);
    for (const doc of toRemove) {
      this._removeFromIndex(doc);
    }
    this._docs = this._docs.filter(d => !(d.userId === userId && d.docId === docId));
    this._scheduleSave();
  }

  search(query, userId, topK = 20) {
    const queryTerms = this._tokenize(query);
    if (queryTerms.length === 0) return [];

    const userDocs = this._docs.filter(d => d.userId === userId);
    if (userDocs.length === 0) return [];

    const avgDocLen = userDocs.reduce((s, d) => s + d.wordCount, 0) / userDocs.length;

    const scores = userDocs.map((doc) => {
      let score = 0;
      for (const term of queryTerms) {
        const tf = doc.termFreq[term] || 0;
        if (tf === 0) continue;

        const df = this._docFreq(term, userDocs);
        const idf = Math.log((userDocs.length - df + 0.5) / (df + 0.5) + 1);
        const tfNorm = (tf * (this.k1 + 1)) /
          (tf + this.k1 * (1 - this.b + this.b * doc.wordCount / avgDocLen));

        score += idf * tfNorm;
      }
      return { doc, score };
    });

    return scores
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(s => ({
        text: s.doc.text,
        docId: s.doc.docId,
        docTitle: s.doc.docTitle,
        chunkIndex: s.doc.chunkIndex,
        pageNumber: s.doc.pageNumber,
        startChar: s.doc.startChar,
        endChar: s.doc.endChar,
        score: s.score,
      }));
  }

  exactSearch(query, userId) {
    const queryLower = query.toLowerCase();
    const results = [];
    const userDocs = this._docs.filter(d => d.userId === userId);

    for (const doc of userDocs) {
      const idx = doc.text.toLowerCase().indexOf(queryLower);
      if (idx >= 0) {
        results.push({
          text: doc.text,
          docId: doc.docId,
          docTitle: doc.docTitle,
          chunkIndex: doc.chunkIndex,
          pageNumber: doc.pageNumber,
          startChar: doc.startChar !== null ? doc.startChar + idx : null,
          endChar: doc.startChar !== null ? doc.startChar + idx + query.length : null,
          matchPosition: idx,
          score: 1.0,
        });
      }
    }

    return results.sort((a, b) => a.matchPosition - b.matchPosition).slice(0, 20);
  }

  getStats(userId) {
    const userDocs = this._docs.filter(d => d.userId === userId);
    return {
      totalDocs: userDocs.length,
      uniqueTerms: new Set(userDocs.flatMap(d => Object.keys(d.termFreq))).size,
      totalWords: userDocs.reduce((s, d) => s + d.wordCount, 0),
    };
  }

  _tokenize(text) {
    return text.toLowerCase()
      .replace(/[^\wáéíóúüñ\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1);
  }

  _docFreq(term, docs) {
    return docs.filter(d => (d.termFreq[term] || 0) > 0).length;
  }

  _removeFromIndex(doc) {
    for (const term of Object.keys(doc.termFreq)) {
      if (this._invertedIndex[term]) {
        this._invertedIndex[term] = this._invertedIndex[term].filter(id => id !== doc.id);
        if (this._invertedIndex[term].length === 0) {
          delete this._invertedIndex[term];
        }
      }
    }
  }

  _load() {
    if (this._loaded) return;
    try {
      if (fs.existsSync(INDEX_FILE)) {
        const data = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
        this._docs = data.docs || [];
        this._invertedIndex = data.invertedIndex || {};
      }
    } catch {
      this._docs = [];
      this._invertedIndex = {};
    }
    this._loaded = true;
  }

  _scheduleSave() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._save(); this._saveTimer = null; }, 5000);
  }

  _save() {
    if (!this._dirty) return;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(INDEX_FILE, JSON.stringify({ docs: this._docs, invertedIndex: this._invertedIndex }), 'utf8');
      this._dirty = false;
    } catch (err) {
      console.error('[LexicalIndex] Error guardando:', err.message);
    }
  }
}

module.exports = LexicalIndex;
