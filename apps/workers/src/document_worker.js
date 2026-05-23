/**
 * Document Worker — BullMQ
 *
 * Worker asíncrono para RAG queries sobre documentos.
 * Cola: 'documents'
 * Job data: { query, userId, sessionId }
 * Job result: { context: string }
 */

const { Worker, Queue, QueueEvents } = require('bullmq');

const REDIS_CONNECTION = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
};

const documentQueue = new Queue('documents', { connection: REDIS_CONNECTION });
const documentQueueEvents = new QueueEvents('documents', { connection: REDIS_CONNECTION });

function startDocumentWorker(memory, ragRetriever) {
  const DocumentAgent = require('../../../core/agents/document_agent');
  const agent = new DocumentAgent(memory, ragRetriever);

  const worker = new Worker('documents', async (job) => {
    const { query, userId, sessionId } = job.data;
    console.log(`[DocumentWorker] Procesando job ${job.id}: "${query.substring(0, 80)}"`);

    const context = await agent.query(userId, query);
    return { context, sessionId, userId };
  }, {
    connection: REDIS_CONNECTION,
    concurrency: parseInt(process.env.DOCUMENT_WORKER_CONCURRENCY || '5'),
  });

  worker.on('completed', (job) => {
    console.log(`[DocumentWorker] Job ${job.id} completado`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[DocumentWorker] Job ${job?.id} falló:`, err.message);
  });

  return worker;
}

module.exports = { documentQueue, documentQueueEvents, startDocumentWorker };
