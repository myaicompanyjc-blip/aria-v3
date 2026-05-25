/**
 * ARIA v3.1 — Punto de entrada
 * Arranca WhatsApp, inicializa servicios y comienza a escuchar mensajes.
 *
 * MEJORAS v3.1:
 * - Usa MemorySystem5Layers en lugar de ConversationMemory plano
 * - Rate limiting integrado en AriaBrain
 * - Structured logging con pino (BRECHA 8 Quick Win)
 */

require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs');
const pino = require('pino');

const AriaBrain = require('./core/aria_brain');
// BRECHA 5: Usar MemorySystem5Layers en lugar de ConversationMemory
const MemorySystem5Layers = require('./core/memory-layers/memory_system');
const WhatsAppSender = require('./lib/whatsapp_sender');
const MessageExtractor = require('./lib/message_extractor');

// Structured logging (BRECHA 8 Quick Win)
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined
});

const SESSION_PATH = process.env.WHATSAPP_SESSION_PATH || './whatsapp/sessions';
if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });

let brain = null;
let sender = null;
let sock = null;

// Rate limiting por usuario (Mejora E)
const userRateLimit = new Map();

function checkRateLimit(phone) {
  const now = Date.now();
  const state = userRateLimit.get(phone) || { count: 0, resetAt: now + 60000, warned: false };
  if (now > state.resetAt) {
    state.count = 0;
    state.resetAt = now + 60000;
    state.warned = false;
  }
  state.count++;
  userRateLimit.set(phone, state);
  const max = parseInt(process.env.RATE_LIMIT_PER_MINUTE || '30');
  if (state.count > max) {
    if (!state.warned) {
      state.warned = true;
      return 'warn';
    }
    return 'block';
  }
  return 'ok';
}

// Limpiar rate limit cada 5 minutos
setInterval(() => {
  const now = Date.now();
  for (const [phone, state] of userRateLimit.entries()) {
    if (now > state.resetAt) userRateLimit.delete(phone);
  }
}, 300000);

async function startAria() {
  logger.info('🤖 Iniciando ARIA v3.1...');

  // BRECHA 5: Inicializar sistema de memoria de 5 capas
  const memory = new MemorySystem5Layers();
  await memory.init();
  logger.info('✅ Memory System 5 capas inicializado');

  // Inicializar cerebro con el nuevo memory system
  brain = new AriaBrain(memory);
  await brain.init();
  logger.info('✅ Brain v3.1 inicializado (Planner + Reasoning + RAG)');

  await connectWhatsApp(memory);
}

async function connectWhatsApp(memory) {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
  const { version } = await fetchLatestBaileysVersion();

  const waLogger = pino({ level: 'warn' });

  sock = makeWASocket({
    version,
    logger: waLogger,
    auth: state,
    getMessage: async () => undefined,
    defaultQueryTimeoutMs: undefined,
  });

  sender = new WhatsAppSender(sock);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      const qrcode = require('qrcode-terminal');
      const QRCode = require('qrcode');
      console.log('\n🔐 Escanea este código QR con WhatsApp:');
      qrcode.generate(qr, { small: true });
      const qrPath = path.join(__dirname, 'whatsapp', 'qr-aria.png');
      QRCode.toFile(qrPath, qr, { type: 'png', width: 400 }, () => {});
      console.log(`📷 QR guardado en: ${qrPath}`);
      console.log('\n📱 Abre WhatsApp > Menú > WhatsApp Web > Escanear código\n');
    }
    if (connection === 'close') {
      const isLoggedOut = lastDisconnect?.error instanceof Boom
        && lastDisconnect.error.output?.statusCode === DisconnectReason.loggedOut;
      if (isLoggedOut) {
        logger.info('Sesión no válida o expirada. Esperando nuevo QR...');
      }
      logger.warn({ isLoggedOut }, 'Conexión WhatsApp cerrada, reconectando...');
      setTimeout(() => connectWhatsApp(memory), 3000);
    } else if (connection === 'open') {
      logger.info('✅ ARIA conectada a WhatsApp');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const jid = msg.key.remoteJid;
      if (!jid) continue;

      const phone = jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
      const isGroup = jid.endsWith('@g.us');

      // Ignorar grupos por ahora (configurable)
      if (isGroup && process.env.IGNORE_GROUPS === 'true') continue;

      const startTime = Date.now();

      const rateCheck = checkRateLimit(phone);
      if (rateCheck === 'block') {
        logger.warn({ phone }, 'Rate limit excedido, ignorando mensaje');
        continue;
      }
      if (rateCheck === 'warn') {
        try {
          await sock.sendMessage(jid, { text: '⏳ Estás enviando mensajes muy rápido. Un momento...' });
        } catch {}
      }

      try {
        const extracted = await MessageExtractor.extract(msg, sock);
        if (!extracted) continue;

        logger.info({ phone, type: extracted.type }, 'Mensaje recibido');

        const response = await brain.process(phone, extracted, sock, jid);
        if (!response) continue;

        await sender.send(jid, response, msg);

        const elapsed = Date.now() - startTime;
        logger.info({ phone, type: response.type, ms: elapsed }, 'Respuesta enviada');

      } catch (err) {
        logger.error({ phone, err: err.message }, 'Error procesando mensaje');
        try {
          await sock.sendMessage(jid, {
            text: '⚠️ Ocurrió un error procesando tu mensaje. Por favor intenta de nuevo.'
          });
        } catch {}
      }
    }
  });
}

// Qdrant health check — reconecta automáticamente cuando vuelva
setInterval(async () => {
  try {
    const axios = require('axios');
    const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
    await axios.get(qdrantUrl, { timeout: 3000 });
    if (brain?.rag?.retriever?.vectorStore && !brain.rag.retriever.vectorStore._available) {
      logger.info('Qdrant detectado, reconectando...');
      await brain.rag.retriever.vectorStore.init();
      if (brain.rag.retriever.vectorStore._available) {
        logger.info('✅ Qdrant reconectado');
      }
    }
  } catch {}
}, 30000);

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Cerrando ARIA...');
  if (sock) sock.end();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.error({ err: err.message }, 'Error no capturado');
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Promise rechazada no manejada');
});

startAria().catch(err => {
  logger.error({ err: err.message }, 'Error fatal iniciando ARIA');
  process.exit(1);
});
