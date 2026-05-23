"use strict";
/**
 * @aria/shared — Utilidades compartidas
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.estimateTokens = estimateTokens;
exports.truncateToTokens = truncateToTokens;
exports.formatMs = formatMs;
exports.sanitizeUserId = sanitizeUserId;
exports.shortId = shortId;
exports.lastN = lastN;
exports.pruneContext = pruneContext;
exports.withRetry = withRetry;
/**
 * Estimación rápida de tokens (~4 chars por token).
 * Para presupuesto de contexto, no para billing.
 */
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
/**
 * Trunca texto a un límite de tokens aproximado.
 */
function truncateToTokens(text, maxTokens) {
    const maxChars = maxTokens * 4;
    if (text.length <= maxChars)
        return text;
    return text.substring(0, maxChars) + '…';
}
/**
 * Formatea ms en string legible: 1234 → "1.2s", 234 → "234ms"
 */
function formatMs(ms) {
    if (ms >= 1000)
        return `${(ms / 1000).toFixed(1)}s`;
    return `${ms}ms`;
}
/**
 * Sanitiza userId/phone para uso como clave.
 */
function sanitizeUserId(userId) {
    return userId.replace(/[^a-zA-Z0-9_\-@+]/g, '').substring(0, 50);
}
/**
 * Genera un runId corto para logs (primeros 8 chars del UUID).
 */
function shortId(uuid) {
    return uuid.substring(0, 8);
}
/**
 * Limita un array a los últimos N elementos.
 */
function lastN(arr, n) {
    return arr.length <= n ? arr : arr.slice(arr.length - n);
}
/**
 * Ordena partes de contexto por prioridad y trunca al límite de tokens.
 * Útil para evitar desbordamiento del contexto del LLM con documentos largos.
 */
function pruneContext(parts, maxTokens = 6000) {
    const sorted = [...parts].sort((a, b) => b.priority - a.priority);
    const result = [];
    let usedTokens = 0;
    for (const part of sorted) {
        const tokens = estimateTokens(part.text);
        if (usedTokens + tokens > maxTokens) {
            const remaining = maxTokens - usedTokens;
            if (remaining > 25) {
                const truncated = part.text.substring(0, remaining * 4);
                result.push(`[${part.label} - truncado]\n${truncated}`);
                usedTokens += remaining;
            }
            break;
        }
        result.push(`[${part.label}]\n${part.text}`);
        usedTokens += tokens;
    }
    return result.join('\n\n');
}
/**
 * Retry con backoff exponencial.
 */
async function withRetry(fn, maxAttempts = 3, baseDelayMs = 500) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            lastError = err;
            if (attempt < maxAttempts) {
                await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, attempt - 1)));
            }
        }
    }
    throw lastError;
}
//# sourceMappingURL=index.js.map