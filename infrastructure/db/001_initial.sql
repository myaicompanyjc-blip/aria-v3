-- ============================================================
-- ARIA v3 — PostgreSQL Schema
-- BRECHA 10 RESUELTA: Base de datos real (reemplaza JSON en disco)
--
-- Ejecutar con:
--   psql -U postgres -d aria_v3 -f 001_initial.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- Para búsqueda de texto

-- ── USERS ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone       TEXT UNIQUE NOT NULL,
  name        TEXT,
  company     TEXT,
  role        TEXT,
  city        TEXT,
  email       TEXT,
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);

-- ── SESSIONS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  current_task    TEXT,
  current_intent  TEXT,
  active_doc_id   UUID,
  active_tools    TEXT[] DEFAULT '{}',
  started_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW(),
  expires_at      TIMESTAMP DEFAULT (NOW() + INTERVAL '30 minutes')
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ── DOCUMENTS ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID REFERENCES users(id) ON DELETE CASCADE,
  filename          TEXT NOT NULL,
  original_filename TEXT,
  file_type         TEXT,              -- pdf, docx, xlsx, pptx
  qdrant_collection TEXT,             -- Colección en Qdrant (para upgrade)
  total_pages       INTEGER,
  total_chars       INTEGER,
  title             TEXT,
  is_indexed        BOOLEAN DEFAULT FALSE,
  uploaded_at       TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_indexed ON documents(is_indexed);

-- ── MEMORIES (Capas 2 y 3: Episodic + Semantic) ──────────────────────────────
CREATE TABLE IF NOT EXISTS memories (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  memory_type     TEXT NOT NULL CHECK (memory_type IN ('episodic', 'semantic', 'skill')),
  content         TEXT NOT NULL,
  importance_score FLOAT DEFAULT 0.5 CHECK (importance_score BETWEEN 0 AND 1),
  metadata        JSONB DEFAULT '{}',
  -- Para upgrade: embedding vectorial (Qdrant lo maneja, aquí solo metadata)
  qdrant_id       TEXT,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memories_user_type ON memories(user_id, memory_type);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance_score DESC);
CREATE INDEX IF NOT EXISTS idx_memories_content_trgm ON memories USING gin(content gin_trgm_ops);

-- ── CONVERSATION HISTORY ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversation_turns (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  session_id      UUID REFERENCES sessions(id) ON DELETE SET NULL,
  user_message    TEXT,
  assistant_message TEXT,
  intent          TEXT,
  reasoning_strategy TEXT,
  processing_ms   INTEGER,
  had_hallucination BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_turns_user ON conversation_turns(user_id);
CREATE INDEX IF NOT EXISTS idx_turns_session ON conversation_turns(session_id);
CREATE INDEX IF NOT EXISTS idx_turns_created ON conversation_turns(created_at DESC);

-- ── USER FACTS (Capa 3: Semantic Memory — hechos del usuario) ────────────────
CREATE TABLE IF NOT EXISTS user_facts (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  fact_key    TEXT NOT NULL,
  fact_value  TEXT NOT NULL,
  confidence  FLOAT DEFAULT 0.8,
  updated_at  TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, fact_key)
);

CREATE INDEX IF NOT EXISTS idx_facts_user ON user_facts(user_id);

-- ── SKILL MEMORY (Capa 5) ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_preferences (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  pref_key    TEXT NOT NULL,
  pref_value  TEXT NOT NULL,
  updated_at  TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, pref_key)
);

-- ── OBSERVABILITY: Request logs ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS request_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID,
  phone           TEXT,
  message_type    TEXT,  -- text, audio, image, document
  intent          TEXT,
  reasoning_chain TEXT[], -- ['reasoner', 'reflector', 'critic', 'synthesizer']
  processing_ms   INTEGER,
  llm_tokens      INTEGER,
  rag_chunks_used INTEGER DEFAULT 0,
  error           TEXT,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_logs_created ON request_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_phone ON request_logs(phone);

-- ── TRIGGERS: updated_at automático ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['users', 'sessions', 'user_facts', 'user_preferences']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION update_updated_at()',
      tbl, tbl
    );
  END LOOP;
EXCEPTION WHEN duplicate_object THEN NULL; -- Ignorar si ya existen
END $$;

-- ── VISTAS ÚTILES ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW active_sessions AS
  SELECT s.*, u.phone, u.name
  FROM sessions s
  JOIN users u ON s.user_id = u.id
  WHERE s.expires_at > NOW();

CREATE OR REPLACE VIEW user_memory_summary AS
  SELECT
    u.phone,
    u.name,
    COUNT(DISTINCT m.id) FILTER (WHERE m.memory_type = 'episodic') AS episodic_count,
    COUNT(DISTINCT m.id) FILTER (WHERE m.memory_type = 'semantic') AS semantic_count,
    COUNT(DISTINCT d.id) AS document_count,
    MAX(ct.created_at) AS last_interaction
  FROM users u
  LEFT JOIN memories m ON m.user_id = u.id
  LEFT JOIN documents d ON d.user_id = u.id
  LEFT JOIN conversation_turns ct ON ct.user_id = u.id
  GROUP BY u.id, u.phone, u.name;

-- ── COMENTARIOS DE UPGRADE PATH ──────────────────────────────────────────────
COMMENT ON TABLE documents IS
  'UPGRADE: Cuando Qdrant esté disponible, qdrant_collection apunta a la colección de chunks vectorizados';
COMMENT ON TABLE memories IS
  'UPGRADE: qdrant_id referencia el vector en Qdrant para búsqueda semántica real';
COMMENT ON TABLE request_logs IS
  'OBSERVABILIDAD: Base para métricas Prometheus + Grafana';
