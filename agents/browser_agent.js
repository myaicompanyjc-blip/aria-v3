/**
 * BrowserAgent — Navegación web real via Playwright
 *
 * Permite a ARIA navegar páginas web, extraer contenido,
 * llenar formularios y realizar búsquedas estructuradas.
 *
 * Config: BROWSER_AGENT_ENABLED=true, PLAYWRIGHT_HEADLESS=true
 */

const axios = require('axios');

class BrowserAgent {
  constructor() {
    this.enabled = process.env.BROWSER_AGENT_ENABLED === 'true';
    this.headless = process.env.PLAYWRIGHT_HEADLESS !== 'false';
    this.timeout = parseInt(process.env.BROWSER_TIMEOUT_MS || '15000');
    this._browser = null;
    this._context = null;
    this._stats = { pagesVisited: 0, totalChars: 0, errors: 0 };
  }

  async init() {
    if (!this.enabled) {
      console.log('[BrowserAgent] Deshabilitado (BROWSER_AGENT_ENABLED != true)');
      return;
    }
    try {
      const { chromium } = require('playwright');
      this._browser = await chromium.launch({
        headless: this.headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      this._context = await this._browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 },
      });
      console.log('[BrowserAgent] ✅ Playwright iniciado');
    } catch (err) {
      console.warn('[BrowserAgent] Error al iniciar Playwright:', err.message);
      console.warn('[BrowserAgent] Instala playwright: npx playwright install chromium');
      this.enabled = false;
    }
  }

  async navigate(url) {
    if (!this.enabled || !this._browser) {
      return await this._httpFallback(url);
    }
    try {
      const page = await this._context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeout });
      const title = await page.title();
      const content = await page.evaluate(() => {
        const main = document.querySelector('main, article, .content, #content, .post');
        if (main) return main.innerText;
        return document.body.innerText.substring(0, 10000);
      });
      await page.close();
      this._stats.pagesVisited++;
      this._stats.totalChars += content.length;
      return { title, content: content.substring(0, 8000), url, source: 'playwright' };
    } catch (err) {
      console.warn(`[BrowserAgent] Playwright falló para ${url}:`, err.message);
      this._stats.errors++;
      return await this._httpFallback(url);
    }
  }

  async search(query) {
    const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    try {
      const res = await axios.get(searchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 10000,
      });
      const html = res.data;
      const results = [];
      const linkRegex = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let match;
      while ((match = linkRegex.exec(html)) !== null && results.length < 5) {
        results.push({ url: match[1], title: match[2].replace(/<[^>]*>/g, ''), snippet: '' });
      }
      let i = 0;
      while ((match = snippetRegex.exec(html)) !== null && i < results.length) {
        if (results[i]) results[i].snippet = match[1].replace(/<[^>]*>/g, '');
        i++;
      }
      this._stats.pagesVisited++;
      return results;
    } catch (err) {
      console.warn('[BrowserAgent] Búsqueda falló:', err.message);
      this._stats.errors++;
      return [];
    }
  }

  async _httpFallback(url) {
    try {
      const res = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: this.timeout,
      });
      const html = res.data;
      const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
      return { title: titleMatch ? titleMatch[1] : '', content: text.substring(0, 6000), url, source: 'http' };
    } catch (err) {
      return { title: '', content: `Error al acceder a ${url}: ${err.message}`, url, source: 'error' };
    }
  }

  async close() {
    if (this._browser) {
      await this._browser.close();
      this._browser = null;
    }
  }

  getStats() {
    return { ...this._stats, enabled: this.enabled };
  }
}

module.exports = BrowserAgent;
