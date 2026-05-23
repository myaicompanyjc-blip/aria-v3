/**
 * DocumentBuilder — Genera documentos visualmente profesionales
 * 
 * SOLUCIONA los bugs del ARIA v2:
 * - "Documentos feos, fuentes superpuestas" → HTML con CSS limpio → PDF
 * - "Sin plantillas" → Sistema de plantillas por tipo de documento
 * - "Sin creatividad visual" → Layout profesional con colores, tablas, tipografía
 */

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { Document, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, AlignmentType, BorderStyle, WidthType, Header, Footer, PageNumber, NumberFormat } = require('docx');

const TEMP_DIR = path.join(__dirname, '..', 'temp');
const STORAGE_DIR = path.join(__dirname, '..', 'storage');

// Colores corporativos Anhermer
const COLORS = {
  primary: '#1A3A5C',      // Azul oscuro corporativo
  secondary: '#2E86AB',    // Azul medio
  accent: '#F18F01',       // Naranja/dorado
  light: '#F5F7FA',        // Gris muy claro
  text: '#2C3E50',         // Texto principal
  muted: '#7F8C8D',        // Texto secundario
  white: '#FFFFFF',
  border: '#D5E1E8',
};

class DocumentBuilder {
  constructor() {
    [TEMP_DIR, STORAGE_DIR].forEach(d => {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    });

    this.company = {
      name: process.env.COMPANY_NAME || 'Anhermer Investment LLC',
      nit: process.env.COMPANY_NIT || '900.123.456-7',
      phone: process.env.COMPANY_PHONE || '+57 320 978 6282',
      email: process.env.COMPANY_EMAIL || 'info@anhermer.com',
      address: process.env.COMPANY_ADDRESS || 'Bucaramanga, Santander, Colombia',
      website: process.env.COMPANY_WEBSITE || 'www.anhermer.com',
    };
  }

  /**
   * Genera un documento en el formato indicado
   * @param {string} format - 'pdf' | 'docx' | 'excel'
   * @param {Object} structure - {title, subtitle, sections, footer, ...}
   * @param {string} userPhone
   */
  async build(format, structure, userPhone = '') {
    const timestamp = Date.now();
    const safeName = (structure.title || 'documento').replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ\s]/g, '').substring(0, 40).trim();
    const fileName = `ARIA_${safeName}_${timestamp}.${format === 'excel' ? 'xlsx' : format}`;
    const filePath = path.join(STORAGE_DIR, fileName);

    switch (format) {
      case 'pdf':
        await this._buildPDF(structure, filePath);
        break;
      case 'docx':
        await this._buildDOCX(structure, filePath);
        break;
      case 'excel':
        await this._buildExcel(structure, filePath);
        break;
      default:
        throw new Error(`Formato no soportado: ${format}`);
    }

    return { filePath, fileName };
  }

  // ── PDF con PDFKit ───────────────────────────────────────────────────────

  async _buildPDF(structure, filePath) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'LETTER',
        margins: { top: 72, bottom: 72, left: 72, right: 72 },
        info: { Title: structure.title, Author: this.company.name, Creator: 'ARIA v3' }
      });

      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);
      stream.on('finish', resolve);
      stream.on('error', reject);

      const W = doc.page.width - 144; // Ancho útil

      // ── Encabezado corporativo ──
      // Banda de color
      doc.rect(0, 0, doc.page.width, 80).fill(COLORS.primary);

      // Nombre empresa
      doc.fillColor(COLORS.white).fontSize(18).font('Helvetica-Bold')
        .text(this.company.name, 72, 20, { width: W - 120 });

      // Info empresa en header
      doc.fillColor(COLORS.accent).fontSize(8).font('Helvetica')
        .text(`NIT: ${this.company.nit} | ${this.company.phone}`, 72, 44)
        .text(`${this.company.email} | ${this.company.website}`, 72, 56);

      // Fecha en esquina
      const dateStr = new Date().toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' });
      doc.fillColor(COLORS.white).fontSize(8)
        .text(dateStr, 72, 44, { width: W, align: 'right' });

      // ── Línea divisoria ──
      doc.rect(72, 90, W, 3).fill(COLORS.accent);

      // ── Título del documento ──
      doc.moveDown(1.5);
      doc.fillColor(COLORS.primary).fontSize(20).font('Helvetica-Bold')
        .text(structure.title || 'Documento', { align: 'center' });

      if (structure.subtitle) {
        doc.fillColor(COLORS.secondary).fontSize(12).font('Helvetica')
          .text(structure.subtitle, { align: 'center' });
      }

      doc.moveDown(1);
      doc.rect(72, doc.y, W, 1).fill(COLORS.border);
      doc.moveDown(0.5);

      // ── Secciones ──
      const sections = structure.sections || [];
      for (const section of sections) {
        if (doc.y > doc.page.height - 150) doc.addPage();

        // Heading de sección
        if (section.heading) {
          doc.moveDown(0.5);
          // Fondo para el heading
          const headingY = doc.y;
          doc.rect(72, headingY, W, 22).fill(COLORS.light);
          doc.rect(72, headingY, 4, 22).fill(COLORS.secondary);
          doc.fillColor(COLORS.primary).fontSize(12).font('Helvetica-Bold')
            .text(section.heading, 82, headingY + 5, { width: W - 10 });
          doc.moveDown(0.8);
        }

        // Contenido
        if (section.content) {
          doc.fillColor(COLORS.text).fontSize(10).font('Helvetica')
            .text(section.content, 72, doc.y, { width: W, lineGap: 3 });
          doc.moveDown(0.5);
        }

        // Tabla si existe
        if (section.table && section.table.headers) {
          this._drawPDFTable(doc, section.table, 72, W);
          doc.moveDown(0.5);
        }

        // Lista de items
        if (section.items && Array.isArray(section.items)) {
          for (const item of section.items) {
            doc.fillColor(COLORS.text).fontSize(10)
              .text(`• ${item}`, 82, doc.y, { width: W - 10, lineGap: 2 });
          }
          doc.moveDown(0.3);
        }
      }

      // ── Pie de página ──
      const totalPages = doc.bufferedPageRange().count;
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const footerY = doc.page.height - 50;
        doc.rect(0, footerY - 10, doc.page.width, 60).fill(COLORS.primary);
        doc.fillColor(COLORS.white).fontSize(8).font('Helvetica')
          .text(structure.footer || `Documento generado por ARIA v3 — ${this.company.name}`, 72, footerY, { width: W })
          .text(`Página ${i - range.start + 1} de ${range.count}`, 72, footerY + 12, { width: W, align: 'right' });
      }

      doc.end();
    });
  }

  _drawPDFTable(doc, table, x, W) {
    const headers = table.headers || [];
    const rows = table.rows || [];
    const colW = W / headers.length;
    let y = doc.y;

    // Encabezados
    doc.rect(x, y, W, 20).fill(COLORS.primary);
    headers.forEach((h, i) => {
      doc.fillColor(COLORS.white).fontSize(9).font('Helvetica-Bold')
        .text(h, x + i * colW + 4, y + 5, { width: colW - 8 });
    });
    y += 20;

    // Filas
    rows.forEach((row, ri) => {
      if (doc.y > doc.page.height - 80) { doc.addPage(); y = doc.y; }
      const fillColor = ri % 2 === 0 ? COLORS.white : COLORS.light;
      doc.rect(x, y, W, 18).fill(fillColor).stroke(COLORS.border);
      row.forEach((cell, ci) => {
        doc.fillColor(COLORS.text).fontSize(9).font('Helvetica')
          .text(String(cell || ''), x + ci * colW + 4, y + 4, { width: colW - 8 });
      });
      y += 18;
    });

    doc.y = y + 5;
  }

  // ── DOCX ────────────────────────────────────────────────────────────────

  async _buildDOCX(structure, filePath) {
    const sections = (structure.sections || []).map(section => {
      const children = [];

      if (section.heading) {
        children.push(new Paragraph({
          text: section.heading,
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 240, after: 120 },
          shading: { type: 'solid', fill: 'E8F0F7' },
        }));
      }

      if (section.content) {
        children.push(new Paragraph({
          children: [new TextRun({ text: section.content, size: 22 })],
          spacing: { after: 120 },
        }));
      }

      if (section.items) {
        for (const item of section.items) {
          children.push(new Paragraph({
            children: [new TextRun({ text: `• ${item}`, size: 22 })],
            indent: { left: 360 },
            spacing: { after: 60 },
          }));
        }
      }

      return children;
    }).flat();

    const doc = new Document({
      numbering: { config: [] },
      sections: [{
        properties: {},
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: this.company.name, bold: true, color: '1A3A5C', size: 28 }),
                  new TextRun({ text: `  |  NIT: ${this.company.nit}  |  ${this.company.phone}`, color: '7F8C8D', size: 18 }),
                ],
              })
            ]
          })
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: `${this.company.email} | ${this.company.website}  —  Página `, size: 16, color: '7F8C8D' }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '7F8C8D' }),
                  new TextRun({ text: ' de ', size: 16, color: '7F8C8D' }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: '7F8C8D' }),
                ],
              })
            ]
          })
        },
        children: [
          new Paragraph({
            children: [new TextRun({ text: structure.title || 'Documento', bold: true, color: '1A3A5C', size: 44 })],
            alignment: AlignmentType.CENTER,
            spacing: { before: 480, after: 240 },
          }),
          structure.subtitle ? new Paragraph({
            children: [new TextRun({ text: structure.subtitle, color: '2E86AB', size: 26 })],
            alignment: AlignmentType.CENTER,
            spacing: { after: 480 },
          }) : null,
          ...children,
        ].filter(Boolean)
      }]
    });

    const { Packer } = require('docx');
    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(filePath, buffer);
  }

  // ── Excel ────────────────────────────────────────────────────────────────

  async _buildExcel(structure, filePath) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'ARIA v3';
    wb.company = this.company.name;

    const sections = structure.sections || [{ heading: structure.title, table: structure.table }];

    for (const section of sections) {
      const sheetName = (section.heading || 'Hoja1').substring(0, 31);
      const ws = wb.addWorksheet(sheetName);

      // Encabezado corporativo
      ws.mergeCells('A1:F1');
      ws.getCell('A1').value = this.company.name;
      ws.getCell('A1').font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 14 };
      ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A3A5C' } };
      ws.getCell('A1').alignment = { horizontal: 'center' };
      ws.getRow(1).height = 28;

      ws.mergeCells('A2:F2');
      ws.getCell('A2').value = structure.title || sheetName;
      ws.getCell('A2').font = { bold: true, color: { argb: 'FF1A3A5C' }, size: 12 };
      ws.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0F7' } };
      ws.getCell('A2').alignment = { horizontal: 'center' };
      ws.getRow(2).height = 22;

      let currentRow = 4;

      // Si hay tabla, renderizarla
      if (section.table && section.table.headers) {
        const headers = section.table.headers;
        const rows = section.table.rows || [];

        // Ajustar columnas
        headers.forEach((h, i) => {
          const col = ws.getColumn(i + 1);
          col.width = Math.max(15, h.length + 5);
        });

        // Fila de encabezados
        const headerRow = ws.getRow(currentRow);
        headers.forEach((h, i) => {
          const cell = headerRow.getCell(i + 1);
          cell.value = h;
          cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E86AB' } };
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
          cell.border = { bottom: { style: 'thin', color: { argb: 'FF1A3A5C' } } };
        });
        headerRow.height = 22;
        currentRow++;

        // Filas de datos
        rows.forEach((row, ri) => {
          const dataRow = ws.getRow(currentRow);
          const isEven = ri % 2 === 0;
          row.forEach((cell, ci) => {
            const c = dataRow.getCell(ci + 1);
            c.value = cell;
            c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isEven ? 'FFFFFFFF' : 'FFF5F7FA' } };
            c.border = { bottom: { style: 'thin', color: { argb: 'FFD5E1E8' } } };
          });
          currentRow++;
        });
      } else if (section.content) {
        // Contenido de texto libre
        const lines = section.content.split('\n');
        for (const line of lines) {
          ws.mergeCells(`A${currentRow}:F${currentRow}`);
          ws.getCell(`A${currentRow}`).value = line;
          ws.getRow(currentRow).height = 18;
          currentRow++;
        }
      }
    }

    await wb.xlsx.writeFile(filePath);
  }
}

module.exports = DocumentBuilder;
