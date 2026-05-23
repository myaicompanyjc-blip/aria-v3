/**
 * WebSearch — Búsqueda web multi-fuente
 * DuckDuckGo como principal, con scraping de resultados reales
 */

const axios = require('axios');
const cheerio = require('cheerio');

class WebSearch {
  constructor() {
    this.timeout = 10000;
    this.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  }

  /**
   * Busca en la web y retorna resultados estructurados
   * @param {string} query
   * @returns {Promise<Array<{title, snippet, url}>>}
   */
  async search(query) {
    // Intentar múltiples fuentes
    const sources = [
      () => this._searchDDG(query),
      () => this._searchBrave(query),
    ];

    for (const source of sources) {
      try {
        const results = await source();
        if (results && results.length > 0) return results;
      } catch {}
    }

    return [];
  }

  async _searchDDG(query) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=co-es`;
    const res = await axios.get(url, {
      timeout: this.timeout,
      headers: {
        'User-Agent': this.userAgent,
        'Accept-Language': 'es-CO,es;q=0.9',
        'Accept': 'text/html',
      }
    });

    const $ = cheerio.load(res.data);
    const results = [];

    $('.result').each((i, el) => {
      if (i >= 8) return;
      const title = $(el).find('.result__title').text().trim();
      const snippet = $(el).find('.result__snippet').text().trim();
      const href = $(el).find('.result__url').text().trim();
      if (title && snippet) {
        results.push({ title, snippet, url: href || '' });
      }
    });

    return results;
  }

  async _searchBrave(query) {
    // Brave Search API (si tiene key)
    const key = process.env.BRAVE_SEARCH_API_KEY;
    if (!key) throw new Error('No Brave API key');

    const res = await axios.get('https://api.search.brave.com/res/v1/web/search', {
      params: { q: query, count: 8, lang: 'es', country: 'CO' },
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': key },
      timeout: this.timeout,
    });

    return (res.data?.web?.results || []).map(r => ({
      title: r.title,
      snippet: r.description,
      url: r.url,
    }));
  }
}

module.exports = WebSearch;
