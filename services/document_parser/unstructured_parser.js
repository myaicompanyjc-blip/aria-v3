/**
 * UnstructuredParser — Parsing enterprise via Unstructured.io
 *
 * Unstructured.io es el estándar de la industria para:
 *   - PDFs complejos con tablas, layouts, columnas múltiples
 *   - Documentos escaneados con OCR
 *   - Extracción de elementos: títulos, párrafos, tablas, listas, figuras
 *
 * Soporta dos modos:
 *   1. API cloud: UNSTRUCTURED_API_URL + UNSTRUCTURED_API_KEY
 *   2. Local: servidor Unstructured (pip install "unstructured[pdf]")
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { execSync } = require('child_process');

const TEMP_DIR = path.join(__dirname, '../../../temp');

class UnstructuredParser {
  constructor() {
    this.apiUrl = process.env.UNSTRUCTURED_API_URL || 'https://api.unstructured.io/general/v0/general';
    this.apiKey = process.env.UNSTRUCTURED_API_KEY;
    this.strategy = process.env.UNSTRUCTURED_STRATEGY || 'hi_res'; // auto, fast, hi_res, ocr_only
    this._stats = { totalParsed: 0, errors: 0, mode: this.apiKey ? 'cloud' : 'local' };
  }

  /**
   * Parsea un documento con Unstructured.
   * @param {Buffer} buffer
   * @param {string} fileName
   * @returns {Promise<Object>} Elementos estructurados
   */
  async parse(buffer, fileName) {
    const ext = path.extname(fileName).toLowerCase();

    if (this.apiKey) {
      return await this._parseCloud(buffer, fileName);
    }
    try {
      return await this._parseLocal(buffer, fileName, ext);
    } catch (err) {
      console.warn('[UnstructuredParser] Local falló:', err.message);
      return null;
    }
  }

  async _parseCloud(buffer, fileName) {
    try {
      if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
      const tmpFile = path.join(TEMP_DIR, `unstructured_${Date.now()}_${fileName}`);
      fs.writeFileSync(tmpFile, buffer);

      const form = new FormData();
      form.append('files', fs.createReadStream(tmpFile));
      form.append('strategy', this.strategy);
      form.append('languages', ['spa', 'eng']);
      form.append('coordinates', 'true');
      form.append('pdf_infer_table_structure', 'true');

      const res = await axios.post(this.apiUrl, form, {
        headers: {
          ...form.getHeaders(),
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json',
        },
        timeout: 60000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });

      this._stats.totalParsed++;
      const elements = res.data || [];
      return this._elementsToStandard(elements);

    } catch (err) {
      this._stats.errors++;
      console.warn('[UnstructuredParser] Cloud API falló:', err.message);
      return null;
    } finally {
      try { fs.unlinkSync(path.join(TEMP_DIR, `unstructured_${Date.now()}_${fileName}`)); } catch {}
    }
  }

  async _parseLocal(buffer, fileName, ext) {
    const tmpFile = path.join(TEMP_DIR, `unstructured_${Date.now()}_${fileName}`);
    try {
      if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
      fs.writeFileSync(tmpFile, buffer);

      const script = `
import json, sys
from unstructured.partition.auto import partition

elements = partition(filename="${tmpFile.replace(/"/g, '\\"')}", strategy="${this.strategy}", languages=["spa", "eng"])
output = []
for el in elements:
    output.append({
        "type": type(el).__name__,
        "text": el.text,
        "metadata": {
            "pageNumber": el.metadata.page_number if hasattr(el.metadata, 'page_number') else None,
            "filename": el.metadata.filename if hasattr(el.metadata, 'filename') else None,
        }
    })
print(json.dumps(output))
`;
      const result = execSync(`python3 -c "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, {
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
      });

      this._stats.totalParsed++;
      const elements = JSON.parse(result.toString());
      return this._elementsToStandard(elements);

    } catch (err) {
      this._stats.errors++;
      console.warn('[UnstructuredParser] Error local:', err.message);
      return null;
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }

  _elementsToStandard(elements) {
    if (!Array.isArray(elements)) return null;

    const pages = [];
    const tables = [];
    let currentPage = 1;
    let currentPageText = '';

    for (const el of elements) {
      const pageNum = el.metadata?.pageNumber || 1;
      const type = el.type || '';
      const text = el.text || '';

      if (pageNum !== currentPage && currentPageText) {
        pages.push(currentPageText.trim());
        currentPageText = '';
        currentPage = pageNum;
      }

      if (type.includes('Table')) {
        tables.push(text);
        currentPageText += `\n[Tabla]\n${text}\n`;
      } else if (type.includes('Title')) {
        currentPageText += `\n## ${text}\n`;
      } else if (type.includes('ListItem')) {
        currentPageText += `\n- ${text}`;
      } else {
        currentPageText += `\n${text}`;
      }
    }
    if (currentPageText) pages.push(currentPageText.trim());

    return {
      text: pages.join('\n\n---\n\n'),
      pages,
      totalPages: pages.length,
      tables,
      elements,
      type: 'unstructured',
    };
  }

  getStats() {
    return { ...this._stats };
  }
}

module.exports = UnstructuredParser;
