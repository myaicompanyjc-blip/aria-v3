/**
 * Research Worker — BullMQ
 *
 * Worker asíncrono para tareas de búsqueda web.
 * Upgrade path: desplegar como proceso independiente con PM2 o Docker.
 *
 * Cola: 'research'
 * Job data: { query, sessionId, userId }
 * Job result: { context: string, sources: [] }
 */

const { Worker, Queue, QueueEvents } = require('bullmq');
const ResearchAgent = require('../../../core/agents/research_agent');

const REDIS_CONNECTION = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
};

// ── Queue exportable para enqueue desde CEOAgent ───────────────────────────
const researchQueue = new Queue('research', { connection: REDIS_CONNECTION });
const researchQueueEvents = new QueueEvents('research', { connection: REDIS_CONNECTION });

// ── Worker ────────────────────────────────────────────────────────────────
function startResearchWorker() {
  const agent = new ResearchAgent();

  const worker = new Worker('research', async (job) => {
    const { query, sessionId, userId } = job.data;
    console.log(`[ResearchWorker] Procesando job ${job.id}: "${query.substring(0, 80)}"`);

    const context = await agent.research(query);
    return { context, sessionId, userId };
  }, {
    connection: REDIS_CONNECTION,
    concurrency: parseInt(process.env.RESEARCH_WORKER_CONCURRENCY || '3'),
  });

  worker.on('completed', (job) => {
    console.log(`[ResearchWorker] Job ${job.id} completado`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[ResearchWorker] Job ${job?.id} falló:`, err.message);
  });

  return worker;
}

module.exports = { researchQueue, researchQueueEvents, startResearchWorker };
