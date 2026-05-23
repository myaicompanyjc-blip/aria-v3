/**
 * OCRPipeline — BRECHA 11 RESUELTA
 *
 * Pipeline OCR con:
 *   Primary: PaddleOCR via microservice Python (HTTP)
 *   Fallback: Tesseract.js local
 *
 * PaddleOCR microservice (Python/FastAPI):
 *   Ver: services/ocr/paddle_server.py
 *   Puerto: 8001
 *
 * Si PADDLE_OCR_URL no está seteado → usar solo Tesseract.
 */

class OCRPipeline {
  constructor() {
    this._paddleUrl = process.env.PADDLE_OCR_URL || null;
    this._tesseract = null;
  }

  /**
   * Reconoce texto en una imagen.
   * @param {Buffer} imageBuffer
   * @param {Object} opts - { lang: 'es', outputFormat: 'text|blocks' }
   * @returns {Promise<{text: string, confidence: number, blocks: Array}>}
   */
  async recognize(imageBuffer, opts = {}) {
    const { lang = 'es', outputFormat = 'text' } = opts;

    // 1. Intentar PaddleOCR
    if (this._paddleUrl) {
      try {
        const result = await this._paddleOCR(imageBuffer, lang);
        if (result && result.text && result.text.length > 5) {
          return result;
        }
      } catch (err) {
        console.warn('[OCR] PaddleOCR no disponible, usando Tesseract:', err.message);
      }
    }

    // 2. Fallback: Tesseract.js
    return await this._tesseractOCR(imageBuffer, lang);
  }

  /**
   * PaddleOCR via microservice Python.
   * Requiere: PADDLE_OCR_URL=http://localhost:8001
   */
  async _paddleOCR(imageBuffer, lang) {
    const axios = require('axios');
    const base64 = imageBuffer.toString('base64');

    const res = await axios.post(`${this._paddleUrl}/ocr`, {
      image: base64,
      lang: lang === 'es' ? 'latin' : lang,
    }, {
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });

    const data = res.data;
    if (!data || !data.result) throw new Error('PaddleOCR: respuesta inválida');

    // data.result: [{ text, confidence, box }]
    const blocks = data.result || [];
    const text = blocks.map(b => b.text).join('\n');
    const avgConf = blocks.length > 0
      ? blocks.reduce((s, b) => s + (b.confidence || 0.9), 0) / blocks.length
      : 0.9;

    return { text, confidence: avgConf, blocks, engine: 'paddle' };
  }

  /**
   * Tesseract.js fallback.
   */
  async _tesseractOCR(imageBuffer, lang) {
    try {
      if (!this._tesseract) {
        const Tesseract = require('tesseract.js');
        this._tesseract = Tesseract;
      }

      const { data } = await this._tesseract.recognize(imageBuffer, lang, {
        logger: () => {}, // silenciar logs
      });

      return {
        text: data.text || '',
        confidence: (data.confidence || 0) / 100,
        blocks: data.blocks || [],
        engine: 'tesseract',
      };
    } catch (err) {
      console.error('[OCR] Tesseract falló:', err.message);
      return { text: '', confidence: 0, blocks: [], engine: 'none' };
    }
  }
}

module.exports = new OCRPipeline();
