/**
 * LLM Client — Cliente para LM Studio con retry, timeout y fallback a OpenRouter
 * Resuelve el problema de congelamiento del ARIA v2
 */

const axios = require('axios');

class LLMClient {
  constructor() {
    this.lmUrl = process.env.LM_STUDIO_BASE_URL || 'http://localhost:1234/v1';
    this.lmModel = process.env.LM_STUDIO_MODEL || 'qwen3-30b-a3b';
    this.timeout = parseInt(process.env.LM_STUDIO_TIMEOUT_MS) || 30000;
    this.maxTokens = parseInt(process.env.LM_STUDIO_MAX_TOKENS) || 4096;
    this.temperature = parseFloat(process.env.LM_STUDIO_TEMPERATURE) || 0.7;

    this.orUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
    this.orModel = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-r1-0528';
    this.orKey = process.env.OPENROUTER_API_KEY;

    this._lmAvailable = true;
    this._lastLMCheck = 0;
    this._LM_COOLDOWN = 60000; // 1 min de cooldown si falla
  }

  /**
   * Llama al LLM con retry automático y fallback a OpenRouter.
   * @param {Array} messages - Array de mensajes {role, content}
   * @param {Object} opts - Opciones opcionales (maxTokens, temperature)
   * @returns {Promise<string>} Texto de respuesta
   */
  async chat(messages, opts = {}) {
    const maxTokens = opts.maxTokens || this.maxTokens;
    const temperature = opts.temperature !== undefined ? opts.temperature : this.temperature;

    // Intentar LM Studio primero (si no está en cooldown)
    if (this._lmAvailable || (Date.now() - this._lastLMCheck > this._LM_COOLDOWN)) {
      try {
        const result = await this._callLMStudio(messages, maxTokens, temperature);
        this._lmAvailable = true;
        return result;
      } catch (err) {
        console.warn(`[LLM] LM Studio falló: ${err.message}`);
        this._lmAvailable = false;
        this._lastLMCheck = Date.now();
      }
    }

    // Fallback a OpenRouter
    if (this.orKey) {
      try {
        console.log('[LLM] Usando fallback OpenRouter...');
        return await this._callOpenRouter(messages, maxTokens, temperature);
      } catch (err) {
        console.error(`[LLM] OpenRouter también falló: ${err.message}`);
      }
    }

    throw new Error('Sin modelo disponible. LM Studio y OpenRouter fallaron.');
  }

  async _callLMStudio(messages, maxTokens, temperature) {
    // Retry hasta 3 veces para modelos reasoning
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await axios.post(`${this.lmUrl}/chat/completions`, {
          model: this.lmModel,
          messages,
          max_tokens: maxTokens,
          temperature,
          stream: false,
        }, {
          timeout: this.timeout,
          headers: { 'Content-Type': 'application/json' }
        });

        const msg = res.data?.choices?.[0]?.message;
        // Algunos modelos (Qwen) ponen el razonamiento en reasoning_content
        // Usar content si existe, si no, usar reasoning_content
        const content = msg?.content || msg?.reasoning_content || '';
        if (!content) throw new Error('Respuesta vacía del modelo');

        // Limpiar thinking tags si el modelo las incluye
        return this._cleanResponse(content);

      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          console.warn(`[LLM] LM Studio intento ${attempt} falló, reintentando...`);
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    }
    throw lastErr;
  }

  async _callOpenRouter(messages, maxTokens, temperature) {
    const res = await axios.post(`${this.orUrl}/chat/completions`, {
      model: this.orModel,
      messages,
      max_tokens: maxTokens,
      temperature,
    }, {
      timeout: 45000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.orKey}`,
        'HTTP-Referer': 'https://anhermer.com',
        'X-Title': 'ARIA v3',
      }
    });

    const content = res.data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Respuesta vacía de OpenRouter');
    return this._cleanResponse(content);
  }

  /**
   * Limpia el output del modelo: elimina <think>...</think> y bloques de razonamiento
   */
  _cleanResponse(text) {
    if (!text) return '';
    return text
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^[\s\n]+/, '')
      .trim();
  }

  /**
   * Verifica si LM Studio está disponible (health check)
   */
  async healthCheck() {
    try {
      await axios.get(`${this.lmUrl}/models`, { timeout: 5000 });
      this._lmAvailable = true;
      return true;
    } catch {
      this._lmAvailable = false;
      return false;
    }
  }
}

module.exports = new LLMClient(); // Singleton
