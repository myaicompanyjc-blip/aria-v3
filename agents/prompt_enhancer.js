/**
 * PromptEnhancer — Mejora prompts de imagen usando el LLM local
 */

const llm = require('../lib/llm_client');

class PromptEnhancer {
  async enhance(prompt, style = 'fotorealista') {
    const styles = {
      fotorealista: 'photorealistic, high detail, professional photography, 8k, sharp focus',
      ilustracion: 'digital illustration, vibrant colors, clean lines, artistic',
      corporativo: 'corporate professional, clean background, business style, high quality',
      minimalista: 'minimalist design, clean, simple, white background, professional',
      artistico: 'artistic, painterly, creative, expressive, detailed',
    };
    const styleStr = styles[style] || styles.fotorealista;

    try {
      const enhanced = await llm.chat([
        {
          role: 'system',
          content: 'Eres un experto en prompts de generación de imágenes. Mejora el prompt dado para obtener imágenes de alta calidad. Responde SOLO con el prompt mejorado en inglés, sin explicaciones.'
        },
        {
          role: 'user',
          content: `Mejora este prompt para generar una imagen ${style}: "${prompt}"\nEstilo: ${styleStr}\nPrompt mejorado:`
        }
      ], { maxTokens: 200, temperature: 0.5 });

      return enhanced.trim() || `${prompt}, ${styleStr}`;
    } catch {
      return `${prompt}, ${styleStr}`;
    }
  }
}

module.exports = PromptEnhancer;
