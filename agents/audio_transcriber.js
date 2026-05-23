/**
 * AudioTranscriber — Transcribe audio a texto usando Whisper vía LM Studio
 * Compatible con archivos OGG (WhatsApp) y MP3/WAV
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const FormData = require('form-data');

const TEMP_DIR = path.join(__dirname, '..', 'temp');

class AudioTranscriber {
  constructor() {
    this.lmUrl = process.env.LM_STUDIO_BASE_URL || 'http://localhost:1234/v1';
    this.whisperUrl = process.env.WHISPER_URL || 'http://localhost:9090';
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  async transcribe(audioBuffer) {
    const tempPath = path.join(TEMP_DIR, `audio_${Date.now()}.ogg`);
    const wavPath = tempPath.replace('.ogg', '.wav');

    try {
      fs.writeFileSync(tempPath, audioBuffer);

      // Convertir a WAV con ffmpeg
      try {
        const ffmpegPath = require('ffmpeg-static');
        execSync(`"${ffmpegPath}" -y -i "${tempPath}" -ar 16000 -ac 1 "${wavPath}" 2>/dev/null`);
      } catch {
        // Si ffmpeg falla, intentar con el archivo original
        fs.copyFileSync(tempPath, wavPath);
      }

      // Intentar Whisper local primero
      try {
        return await this._transcribeWhisper(wavPath);
      } catch {}

      // Fallback: transcripción simulada (para desarrollo)
      return '[Transcripción no disponible — configura Whisper en WHISPER_URL]';

    } finally {
      try { fs.unlinkSync(tempPath); } catch {}
      try { fs.unlinkSync(wavPath); } catch {}
    }
  }

  async _transcribeWhisper(audioPath) {
    const form = new FormData();
    form.append('file', fs.createReadStream(audioPath));
    form.append('model', 'whisper-1');
    form.append('language', 'es');

    const res = await axios.post(`${this.whisperUrl}/v1/audio/transcriptions`, form, {
      headers: form.getHeaders(),
      timeout: 30000,
    });

    return res.data?.text || '';
  }
}

module.exports = AudioTranscriber;
