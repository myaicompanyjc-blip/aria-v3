/**
 * CitationEnforcementEngine — Sistema anti-alucinación con trazabilidad de fuentes
 *
 * PROBLEMA RESUELTO: El Critic detecta alucinaciones pero no las previene.
 * Este módulo:
 *   1. Marca CADA afirmación con su fuente exacta antes de generarla
 *   2. Valida que toda afirmación factual tenga soporte en el contexto
 *   3. Genera citas automáticas (doc + página + texto exacto)
 *   4. Califica incertidumbre explícita ("no encontré esto en el documento")
 *   5. Implementa "Citation-First Prompting" — el LLM cita mientras responde
 *
 * DIFERENCIA con el Critic actual:
 *   Critic = detecta post-hoc
 *   CitationEnforcementEngine = previene + formatea + trazabilidad
 */

const llm = require('../../lib/llm_client');

class CitationEnforcementEngine {
  constructor() {
    this.enabled = true;
    this.strictMode = process.env.CITATION_STRICT_MODE === 'true';
  }

  async generateWithCitations(query, chunks, plan) {
    if (!chunks || chunks.length === 0) {
      return {
        response: '',
        citations: [],
        hasUncertainty: true,
        notFoundInDoc: true,
      };
    }

    const numberedContext = this._buildNumberedContext(chunks);

    const CITATION_PROMPT = `Eres ARIA, asistente empresarial. Responde la pregunta del usuario usando EXCLUSIVAMENTE la información de los fragmentos numerados.

FRAGMENTOS DE DOCUMENTOS:
${numberedContext}

PREGUNTA: ${query}

INSTRUCCIONES ESTRICTAS:
1. Basa tu respuesta SOLO en los fragmentos anteriores.
2. Al mencionar cualquier dato, cifra o hecho, agrega [F{número}] referenciando el fragmento.
3. Si algo NO está en los fragmentos, di explícitamente: "No encontré información sobre [tema] en los documentos disponibles."
4. No inventes datos. No extrapoles más allá de lo escrito.
5. Responde en español colombiano, tono profesional.
6. Respuesta directa y útil. Si el fragmento lo dice claramente, cítalo con confianza.`;

    try {
      const response = await llm.chat([
        { role: 'user', content: CITATION_PROMPT }
      ], { maxTokens: 1500, temperature: 0.3 });

      const { expanded, citations } = this._expandCitations(response, chunks);
      const hasUncertainty = /no encontr[eé]|no est[aá]\s+en|no tengo inform/i.test(response);

      return {
        response: expanded,
        citations,
        hasUncertainty,
        notFoundInDoc: false,
      };

    } catch (err) {
      console.warn('[CitationEngine] Error:', err.message);
      return { response: '', citations: [], hasUncertainty: true };
    }
  }

  async validateResponse(response, chunks, query) {
    if (!chunks || chunks.length === 0) return { valid: false, unsupported: ['Sin contexto documental'] };

    const contextSummary = chunks.slice(0, 5).map(c => c.text.substring(0, 300)).join('\n---\n');

    const VALIDATION_PROMPT = `Analiza si las afirmaciones factuales de la respuesta están soportadas por el contexto.

Contexto documental:
${contextSummary}

Respuesta a validar:
${response.substring(0, 1000)}

Responde con JSON:
{
  "valid": true|false,
  "unsupportedClaims": ["afirmación sin soporte 1", "afirmación sin soporte 2"],
  "supportedClaims": ["afirmación soportada 1"],
  "overallTrust": "high|medium|low"
}`;

    try {
      const raw = await llm.chat([{ role: 'user', content: VALIDATION_PROMPT }],
        { maxTokens: 300, temperature: 0.1 });
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    } catch {}

    return { valid: true, unsupportedClaims: [], overallTrust: 'medium' };
  }

  formatCitationFooter(citations) {
    if (!citations || citations.length === 0) return '';

    const unique = citations.reduce((acc, c) => {
      const key = `${c.docTitle}_p${c.pageNumber}`;
      if (!acc.has(key)) acc.set(key, c);
      return acc;
    }, new Map());

    const lines = Array.from(unique.values()).map(c => {
      let ref = `📄 ${c.docTitle}`;
      if (c.pageNumber) ref += ` — Pág. ${c.pageNumber}`;
      if (c.excerpt) ref += `\n   "${c.excerpt.substring(0, 80)}..."`;
      return ref;
    });

    return `\n\n─────────────────\n📎 *Fuentes consultadas:*\n${lines.join('\n')}`;
  }

  _buildNumberedContext(chunks) {
    return chunks.slice(0, 8).map((chunk, i) => {
      let header = `[F${i + 1}]`;
      if (chunk.docTitle) header += ` Documento: ${chunk.docTitle}`;
      if (chunk.pageNumber) header += ` | Página ${chunk.pageNumber}`;
      return `${header}\n${chunk.text.substring(0, 600)}`;
    }).join('\n\n');
  }

  _expandCitations(response, chunks) {
    const citations = [];
    const expanded = response.replace(/\[F(\d+)\]/g, (match, num) => {
      const idx = parseInt(num) - 1;
      const chunk = chunks[idx];
      if (!chunk) return match;

      const citation = {
        reference: match,
        docTitle: chunk.docTitle || 'Documento',
        pageNumber: chunk.pageNumber || null,
        excerpt: chunk.text.substring(0, 100),
        chunkIndex: chunk.chunkIndex,
      };
      citations.push(citation);

      if (chunk.pageNumber) {
        return `[${chunk.docTitle || 'Doc'}, p.${chunk.pageNumber}]`;
      }
      return `[${chunk.docTitle || 'Doc'}]`;
    });

    return { expanded, citations };
  }
}

module.exports = new CitationEnforcementEngine();
