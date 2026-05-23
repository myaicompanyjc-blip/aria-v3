/**
 * OCRService — Reconocimiento óptico de caracteres con Tesseract.js
 */

const path = require('path');

class OCRService {
  async recognize(imageBuffer, lang = 'spa+eng') {
    try {
      const { createWorker } = require('tesseract.js');
      const worker = await createWorker(lang, 1, {
        logger: () => {},
        langPath: path.join(__dirname, '..', 'models'),
      });

      const { data: { text, confidence } } = await worker.recognize(imageBuffer);
      await worker.terminate();

      return { text: text.trim(), confidence };
    } catch (err) {
      console.warn('[OCR] Error:', err.message);
      return { text: '', confidence: 0 };
    }
  }
}

module.exports = OCRService;
