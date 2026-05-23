/**
 * DocumentParser — Parser enterprise unificado
 *
 * Orden de preferencia:
 *   1. DoclingParser (local, más rápido, estructuras completas)
 *   2. UnstructuredParser (cloud o local, mejor para tablas complejas)
 *   3. Fallback: legacy document_processor.js
 */

const DoclingParser = require('./docling_parser');
const UnstructuredParser = require('./unstructured_parser');
const LegacyProcessor = require('../document_processor');

class DocumentParser {
  constructor() {
    this.docling = new DoclingParser();
    this.unstructured = new UnstructuredParser();
    this.legacy = LegacyProcessor;
    this._stats = { docling: 0, unstructured: 0, legacy: 0, errors: 0 };
  }

  async parse(buffer, mimetype, fileName) {
    // 1. Intentar Docling
    if (this.docling.available) {
      try {
        const result = await this.docling.parse(buffer, fileName);
        if (result && !result.error) {
          const standard = this.docling.toStandardFormat(result);
          if (standard) {
            this._stats.docling++;
            return standard;
          }
        }
      } catch (err) {
        console.warn('[DocumentParser] Docling falló, probando Unstructured:', err.message);
      }
    }

    // 2. Intentar Unstructured
    if (this.unstructured.apiKey) {
      try {
        const result = await this.unstructured.parse(buffer, fileName);
        if (result) {
          this._stats.unstructured++;
          return result;
        }
      } catch (err) {
        console.warn('[DocumentParser] Unstructured falló, usando legacy:', err.message);
      }
    }

    // 3. Legacy fallback
    try {
      const result = await this.legacy.extract(buffer, mimetype, fileName);
      if (result) {
        this._stats.legacy++;
        return result;
      }
    } catch (err) {
      this._stats.errors++;
      throw err;
    }

    throw new Error('No se pudo parsear el documento con ningún parser disponible');
  }

  getStats() {
    return { ...this._stats };
  }
}

module.exports = DocumentParser;
