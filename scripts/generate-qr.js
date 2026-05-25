require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs');
const QR = require('qrcode');
const pino = require('pino');

const SESSION_PATH = process.env.WHATSAPP_SESSION_PATH || path.join(__dirname, '..', 'whatsapp', 'sessions');
if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });

const QR_PATH = path.join(__dirname, '..', 'whatsapp', 'qr-aria.png');

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'warn' }),
    auth: state,
    defaultQueryTimeoutMs: undefined,
  });

  let qrCount = 0;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrCount++;
      await QR.toFile(QR_PATH, qr, { type: 'png', width: 500, margin: 3, color: { dark: '#000', light: '#fff' } });
      console.log(`[${new Date().toLocaleTimeString()}] ✅ QR #${qrCount} actualizado en: ${QR_PATH}`);
      console.log('   Escanea el código con WhatsApp en tu teléfono.\n');
    }
    if (connection === 'open') {
      console.log('\n🎉 WhatsApp conectado exitosamente. El bot ya está autenticado.');
      console.log(`   Puedes cerrar este proceso (Ctrl+C) y ejecutar: node agent.js\n`);
      process.exit(0);
    }
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;
      if (!shouldReconnect) {
        console.error('\n❌ Sesión cerrada por logout. Elimina la carpeta sessions y vuelve a intentar.');
        process.exit(1);
      }
    }
  });

  console.log('\n📱 Escanea el QR con WhatsApp desde tu teléfono');
  console.log('   Abre WhatsApp > Dispositivos vinculados > Vincular dispositivo\n');
  console.log('   ⚡ El QR se actualiza automáticamente cada ~20s en la imagen PNG.');
  console.log('   Solo necesitas volver a abrir la imagen si ves que expiró.\n');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
