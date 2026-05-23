/**
 * ImageGenerator — Genera imágenes con Google Flow (Playwright) + fallback
 * Preserva la lógica del ARIA v2 que funcionaba bien
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TEMP_DIR = path.join(__dirname, '..', 'temp');
const STORAGE_DIR = path.join(__dirname, '..', 'storage');

class ImageGenerator {
  constructor() {
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }

  async generate(prompt, userPhone = '') {
    // Intentar Google Flow primero
    try {
      const result = await this._generateWithFlow(prompt, userPhone);
      if (result?.imageBuffer) return result;
    } catch (err) {
      console.warn('[ImageGen] Google Flow falló:', err.message);
    }

    // Fallback: intentar con API de imagen local si está configurada
    try {
      const result = await this._generateWithLocalAPI(prompt);
      if (result?.imageBuffer) return result;
    } catch {}

    throw new Error('No se pudo generar la imagen con ningún proveedor disponible');
  }

  async _generateWithFlow(prompt, userPhone) {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
      });
      const page = await context.newPage();

      await page.goto('https://labs.google/fx/tools/image-fx', {
        waitUntil: 'networkidle',
        timeout: 30000
      });

      // Esperar campo de texto
      await page.waitForSelector('textarea, input[type="text"], [contenteditable="true"]', { timeout: 15000 });

      // Escribir el prompt
      const textInput = await page.$('textarea') || await page.$('input[type="text"]');
      if (!textInput) throw new Error('No se encontró el campo de texto');

      await textInput.click();
      await textInput.fill(prompt);

      // Presionar Enter o buscar botón Generate
      const generateBtn = await page.$('button[aria-label*="Generate"], button[aria-label*="generat"], button:has-text("Generate"), button:has-text("Crear")');
      if (generateBtn) {
        await generateBtn.click();
      } else {
        await textInput.press('Enter');
      }

      // Esperar imagen generada (máx 90 seg)
      await page.waitForSelector('img[src*="data:"], img[src*="blob:"], canvas', {
        timeout: 90000
      });

      await page.waitForTimeout(2000);

      // Capturar imagen
      const imgEl = await page.$('img[src*="data:"], img[src*="blob:"]');
      if (!imgEl) throw new Error('No se encontró imagen generada');

      const imgSrc = await imgEl.getAttribute('src');
      let imageBuffer;

      if (imgSrc.startsWith('data:')) {
        const base64 = imgSrc.split(',')[1];
        imageBuffer = Buffer.from(base64, 'base64');
      } else {
        // blob URL — capturar con screenshot del elemento
        const screenshotBuffer = await imgEl.screenshot();
        imageBuffer = screenshotBuffer;
      }

      const fileName = `img_${Date.now()}.jpg`;
      const filePath = path.join(STORAGE_DIR, fileName);
      fs.writeFileSync(filePath, imageBuffer);

      return { imageBuffer, filePath, fileName };

    } finally {
      await browser.close();
    }
  }

  async _generateWithLocalAPI(prompt) {
    const localUrl = process.env.IMAGE_API_URL;
    if (!localUrl) return null;

    const axios = require('axios');
    const res = await axios.post(`${localUrl}/generate`, {
      prompt,
      width: 1024,
      height: 1024,
    }, { timeout: 60000, responseType: 'arraybuffer' });

    const imageBuffer = Buffer.from(res.data);
    const fileName = `img_${Date.now()}.jpg`;
    const filePath = path.join(STORAGE_DIR, fileName);
    fs.writeFileSync(filePath, imageBuffer);

    return { imageBuffer, filePath, fileName };
  }
}

module.exports = ImageGenerator;
