/**
 * Workers Entry Point — BRECHA 7
 *
 * Levanta todos los BullMQ workers en un solo proceso.
 * En producción: deployar cada worker como proceso independiente.
 *
 * Uso:
 *   node apps/workers/src/index.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const { startResearchWorker } = require('./research_worker');
const { startDocumentWorker } = require('./document_worker');

const MemorySystem5Layers = require('../../../core/memory-layers/memory_system');
const RAGSystem = require('../../../services/rag/rag_system');

async function startAllWorkers() {
  console.log('🚀 Iniciando ARIA Workers...');

  const memory = new MemorySystem5Layers();
  await memory.init();

  const rag = new RAGSystem();
  await rag.init();

  const researchWorker = startResearchWorker();
  const documentWorker = startDocumentWorker(memory, rag);

  console.log('✅ Workers activos:');
  console.log('   - research (BullMQ)');
  console.log('   - documents (BullMQ)');

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('Cerrando workers...');
    await researchWorker.close();
    await documentWorker.close();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await researchWorker.close();
    await documentWorker.close();
    process.exit(0);
  });
}

if (require.main === module) {
  startAllWorkers().catch(err => {
    console.error('❌ Error iniciando workers:', err);
    process.exit(1);
  });
}

module.exports = { startAllWorkers };
