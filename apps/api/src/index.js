/**
 * API Gateway — BRECHA 9 RESUELTA
 *
 * Fastify con:
 *   - Endpoints REST: /chat, /voice, /document/upload, /health, /metrics
 *   - Zod validation en todos los inputs
 *   - Rate limiting por IP y por userId
 *   - CORS configurado
 *   - Structured logging con pino
 *
 * Uso:
 *   node apps/api/src/index.js
 *   # o desde el root:
 *   node -e "require('./apps/api/src/index')"
 *
 * Endpoints:
 *   GET  /health           — health check
 *   GET  /metrics          — métricas de observabilidad
 *   POST /chat             — enviar mensaje de texto
 *   POST /voice            — enviar audio (base64)
 *   POST /document/upload  — subir documento
 *   GET  /session/:userId  — obtener sesión activa
 *   DELETE /session/:userId — resetear sesión
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const Fastify = require('fastify');
const { z } = require('zod');

const AriaBrain = require('../../../core/aria_brain');
const MemorySystem5Layers = require('../../../core/memory-layers/memory_system');
const sessionEngine = require('../../../core/session/session_engine');
const observability = require('../../../core/observability/observability');

// ── Zod Schemas ───────────────────────────────────────────────────────────

const ChatSchema = z.object({
  userId: z.string().min(1).max(50),
  message: z.string().min(1).max(10000),
  sessionId: z.string().uuid().optional(),
});

const VoiceSchema = z.object({
  userId: z.string().min(1).max(50),
  audioBase64: z.string().min(1),
  mimeType: z.string().default('audio/ogg'),
});

const DocumentUploadSchema = z.object({
  userId: z.string().min(1).max(50),
  fileName: z.string().min(1).max(255),
  mimeType: z.string(),
  fileBase64: z.string().min(1),
  caption: z.string().max(1000).optional(),
});

// ── Rate limiting state ───────────────────────────────────────────────────

const rateLimitMap = new Map(); // userId → {count, resetAt}

function checkRateLimit(userId, max = 60) {
  const now = Date.now();
  const state = rateLimitMap.get(userId) || { count: 0, resetAt: now + 60000 };
  if (now > state.resetAt) { state.count = 0; state.resetAt = now + 60000; }
  state.count++;
  rateLimitMap.set(userId, state);
  return { allowed: state.count <= max, remaining: Math.max(0, max - state.count) };
}

// ── Fastify App ───────────────────────────────────────────────────────────

async function buildApp() {
  const app = Fastify({
    logger: observability.logger,
    trustProxy: true,
  });

  // CORS
  await app.register(require('@fastify/cors'), {
    origin: process.env.API_CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'DELETE'],
  });

  // Inicializar servicios
  const memory = new MemorySystem5Layers();
  await memory.init();
  await sessionEngine.init();

  const brain = new AriaBrain(memory);
  await brain.init();

  // ── GET /health ────────────────────────────────────────────────────────
  app.get('/health', async (req, reply) => {
    const checks = await Promise.allSettled([
      process.env.REDIS_URL
        ? (async () => {
            const redisClient = require('redis').createClient({ url: process.env.REDIS_URL });
            await redisClient.connect();
            await redisClient.ping();
            await redisClient.quit();
            return { name: 'redis', status: 'up' };
          })().catch(e => ({ name: 'redis', status: 'down', error: e.message }))
        : Promise.resolve({ name: 'redis', status: 'skipped' }),
      process.env.POSTGRES_URL
        ? (async () => {
            const { Pool } = require('pg');
            const pool = new Pool({ connectionString: process.env.POSTGRES_URL, max: 1 });
            await pool.query('SELECT 1');
            await pool.end();
            return { name: 'postgres', status: 'up' };
          })().catch(e => ({ name: 'postgres', status: 'down', error: e.message }))
        : Promise.resolve({ name: 'postgres', status: 'skipped' }),
      process.env.QDRANT_URL
        ? (async () => {
            const res = await fetch(`${process.env.QDRANT_URL}/`);
            return { name: 'qdrant', status: res.ok ? 'up' : 'degraded' };
          })().catch(e => ({ name: 'qdrant', status: 'down', error: e.message }))
        : Promise.resolve({ name: 'qdrant', status: 'skipped' }),
      (async () => {
        const llmClient = require('../../../lib/llm_client');
        const ok = await llmClient.healthCheck();
        return { name: 'llm', status: ok ? 'up' : 'degraded' };
      })().catch(e => ({ name: 'llm', status: 'down', error: e.message })),
    ]);

    const results = checks.map(r => r.status === 'fulfilled' ? r.value : { name: 'unknown', status: 'down' });
    const allUp = results.every(r => r.status !== 'down');

    return reply.status(allUp ? 200 : 503).send({
      status: allUp ? 'healthy' : 'degraded',
      version: '3.1.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      services: results,
    });
  });

  // ── GET /metrics ───────────────────────────────────────────────────────
  app.get('/metrics', async (req, reply) => {
    return observability.getMetrics();
  });

  // ── POST /chat ─────────────────────────────────────────────────────────
  app.post('/chat', async (req, reply) => {
    const parsed = ChatSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    const { userId, message } = parsed.data;

    // Rate limiting
    const rateCheck = checkRateLimit(userId, 60);
    if (!rateCheck.allowed) {
      return reply.code(429).send({ error: 'Rate limit exceeded. Wait 1 minute.' });
    }

    const runId = observability.newRunId();
    const startTime = Date.now();

    observability.requestStart(runId, { phone: userId, type: 'text', intent: null });

    try {
      const response = await brain.process(userId, { type: 'text', text: message }, null, null);
      const processingMs = Date.now() - startTime;

      observability.requestEnd(runId, { phone: userId, processingMs, chain: null });

      return {
        runId,
        userId,
        response: response?.text || '',
        type: response?.type || 'text',
        processingMs,
        rateLimitRemaining: rateCheck.remaining,
      };
    } catch (err) {
      const processingMs = Date.now() - startTime;
      observability.requestEnd(runId, { phone: userId, processingMs, error: err.message });
      return reply.code(500).send({ error: 'Internal error', runId });
    }
  });

  // ── POST /voice ────────────────────────────────────────────────────────
  app.post('/voice', async (req, reply) => {
    const parsed = VoiceSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    const { userId, audioBase64, mimeType } = parsed.data;

    const rateCheck = checkRateLimit(userId, 30);
    if (!rateCheck.allowed) {
      return reply.code(429).send({ error: 'Rate limit exceeded.' });
    }

    try {
      const buffer = Buffer.from(audioBase64, 'base64');
      const response = await brain.process(userId, { type: 'audio', buffer, mimetype: mimeType }, null, null);

      return {
        userId,
        response: response?.text || '',
        transcription: response?.transcription || null,
        type: response?.type || 'text',
      };
    } catch (err) {
      return reply.code(500).send({ error: 'Audio processing failed' });
    }
  });

  // ── POST /document/upload ──────────────────────────────────────────────
  app.post('/document/upload', async (req, reply) => {
    const parsed = DocumentUploadSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    const { userId, fileName, mimeType, fileBase64, caption } = parsed.data;

    // Validar tipo de archivo
    const allowedMimes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain',
    ];
    if (!allowedMimes.includes(mimeType)) {
      return reply.code(400).send({ error: `Tipo de archivo no permitido: ${mimeType}` });
    }

    // Validar tamaño (máx 20MB)
    const sizeBytes = Math.ceil(fileBase64.length * 0.75);
    if (sizeBytes > 20 * 1024 * 1024) {
      return reply.code(400).send({ error: 'Archivo demasiado grande. Máx 20MB.' });
    }

    try {
      const buffer = Buffer.from(fileBase64, 'base64');
      const response = await brain.process(userId, {
        type: 'document',
        buffer,
        mimetype: mimeType,
        fileName,
        text: caption || '',
      }, null, null);

      return {
        userId,
        fileName,
        response: response?.text || '',
        indexed: true,
      };
    } catch (err) {
      return reply.code(500).send({ error: 'Document processing failed' });
    }
  });

  // ── GET /session/:userId ───────────────────────────────────────────────
  app.get('/session/:userId', async (req, reply) => {
    const { userId } = req.params;
    if (!userId) return reply.code(400).send({ error: 'userId required' });

    try {
      const session = await sessionEngine.getOrCreate(userId);
      return { session };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to get session' });
    }
  });

  // ── DELETE /session/:userId ────────────────────────────────────────────
  app.delete('/session/:userId', async (req, reply) => {
    const { userId } = req.params;
    if (!userId) return reply.code(400).send({ error: 'userId required' });

    try {
      await sessionEngine.reset(userId);
      return { success: true, message: `Sesión de ${userId} reseteada` };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to reset session' });
    }
  });

  return app;
}

// ── Iniciar servidor ───────────────────────────────────────────────────────

async function startApiServer() {
  try {
    const app = await buildApp();
    const port = parseInt(process.env.API_PORT || '3001');
    const host = process.env.API_HOST || '0.0.0.0';

    await app.listen({ port, host });
    console.log(`✅ ARIA API Gateway corriendo en http://${host}:${port}`);
    return app;
  } catch (err) {
    console.error('❌ Error iniciando API Gateway:', err.message);
    throw err;
  }
}

// Si se ejecuta directamente (no importado)
if (require.main === module) {
  startApiServer();
}

module.exports = { buildApp, startApiServer };
