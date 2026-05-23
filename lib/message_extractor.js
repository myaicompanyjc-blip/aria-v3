/**
 * MessageExtractor — Extrae el contenido útil de mensajes de WhatsApp
 */

const fs = require('fs');
const path = require('path');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

const TEMP_DIR = path.join(__dirname, '..', 'temp');

async function extractMessage(msg, sock) {
  const m = msg.message;
  if (!m) return null;

  // Texto simple
  if (m.conversation) {
    return { type: 'text', text: m.conversation };
  }

  // Texto extendido (con preview de link, etc.)
  if (m.extendedTextMessage) {
    return { type: 'text', text: m.extendedTextMessage.text };
  }

  // Botón seleccionado
  if (m.buttonsResponseMessage) {
    return { type: 'text', text: m.buttonsResponseMessage.selectedButtonId };
  }

  // Lista seleccionada
  if (m.listResponseMessage) {
    return { type: 'text', text: m.listResponseMessage.title || m.listResponseMessage.singleSelectReply?.selectedRowId };
  }

  // Audio/voz
  if (m.audioMessage || m.pttMessage) {
    const audioMsg = m.audioMessage || m.pttMessage;
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
      return { type: 'audio', buffer, mimetype: audioMsg.mimetype };
    } catch (err) {
      console.error('[Extractor] Error descargando audio:', err.message);
      return null;
    }
  }

  // Imagen
  if (m.imageMessage) {
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
      const caption = m.imageMessage.caption || '';
      return { type: 'image', buffer, mimetype: m.imageMessage.mimetype, caption, text: caption };
    } catch (err) {
      console.error('[Extractor] Error descargando imagen:', err.message);
      return null;
    }
  }

  // Sticker
  if (m.stickerMessage) {
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
      return { type: 'sticker', buffer };
    } catch {
      return null;
    }
  }

  // Documento
  if (m.documentMessage) {
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
      const fileName = m.documentMessage.fileName || 'documento';
      const mimetype = m.documentMessage.mimetype || 'application/octet-stream';
      const caption = m.documentMessage.caption || '';
      return { type: 'document', buffer, fileName, mimetype, text: caption || `[Documento: ${fileName}]` };
    } catch (err) {
      console.error('[Extractor] Error descargando documento:', err.message);
      return null;
    }
  }

  return null;
}

module.exports = { extract: extractMessage };
