/**
 * ExcelAgent — Operaciones sobre archivos Excel
 *
 * Permite a ARIA leer, analizar y generar archivos Excel
 * usando la librería xlsx (SheetJS).
 */

const XLSX = require('xlsx');

class ExcelAgent {
  constructor() {
    this._stats = { filesRead: 0, filesWritten: 0, totalRows: 0, errors: 0 };
  }

  /**
   * Lee un archivo Excel y extrae su contenido estructurado.
   * @param {Buffer} buffer - Contenido del archivo
   * @param {string} fileName - Nombre del archivo
   * @returns {Object} Datos estructurados
   */
  read(buffer, fileName) {
    try {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const result = {
        fileName,
        sheets: [],
        totalSheets: workbook.SheetNames.length,
        sheetNames: workbook.SheetNames,
      };

      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        const rows = jsonData.slice(0, 200); // máx 200 filas por hoja
        const headers = rows.length > 0 ? Object.keys(rows[0]) : [];

        result.sheets.push({
          name: sheetName,
          headers,
          rowCount: jsonData.length,
          rows: rows.slice(0, 50), // primeras 50 filas para contexto
          summary: this._summarizeSheet(rows, headers),
        });
        this._totalRows += jsonData.length;
      }

      this._stats.filesRead++;
      return result;
    } catch (err) {
      this._stats.errors++;
      throw new Error(`Error leyendo Excel: ${err.message}`);
    }
  }

  /**
   * Genera un archivo Excel con datos.
   * @param {Array<Object>} data - Array de filas con headers
   * @param {string} sheetName - Nombre de la hoja
   * @returns {Buffer} Buffer del archivo Excel
   */
  generate(data, sheetName = 'Datos') {
    try {
      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(data);
      XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
      this._stats.filesWritten++;
      return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    } catch (err) {
      this._stats.errors++;
      throw new Error(`Error generando Excel: ${err.message}`);
    }
  }

  /**
   * Analiza datos Excel para extraer métricas clave.
   */
  analyze(excelData) {
    const analysis = [];
    for (const sheet of excelData.sheets) {
      analysis.push({
        sheet: sheet.name,
        filas: sheet.rowCount,
        columnas: sheet.headers.length,
        headers: sheet.headers,
        summary: sheet.summary,
        totales: this._findTotals(sheet.rows, sheet.headers),
      });
    }
    return analysis;
  }

  _summarizeSheet(rows, headers) {
    if (rows.length === 0) return 'Sin datos';
    const summary = {};
    for (const header of headers) {
      const values = rows.map(r => r[header]).filter(v => v !== '' && v !== null && v !== undefined);
      if (values.length === 0) continue;
      const numericValues = values.filter(v => !isNaN(parseFloat(v))).map(Number);
      if (numericValues.length > 0) {
        summary[header] = {
          type: 'numeric',
          min: Math.min(...numericValues),
          max: Math.max(...numericValues),
          avg: Math.round((numericValues.reduce((s, v) => s + v, 0) / numericValues.length) * 100) / 100,
          count: numericValues.length,
        };
      } else {
        const unique = new Set(values);
        summary[header] = {
          type: 'text',
          uniqueValues: unique.size,
          topValues: [...unique].slice(0, 5),
        };
      }
    }
    return summary;
  }

  _findTotals(rows, headers) {
    const totals = {};
    for (const header of headers) {
      const values = rows.map(r => parseFloat(r[header])).filter(v => !isNaN(v));
      if (values.length > 0) {
        totals[header] = {
          suma: Math.round(values.reduce((s, v) => s + v, 0) * 100) / 100,
          promedio: Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100,
        };
      }
    }
    return totals;
  }

  getStats() {
    return { ...this._stats };
  }
}

module.exports = ExcelAgent;
