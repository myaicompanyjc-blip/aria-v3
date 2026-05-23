/**
 * CRMManager — Gestión simple de clientes y contactos
 */

const fs = require('fs');
const path = require('path');

const CRM_FILE = path.join(__dirname, '..', 'data', 'crm.json');

class CRMManager {
  constructor() {
    this._data = { clients: [], contacts: [] };
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(CRM_FILE)) {
        this._data = JSON.parse(fs.readFileSync(CRM_FILE, 'utf8'));
      }
    } catch {}
  }

  _save() {
    const dir = path.dirname(CRM_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CRM_FILE, JSON.stringify(this._data, null, 2));
  }

  addClient(data) {
    const client = { id: Date.now(), ...data, createdAt: new Date().toISOString() };
    this._data.clients.push(client);
    this._save();
    return client;
  }

  searchClients(query) {
    const q = query.toLowerCase();
    return this._data.clients.filter(c =>
      (c.name && c.name.toLowerCase().includes(q)) ||
      (c.nit && c.nit.includes(q)) ||
      (c.email && c.email.toLowerCase().includes(q))
    );
  }

  getAllClients() {
    return this._data.clients;
  }

  formatClientList(clients) {
    if (!clients || clients.length === 0) return 'No se encontraron clientes.';
    return clients.map((c, i) =>
      `*${i + 1}. ${c.name || 'Sin nombre'}*\n` +
      (c.nit ? `   NIT: ${c.nit}\n` : '') +
      (c.phone ? `   📞 ${c.phone}\n` : '') +
      (c.email ? `   📧 ${c.email}\n` : '') +
      (c.city ? `   📍 ${c.city}` : '')
    ).join('\n\n');
  }
}

module.exports = CRMManager;
