const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MARKITDOWN_BIN = path.join(__dirname, '..', '.venv', 'bin', 'markitdown');

const SUPPORTED_MIMETYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'text/html',
  'application/xml',
];

class MarkItDownProcessor {
  async extract(buffer, mimetype = '', fileName = '') {
    if (!this._isSupported(mimetype, fileName)) {
      return null;
    }

    let tmpPath = null;
    try {
      const ext = path.extname(fileName) || '.tmp';
      tmpPath = path.join(os.tmpdir(), `markitdown-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
      fs.writeFileSync(tmpPath, buffer);

      const text = await this._run(tmpPath);

      let pages = text.split(/\n(?=\[Página|\# Página|\*\*Página)/).filter(p => p.trim().length > 0);
      if (pages.length <= 1) {
        const chunks = text.split(/\n{3,}/).filter(p => p.trim().length > 0);
        if (chunks.length > 1) pages = chunks;
      }

      return {
        text: text.trim(),
        pages: pages.length > 1 ? pages : [text.trim()],
        rawText: text.trim(),
        type: (mimetype && mimetype.split('/')[1]) || ext.replace('.', '') || 'document',
        title: fileName || 'document',
        totalPages: pages.length,
        engine: 'markitdown',
      };
    } catch (err) {
      console.warn(`[MarkItDown] Falló para "${fileName}":`, err.message);
      return null;
    } finally {
      if (tmpPath && fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    }
  }

  _isSupported(mimetype, fileName) {
    if (!mimetype && !fileName) return false;
    if (SUPPORTED_MIMETYPES.includes(mimetype)) return true;
    const ext = path.extname(fileName || '').toLowerCase();
    return ['.pdf', '.docx', '.pptx', '.xlsx', '.xls', '.txt', '.csv', '.md', '.json', '.html', '.xml'].includes(ext);
  }

  _run(filePath) {
    return new Promise((resolve, reject) => {
      execFile(MARKITDOWN_BIN, [filePath], {
        timeout: 120000,
        maxBuffer: 100 * 1024 * 1024,
        env: { ...process.env, PATH: process.env.PATH },
      }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
          return;
        }
        resolve(stdout || '');
      });
    });
  }
}

module.exports = new MarkItDownProcessor();
