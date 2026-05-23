/**
 * DoclingParser — Parsing enterprise de documentos via Docling
 *
 * Docling es un parser documental de IBM que entiende:
 *   - Tablas complejas, layouts, columnas
 *   - Encabezados, pies de página, firmas
 *   - PDFs escaneados (con OCR integrado)
 *   - DOCX, PPTX, XLSX, HTML, imágenes
 *
 * Requiere: pip install docling
 * Se ejecuta como proceso Python hijo o microservicio.
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEMP_DIR = path.join(__dirname, '../../../temp');

class DoclingParser {
  constructor() {
    this.available = false;
    this._checkAvailability();
  }

  _checkAvailability() {
    try {
      execSync('python3 -c "import docling" 2>/dev/null || python -c "import docling" 2>/dev/null', { stdio: 'ignore' });
      this.available = true;
      console.log('[DoclingParser] ✅ Docling disponible');
    } catch {
      console.warn('[DoclingParser] Docling no instalado. Usando parser legacy.');
      console.warn('  Para instalar: pip install docling');
    }
  }

  /**
   * Parsea un documento con Docling.
   * @param {Buffer} buffer - Contenido del archivo
   * @param {string} fileName - Nombre del archivo
   * @returns {Promise<Object>} Documento parseado con estructura completa
   */
  async parse(buffer, fileName) {
    if (!this.available) return null;

    const tmpFile = path.join(TEMP_DIR, `docling_${Date.now()}_${fileName}`);
    try {
      if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
      fs.writeFileSync(tmpFile, buffer);

      const script = `
import json, sys
from docling.document_converter import DocumentConverter

try:
    converter = DocumentConverter()
    result = converter.convert("${tmpFile.replace(/"/g, '\\"')}")
    doc = result.document

    output = {
        "title": doc.name or "",
        "pages": [],
        "tables": [],
        "metadata": {}
    }

    # Extraer páginas
    for i, page in enumerate(doc.pages or []):
        page_text = page.text or ""
        output["pages"].append({
            "pageNumber": i + 1,
            "text": page_text,
            "hasTables": len(page.tables or []) > 0,
            "hasPictures": len(page.pictures or []) > 0,
        })

    # Extraer tablas como markdown
    for i, table in enumerate(doc.tables or []):
        md = table.export_to_markdown() if hasattr(table, 'export_to_markdown') else ""
        output["tables"].append({
            "index": i,
            "markdown": md,
            "pageNumber": (table.prov or [{}])[0].page_no if hasattr(table, 'prov') and table.prov else None,
        })

    # Metadata
    if hasattr(doc, 'metadata'):
        output["metadata"] = {k: str(v) for k, v in doc.metadata.items() if v}

    print(json.dumps(output))
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`;
      const result = execSync(`python3 -c "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, {
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return JSON.parse(result.toString());
    } catch (err) {
      console.warn('[DoclingParser] Error:', err.message);
      return null;
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }

  /**
   * Convierte el resultado de Docling al formato estándar de DocumentProcessor.
   */
  toStandardFormat(doclingResult) {
    if (!doclingResult) return null;
    if (doclingResult.error) throw new Error(`Docling error: ${doclingResult.error}`);

    const pages = (doclingResult.pages || []).map(p => p.text);
    const tables = (doclingResult.tables || []).map(t => t.markdown).filter(Boolean);

    const textParts = [];
    if (doclingResult.title) textParts.push(`[${doclingResult.title}]`);
    textParts.push(...pages);
    if (tables.length > 0) {
      textParts.push('\n[TABLAS]');
      textParts.push(...tables.map((t, i) => `\n--- Tabla ${i + 1} ---\n${t}`));
    }

    return {
      text: textParts.join('\n\n'),
      pages,
      totalPages: pages.length,
      tables,
      type: 'docling',
    };
  }
}

module.exports = DoclingParser;
