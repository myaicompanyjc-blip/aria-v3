/**
 * WhatsAppSender — Envía respuestas por WhatsApp
 */

const fs = require('fs');

class WhatsAppSender {
  constructor(sock) {
    this.sock = sock;
  }

  async send(jid, response) {
    if (!response || !jid) return;

    const { type } = response;

    try {
      switch (type) {
        case 'text':
          await this._sendText(jid, response.text);
          break;

        case 'image':
          await this._sendImage(jid, response.buffer, response.caption);
          break;

        case 'audio':
          await this._sendAudio(jid, response.audioPath, response.transcriptionNote);
          break;

        case 'document':
          await this._sendDocument(jid, response.filePath, response.fileName, response.caption);
          break;

        default:
          if (response.text) await this._sendText(jid, response.text);
      }

      // Nota de transcripción (para audios)
      if (response.transcriptionNote) {
        await this._sendText(jid, response.transcriptionNote);
      }

    } catch (err) {
      console.error(`[Sender] Error enviando a ${jid}:`, err.message);
    }
  }

  async _sendText(jid, text) {
    if (!text) return;
    // Dividir mensajes muy largos
    const chunks = this._splitMessage(text, 4000);
    for (const chunk of chunks) {
      await this.sock.sendMessage(jid, { text: chunk });
      if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
    }
  }

  async _sendImage(jid, buffer, caption) {
    if (!buffer) return;
    await this.sock.sendMessage(jid, { image: buffer, caption: caption || '' });
  }

  async _sendAudio(jid, audioPath, transcription) {
    if (!audioPath || !fs.existsSync(audioPath)) return;
    const buffer = fs.readFileSync(audioPath);
    await this.sock.sendMessage(jid, { audio: buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true });
    // Limpiar archivo temporal
    try { fs.unlinkSync(audioPath); } catch {}
  }

  async _sendDocument(jid, filePath, fileName, caption) {
    if (!filePath || !fs.existsSync(filePath)) return;
    const buffer = fs.readFileSync(filePath);
    const mimetype = this._getMimeType(fileName);
    await this.sock.sendMessage(jid, {
      document: buffer,
      fileName: fileName || 'documento',
      mimetype,
      caption: caption || '',
    });
  }

  _getMimeType(fileName) {
    if (!fileName) return 'application/octet-stream';
    const ext = fileName.split('.').pop()?.toLowerCase();
    const types = {
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      mp3: 'audio/mpeg',
      mp4: 'video/mp4',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
    };
    return types[ext] || 'application/octet-stream';
  }

  _splitMessage(text, maxLen) {
    if (text.length <= maxLen) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      // Cortar en el último salto de línea dentro del límite
      let cutAt = maxLen;
      const lastNewline = remaining.lastIndexOf('\n', maxLen);
      if (lastNewline > maxLen * 0.6) cutAt = lastNewline;
      chunks.push(remaining.substring(0, cutAt));
      remaining = remaining.substring(cutAt).trimStart();
    }
    return chunks;
  }
}

module.exports = WhatsAppSender;
