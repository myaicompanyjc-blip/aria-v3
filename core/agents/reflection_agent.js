const llm = require('../../lib/llm_client');
const fs = require('fs');
const path = require('path');

let REFLECTION_PROMPT = '';
try {
  REFLECTION_PROMPT = fs.readFileSync(
    path.join(__dirname, '..', '..', 'prompts', 'reflection-agent.md'),
    'utf8'
  );
} catch {
  REFLECTION_PROMPT = `You are the Reflection Agent — ARIA's final quality gatekeeper.
Your ONLY job is to review a response BEFORE it is sent to the user.

You must detect:
1. TOPIC CONTAMINATION — Is the response using document information when the conversation is casual or off-topic?
2. HALLUCINATION — Does the response make factual claims NOT supported by the provided context?
3. COHERENCE — Does the response actually answer the user's question?

Return JSON ONLY:
{"verdict":"PASS"|"REVISE"|"BLOCK","issues":[],"severity":"low"|"medium"|"high","revisionHint":"","reasoning":""}`;
}

class ReflectionAgent {
  async reflect(response, context, { intent, activeTopic, originalMessage }) {
    if (!response || response.length < 5) {
      return { verdict: 'PASS', issues: [], severity: 'low', revisionHint: '', reasoning: 'Empty response' };
    }

    const needsReflection = intent === 'doc_query' || intent === 'conversation' || intent === 'web_search';
    if (!needsReflection && activeTopic !== 'document') {
      return { verdict: 'PASS', issues: [], severity: 'low', revisionHint: '', reasoning: 'Skipped: low-risk intent' };
    }

    try {
      const raw = await llm.chat([
        { role: 'system', content: REFLECTION_PROMPT },
        {
          role: 'user',
          content: `User message: "${originalMessage}"
Intent: ${intent}
Active topic: ${activeTopic}

Context available:
${(context || '').substring(0, 2000)}

Response to review:
${response}

Analyze and return JSON verdict.`
        }
      ], { maxTokens: 400, temperature: 0.1 });

      const match = raw.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    } catch (err) {
      console.warn('[ReflectionAgent] Error:', err.message);
    }

    return { verdict: 'PASS', issues: [], severity: 'low', revisionHint: '', reasoning: 'Reflection unavailable' };
  }

  async revise(response, revisionHint) {
    if (!revisionHint) return response;
    try {
      const revised = await llm.chat([
        { role: 'system', content: 'Eres ARIA. Revisa tu respuesta según las indicaciones recibidas. Responde en español colombiano, tono cálido y profesional.' },
        {
          role: 'user',
          content: `Tu respuesta necesita revisión:\n\nRespuesta actual:\n${response}\n\nRevisión necesaria:\n${revisionHint}\n\nProduce la respuesta corregida:`
        }
      ], { maxTokens: 1500, temperature: 0.3 });
      return revised || response;
    } catch {
      return response;
    }
  }

  needsRegeneration(verdict) {
    return verdict === 'BLOCK' || (verdict === 'REVISE' && verdict.severity === 'high');
  }
}

module.exports = new ReflectionAgent();
