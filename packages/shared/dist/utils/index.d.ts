/**
 * @aria/shared — Utilidades compartidas
 */
/**
 * Estimación rápida de tokens (~4 chars por token).
 * Para presupuesto de contexto, no para billing.
 */
export declare function estimateTokens(text: string): number;
/**
 * Trunca texto a un límite de tokens aproximado.
 */
export declare function truncateToTokens(text: string, maxTokens: number): string;
/**
 * Formatea ms en string legible: 1234 → "1.2s", 234 → "234ms"
 */
export declare function formatMs(ms: number): string;
/**
 * Sanitiza userId/phone para uso como clave.
 */
export declare function sanitizeUserId(userId: string): string;
/**
 * Genera un runId corto para logs (primeros 8 chars del UUID).
 */
export declare function shortId(uuid: string): string;
/**
 * Limita un array a los últimos N elementos.
 */
export declare function lastN<T>(arr: T[], n: number): T[];
/**
 * Ordena partes de contexto por prioridad y trunca al límite de tokens.
 * Útil para evitar desbordamiento del contexto del LLM con documentos largos.
 */
export declare function pruneContext(parts: Array<{
    text: string;
    priority: number;
    label: string;
}>, maxTokens?: number): string;
/**
 * Retry con backoff exponencial.
 */
export declare function withRetry<T>(fn: () => Promise<T>, maxAttempts?: number, baseDelayMs?: number): Promise<T>;
//# sourceMappingURL=index.d.ts.map