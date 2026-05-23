/**
 * AudioResponse — Convierte texto a audio con Edge-TTS (Microsoft)
 * Voz: es-CO-SalomeNeural (colombiana femenina, natural)
 */

const { execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const TEMP_DIR = path.join(__dirname, '..', 'temp');

class AudioResponse {
  constructor() {
    this.voice = process.env.EDGE_TTS_VOICE || 'es-CO-SalomeNeural';
    this.rate = process.env.EDGE_TTS_RATE || '+20%';
    this.pitch = process.env.EDGE_TTS_PITCH || '+8Hz';
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  async generate(text) {
    if (!text || text.trim().length === 0) throw new Error('Texto vacío');

    const audioPath = path.join(TEMP_DIR, `tts_${Date.now()}.ogg`);
    const mp3Path = audioPath.replace('.ogg', '.mp3');

    // Limpiar texto para TTS
    const cleanText = this._clean(text);

    return new Promise((resolve, reject) => {
      // edge-tts genera MP3
      const cmd = `edge-tts --voice "${this.voice}" --rate "${this.rate}" --pitch "${this.pitch}" --text "${cleanText.replace(/"/g, "'")}" --write-media "${mp3Path}"`;

      exec(cmd, { timeout: 30000 }, async (err) => {
        if (err || !fs.existsSync(mp3Path)) {
          // Fallback: crear archivo de silencio
          try {
            const ffmpegPath = require('ffmpeg-static');
            execSync(`"${ffmpegPath}" -y -f lavfi -i anullsrc=r=22050:cl=mono -t 1 "${audioPath}" 2>/dev/null`);
            resolve({ audioPath });
          } catch {
            reject(new Error('TTS no disponible'));
          }
          return;
        }

        // Convertir MP3 → OGG (requerido por WhatsApp para ptt)
        try {
          const ffmpegPath = require('ffmpeg-static');
          execSync(`"${ffmpegPath}" -y -i "${mp3Path}" -c:a libopus -b:a 32k "${audioPath}" 2>/dev/null`);
          try { fs.unlinkSync(mp3Path); } catch {}
          resolve({ audioPath });
        } catch {
          // Usar MP3 directamente como fallback
          resolve({ audioPath: mp3Path });
        }
      });
    });
  }

  _clean(text) {
    return text
      .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
      .replace(/_{1,2}([^_]+)_{1,2}/g, '$1')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]+`/g, '')
      .replace(/[[\]()]/g, '')
      .replace(/https?:\/\/\S+/g, 'enlace')
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
      .replace(/[•►▶◆]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s{2,}/g, ' ')
      .substring(0, 3000) // Límite práctico para TTS
      .trim();
  }
}

module.exports = AudioResponse;
