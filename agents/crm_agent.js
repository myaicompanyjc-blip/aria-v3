/**
 * CRMAgent — Gestión de relaciones con clientes
 *
 * Permite a ARIA gestionar contactos, empresas, negociaciones
 * y seguimiento comercial con persistencia JSON.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const CRM_FILE = path.join(DATA_DIR, 'crm_data.json');

class CRMAgent {
  constructor() {
    this._data = { contacts: [], companies: [], deals: [], activities: [] };
    this._loaded = false;
    this._dirty = false;
    this._saveTimer = null;
    this._load();
  }

  // ─── CONTACTOS ──────────────────────────────────────────────────────────────

  addContact(contact) {
    this._ensureLoaded();
    const c = {
      id: `contact_${Date.now()}`,
      name: contact.name,
      phone: contact.phone,
      email: contact.email || '',
      company: contact.company || '',
      role: contact.role || '',
      notes: contact.notes || '',
      tags: contact.tags || [],
      userId: contact.userId || 'global',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this._data.contacts.push(c);
    this._scheduleSave();
    return c;
  }

  searchContacts(query, userId = null) {
    this._ensureLoaded();
    const q = query.toLowerCase();
    return this._data.contacts.filter(c => {
      if (userId && c.userId !== userId) return false;
      return c.name.toLowerCase().includes(q) ||
        c.phone.includes(q) ||
        c.company.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        c.tags.some(t => t.toLowerCase().includes(q));
    });
  }

  // ─── EMPRESAS ───────────────────────────────────────────────────────────────

  addCompany(company) {
    this._ensureLoaded();
    const c = {
      id: `company_${Date.now()}`,
      name: company.name,
      nit: company.nit || '',
      industry: company.industry || '',
      website: company.website || '',
      phone: company.phone || '',
      address: company.address || '',
      notes: company.notes || '',
      userId: company.userId || 'global',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this._data.companies.push(c);
    this._scheduleSave();
    return c;
  }

  searchCompanies(query, userId = null) {
    this._ensureLoaded();
    const q = query.toLowerCase();
    return this._data.companies.filter(c => {
      if (userId && c.userId !== userId) return false;
      return c.name.toLowerCase().includes(q) ||
        c.nit.includes(q) ||
        c.industry.toLowerCase().includes(q);
    });
  }

  // ─── NEGOCIACIONES ──────────────────────────────────────────────────────────

  addDeal(deal) {
    this._ensureLoaded();
    const d = {
      id: `deal_${Date.now()}`,
      title: deal.title,
      companyId: deal.companyId || '',
      contactId: deal.contactId || '',
      value: deal.value || 0,
      stage: deal.stage || 'prospección', // prospección, cotización, negociación, cerrado_ganado, cerrado_perdido
      probability: deal.probability || 0,
      expectedCloseDate: deal.expectedCloseDate || '',
      notes: deal.notes || '',
      userId: deal.userId || 'global',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this._data.deals.push(d);
    this._scheduleSave();
    return d;
  }

  getDealsByStage(stage, userId = null) {
    this._ensureLoaded();
    return this._data.deals.filter(d => {
      if (userId && d.userId !== userId) return false;
      return d.stage === stage;
    });
  }

  getDealsSummary(userId = null) {
    this._ensureLoaded();
    const deals = userId ? this._data.deals.filter(d => d.userId === userId) : this._data.deals;
    const stages = {};
    let totalValue = 0;
    let wonValue = 0;
    for (const deal of deals) {
      stages[deal.stage] = (stages[deal.stage] || 0) + 1;
      totalValue += deal.value;
      if (deal.stage === 'cerrado_ganado') wonValue += deal.value;
    }
    return {
      total: deals.length,
      totalValue,
      wonValue,
      pipelineValue: totalValue - wonValue,
      stages,
      avgDealSize: deals.length > 0 ? Math.round(totalValue / deals.length) : 0,
    };
  }

  // ─── ACTIVIDADES ────────────────────────────────────────────────────────────

  addActivity(activity) {
    this._ensureLoaded();
    const a = {
      id: `activity_${Date.now()}`,
      type: activity.type, // llamada, reunión, email, nota, tarea
      title: activity.title,
      description: activity.description || '',
      contactId: activity.contactId || '',
      companyId: activity.companyId || '',
      dealId: activity.dealId || '',
      dueDate: activity.dueDate || '',
      completed: activity.completed || false,
      userId: activity.userId || 'global',
      createdAt: Date.now(),
    };
    this._data.activities.push(a);
    this._scheduleSave();
    return a;
  }

  getPendingActivities(userId = null) {
    this._ensureLoaded();
    return this._data.activities.filter(a => {
      if (userId && a.userId !== userId) return false;
      return !a.completed;
    });
  }

  // ─── FORMATO PARA LLM ──────────────────────────────────────────────────────

  formatForLLM(userId = null) {
    this._ensureLoaded();
    const contacts = userId
      ? this._data.contacts.filter(c => c.userId === userId)
      : this._data.contacts;
    const companies = userId
      ? this._data.companies.filter(c => c.userId === userId)
      : this._data.companies;
    const deals = userId
      ? this._data.deals.filter(d => d.userId === userId)
      : this._data.deals;
    const pending = userId
      ? this._data.activities.filter(a => a.userId === userId && !a.completed)
      : this._data.activities.filter(a => !a.completed);

    const parts = [];
    if (contacts.length > 0) {
      parts.push(`[CONTACTOS] (${contacts.length})`);
      parts.push(contacts.slice(0, 10).map(c => `• ${c.name} — ${c.role || ''} en ${c.company || ''} (${c.phone})`).join('\n'));
    }
    if (companies.length > 0) {
      parts.push(`[EMPRESAS] (${companies.length})`);
      parts.push(companies.slice(0, 5).map(c => `• ${c.name} — ${c.industry || ''}`).join('\n'));
    }
    if (deals.length > 0) {
      const summary = this.getDealsSummary(userId);
      parts.push(`[NEGOCIACIONES] Total: ${summary.total} | Pipeline: $${summary.pipelineValue.toLocaleString()}`);
    }
    if (pending.length > 0) {
      parts.push(`[PENDIENTES] (${pending.length})`);
      parts.push(pending.slice(0, 5).map(a => `• ${a.title} (${a.type})`).join('\n'));
    }
    return parts.join('\n\n');
  }

  // ─── PERSISTENCIA ───────────────────────────────────────────────────────────

  _ensureLoaded() {
    if (this._loaded) return;
    try {
      if (fs.existsSync(CRM_FILE)) {
        this._data = JSON.parse(fs.readFileSync(CRM_FILE, 'utf8'));
      }
    } catch { this._data = { contacts: [], companies: [], deals: [], activities: [] }; }
    this._loaded = true;
  }

  _scheduleSave() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._save(); this._saveTimer = null; }, 3000);
  }

  _save() {
    if (!this._dirty) return;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CRM_FILE, JSON.stringify(this._data, null, 2), 'utf8');
      this._dirty = false;
    } catch (err) {
      console.warn('[CRMAgent] Error guardando:', err.message);
    }
  }

  getStats() {
    this._ensureLoaded();
    return {
      contacts: this._data.contacts.length,
      companies: this._data.companies.length,
      deals: this._data.deals.length,
      activities: this._data.activities.length,
    };
  }
}

module.exports = CRMAgent;
