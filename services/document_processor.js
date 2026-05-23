/**
 * DocumentProcessor — Lee documentos COMPLETOS y los indexa por página
 * 
 * SOLUCIÓN al bug principal del ARIA v2: "solo lee 2 páginas de 40"
 * 
 * El problema era que aria_ceo.js cortaba el texto a 25,000 chars ANTES de guardarlo.
 * Aquí guardamos el documento completo en memoria y permitimos buscar por página/keyword.
 */

class DocumentProcessor {
  /**
   * Extrae TODO el texto de un documento, organizado por página.
   * @param {Buffer} buffer - Buffer del archivo
   * @param {string} mimetype - MIME type
   * @param {string} fileName - Nombre del archivo
   * @returns {Promise<{pages: string[], text: string, type: string, title: string, totalPages: number}>}
   */
  async extract(buffer, mimetype = '', fileName = '') {
    const ext = (fileName.match(/\.(\w+)$/) || [])[1]?.toLowerCase() || '';

    try {
      if (mimetype === 'application/pdf' || ext === 'pdf') {
        return await this._extractPDF(buffer, fileName);
      }
      if (mimetype.includes('wordprocessingml') || ext === 'docx') {
        return await this._extractDOCX(buffer, fileName);
      }
      if (mimetype === 'application/msword' || ext === 'doc') {
        return await this._extractDOC(buffer, fileName);
      }
      if (mimetype.includes('spreadsheetml') || ext === 'xlsx' || ext === 'xls') {
        return await this._extractExcel(buffer, fileName);
      }
      if (mimetype.includes('presentationml') || ext === 'pptx') {
        return await this._extractPPTX(buffer, fileName);
      }
      if (mimetype === 'text/plain' || ext === 'txt' || ext === 'csv') {
        return this._extractText(buffer, fileName);
      }
      // Fallback
      const text = buffer.toString('utf-8').replace(/[^\x20-\x7EáéíóúüñÁÉÍÓÚÜÑ\s]/g, ' ').trim();
      return { pages: [text], text, type: 'unknown', title: fileName, totalPages: 1 };
    } catch (err) {
      console.error('[DocProcessor] Error extrayendo:', err.message);
      return { pages: [], text: '', type: 'error', title: fileName, totalPages: 0, error: err.message };
    }
  }

  async _extractPDF(buffer, fileName) {
    const pdfParse = require('pdf-parse');
    
    // Extraer todo el texto de una vez
    const data = await pdfParse(buffer, {
      // Sin límite de páginas — lee TODO
      max: 0
    });

    const rawText = data.text || '';
    const totalPages = data.numpages || 1;

    // Intentar detectar saltos de página reales (pdf-parse a veces los incluye como \x0C)
    let pages = rawText.split(/\x0C/).filter(p => p.trim().length > 0);

    // Si no hay saltos de página detectados (muchos PDFs no los tienen),
    // dividir equitativamente por cantidad de páginas
    if (pages.length < totalPages * 0.5) {
      const charsPerPage = Math.ceil(rawText.length / totalPages);
      pages = [];
      for (let i = 0; i < totalPages; i++) {
        const start = i * charsPerPage;
        const end = Math.min(start + charsPerPage, rawText.length);
        const pageText = rawText.substring(start, end).trim();
        if (pageText) pages.push(pageText);
      }
    }

    // Agregar marcadores de página
    const pagesWithMarkers = pages.map((pageText, i) => `[PÁGINA ${i + 1}]\n${pageText}`);
    const fullText = pagesWithMarkers.join('\n\n');

    console.log(`[DocProcessor] PDF "${fileName}": ${totalPages} páginas, ${rawText.length} chars COMPLETOS`);

    return {
      pages: pages, // Array sin marcadores — para búsqueda por página exacta
      text: fullText, // Texto completo con marcadores — para contexto general
      rawText,        // Texto sin procesar
      type: 'pdf',
      title: fileName,
      totalPages
    };
  }

  async _extractDOCX(buffer, fileName) {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value.trim();
    // Dividir por párrafos largos para simular páginas
    const pages = this._splitIntoPseudoPages(text);
    console.log(`[DocProcessor] DOCX "${fileName}": ${text.length} chars`);
    return { pages, text, rawText: text, type: 'docx', title: fileName, totalPages: pages.length };
  }

  _extractDOC(buffer, fileName) {
    const text = buffer.toString('utf-8').replace(/[^\x20-\x7EáéíóúüñÁÉÍÓÚÜÑ\s]/g, ' ').replace(/\s+/g, ' ').trim();
    return { pages: [text], text, rawText: text, type: 'doc', title: fileName, totalPages: 1 };
  }

  async _extractExcel(buffer, fileName) {
    const XLSX = require('xlsx');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const pages = [];
    const lines = [];

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const json = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      const sheetLines = [`[Hoja: ${sheetName}]`];
      for (const row of json) {
        const vals = row.map(v => String(v || '')).join(' | ').trim();
        if (vals) sheetLines.push(vals);
      }
      pages.push(sheetLines.join('\n'));
      lines.push(...sheetLines);
    }

    const text = lines.join('\n');
    console.log(`[DocProcessor] Excel "${fileName}": ${workbook.SheetNames.length} hojas, ${text.length} chars`);
    return { pages, text, rawText: text, type: 'excel', title: fileName, totalPages: pages.length, sheets: workbook.SheetNames };
  }

  async _extractPPTX(buffer, fileName) {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(buffer);
    const slideFiles = Object.keys(zip.files)
      .filter(f => /ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort((a, b) => {
        const na = parseInt(a.match(/slide(\d+)/)[1]);
        const nb = parseInt(b.match(/slide(\d+)/)[1]);
        return na - nb;
      });

    const pages = [];
    for (const slideFile of slideFiles) {
      const xml = await zip.files[slideFile].async('text');
      const texts = (xml.match(/<a:t[^>]*>([^<]+)<\/a:t>/g) || [])
        .map(t => t.replace(/<[^>]+>/g, ''))
        .filter(Boolean);
      if (texts.length) pages.push(texts.join(' '));
    }

    const text = pages.map((p, i) => `[Slide ${i + 1}]\n${p}`).join('\n\n');
    return { pages, text, rawText: text, type: 'pptx', title: fileName, totalPages: pages.length };
  }

  _extractText(buffer, fileName) {
    const text = buffer.toString('utf-8').trim();
    const pages = this._splitIntoPseudoPages(text);
    return { pages, text, rawText: text, type: 'txt', title: fileName, totalPages: pages.length };
  }

  _splitIntoPseudoPages(text, charsPerPage = 3000) {
    const pages = [];
    for (let i = 0; i < text.length; i += charsPerPage) {
      pages.push(text.substring(i, i + charsPerPage));
    }
    return pages.length > 0 ? pages : [text];
  }

  /**
   * Busca una página específica por número (1-indexed)
   */
  getPage(docData, pageNumber) {
    if (!docData || !docData.pages) return null;
    const idx = pageNumber - 1;
    if (idx < 0 || idx >= docData.pages.length) return null;
    return docData.pages[idx];
  }

  /**
   * Busca páginas que contengan una palabra clave
   */
  searchPages(docData, keyword) {
    if (!docData || !docData.pages) return [];
    const kw = keyword.toLowerCase();
    const results = [];
    docData.pages.forEach((page, i) => {
      if (page.toLowerCase().includes(kw)) {
        results.push({ pageNumber: i + 1, snippet: this._getSnippet(page, kw) });
      }
    });
    return results;
  }

  _getSnippet(text, keyword, radius = 200) {
    const idx = text.toLowerCase().indexOf(keyword.toLowerCase());
    if (idx < 0) return text.substring(0, 300);
    const start = Math.max(0, idx - radius);
    const end = Math.min(text.length, idx + keyword.length + radius);
    return (start > 0 ? '...' : '') + text.substring(start, end) + (end < text.length ? '...' : '');
  }
}

module.exports = DocumentProcessor;
module.exports.instance = new DocumentProcessor();
