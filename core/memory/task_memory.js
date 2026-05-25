const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const TASK_FILE = path.join(DATA_DIR, 'task_memory.json');

const MAX_TASKS_PER_USER = 50;

class TaskMemory {
  constructor() {
    this._tasks = [];
    this._loaded = false;
    this._dirty = false;
    this._saveTimer = null;
  }

  _ensureLoaded() {
    if (this._loaded) return;
    try {
      if (fs.existsSync(TASK_FILE)) {
        this._tasks = JSON.parse(fs.readFileSync(TASK_FILE, 'utf8'));
      }
    } catch { this._tasks = []; }
    this._loaded = true;
  }

  _scheduleSave() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._save();
      this._saveTimer = null;
    }, 3000);
  }

  _save() {
    if (!this._dirty) return;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(TASK_FILE, JSON.stringify(this._tasks, null, 2), 'utf8');
      this._dirty = false;
    } catch (err) {
      console.warn('[TaskMemory] Error guardando:', err.message);
    }
  }

  createTask(userId, { title, intent, documents = [], tools = [], context = '' }) {
    this._ensureLoaded();
    const task = {
      id: `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      userId,
      title: title || 'Tarea',
      intent: intent || 'conversation',
      status: 'active',
      documents,
      tools,
      contextSummary: context.substring(0, 500),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
      turnCount: 1,
    };
    this._tasks.push(task);
    this._prune(userId);
    this._scheduleSave();
    return task;
  }

  getActiveTask(userId) {
    this._ensureLoaded();
    return this._tasks
      .filter(t => t.userId === userId && t.status === 'active')
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
  }

  getRecentTasks(userId, limit = 5) {
    this._ensureLoaded();
    return this._tasks
      .filter(t => t.userId === userId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  getLastCompletedTask(userId) {
    this._ensureLoaded();
    return this._tasks
      .filter(t => t.userId === userId && t.status === 'completed')
      .sort((a, b) => b.completedAt - a.completedAt)[0] || null;
  }

  updateTask(taskId, updates) {
    this._ensureLoaded();
    const task = this._tasks.find(t => t.id === taskId);
    if (!task) return null;
    Object.assign(task, updates, { updatedAt: Date.now() });
    if (updates.status === 'completed') task.completedAt = Date.now();
    if (updates.status === 'active') task.completedAt = null;
    task.turnCount = (task.turnCount || 0) + 1;
    this._scheduleSave();
    return task;
  }

  completeTask(taskId, summary = '') {
    return this.updateTask(taskId, { status: 'completed', contextSummary: summary.substring(0, 500) });
  }

  findTasksByDocument(userId, docId) {
    this._ensureLoaded();
    return this._tasks.filter(t => t.userId === userId && t.documents.includes(docId));
  }

  resumeLast(userId) {
    const last = this.getLastCompletedTask(userId);
    if (last) {
      this.updateTask(last.id, { status: 'active' });
      return last;
    }
    return null;
  }

  searchTasks(userId, query) {
    this._ensureLoaded();
    const q = query.toLowerCase();
    return this._tasks.filter(t =>
      t.userId === userId &&
      (t.title.toLowerCase().includes(q) || t.contextSummary.toLowerCase().includes(q))
    ).slice(0, 5);
  }

  _prune(userId) {
    const userTasks = this._tasks.filter(t => t.userId === userId);
    if (userTasks.length > MAX_TASKS_PER_USER) {
      const toRemove = userTasks
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(0, userTasks.length - MAX_TASKS_PER_USER);
      const removeIds = new Set(toRemove.map(t => t.id));
      this._tasks = this._tasks.filter(t => !removeIds.has(t.id));
    }
  }

  formatForLLM(userId) {
    this._ensureLoaded();
    const active = this.getActiveTask(userId);
    const recent = this.getRecentTasks(userId, 3);

    const parts = [];
    if (active) {
      parts.push(`[TAREA ACTIVA]\n• ${active.title} (${active.intent}) — ${active.turnCount} turnos`);
      if (active.contextSummary) parts.push(`  Contexto: ${active.contextSummary}`);
      if (active.documents.length > 0) parts.push(`  Documentos: ${active.documents.length}`);
    }
    if (recent.length > 0) {
      parts.push('[TAREAS RECIENTES]');
      recent.forEach(t => {
        const status = t.status === 'active' ? '🔄' : t.status === 'completed' ? '✅' : '⏸️';
        parts.push(`${status} ${t.title} — ${new Date(t.updatedAt).toLocaleDateString()}`);
      });
    }

    return parts.join('\n');
  }

  getStats() {
    this._ensureLoaded();
    return {
      total: this._tasks.length,
      active: this._tasks.filter(t => t.status === 'active').length,
      completed: this._tasks.filter(t => t.status === 'completed').length,
      paused: this._tasks.filter(t => t.status === 'paused').length,
    };
  }
}

module.exports = new TaskMemory();
