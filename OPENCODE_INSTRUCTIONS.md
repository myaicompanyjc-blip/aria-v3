# ARIA v4.0 — OPENCODE INSTRUCTIONS
## Estado: v3.1 → v4.0 actualizado (CognitiveRouter + KnowledgeGraph + Consolidation + Citation Enforcement)

---

## ESTRUCTURA DEL PROYECTO

```
aria-v3/
├── agent.js                         ← Entry point WhatsApp (Baileys)
├── CHANGELOG_V4.md                  ← Documentación de mejoras v4.0
├── package.json                     ← Workspace monorepo (workspaces: packages/*, apps/*)
├── turbo.json                       ← Turborepo build pipeline
├── tsconfig.base.json               ← TypeScript strict base config
├── packages/
│   └── shared/                      ← @aria/shared — tipos y utils TypeScript
│       ├── src/
│       │   ├── index.ts             ← Barrel (re-exports types + utils)
│       │   ├── types/index.ts       ← Session, PlannerOutput, ReasoningResult, etc.
│       │   └── utils/index.ts       ← estimateTokens, withRetry, formatMs, etc.
│       ├── package.json
│       └── tsconfig.json
├── core/
│   ├── aria_brain.js                ← Orquestador principal (v4.0)
│   ├── cognitive-router/
│   │   └── cognitive_router.js      ← NUEVO v4.0: pipeline routing inteligente
│   ├── memory-consolidation/
│   │   └── consolidation_engine.js  ← NUEVO v4.0: perfiles cognitivos
│   ├── knowledge-graph/
│   │   └── knowledge_graph.js       ← NUEVO v4.0: grafo empresarial
│   ├── anti-hallucination/
│   │   └── citation_enforcement.js  ← NUEVO v4.0: Citation-First Reasoning
│   ├── planner/
│   │   └── planner_engine.js        ← Planning + intent LLM
│   ├── reasoning/
│   │   └── reasoning_engine.js      ← v4.0: Citation-First + Self-Consistency
│   ├── memory-layers/
│   │   └── memory_system.js         ← Memory 5 capas (PostgreSQL + JSON fallback)
│   ├── session/
│   │   └── session_engine.js        ← Sesiones Redis + schema completo
│   ├── agents/
│   │   ├── ceo_agent.js             ← v4.0: routing-aware, multi-hop, dedup, timeouts
│   │   ├── research_agent.js        ← Web search + síntesis
│   │   └── document_agent.js        ← v4.0: smart preview, queryWithChunks
│   ├── observability/
│   │   └── observability.js         ← v4.0: pipeline tracking, RAG metrics, health report
│   ├── context_builder.js           ← Igual
│   ├── confidence_scorer.js         ← Igual
│   └── intent_classifier.js         ← Igual
├── apps/
│   ├── api/src/
│   │   └── index.js                 ← Fastify API Gateway + Zod + rate limit
│   └── workers/src/
│       ├── index.js
│       ├── research_worker.js       ← BullMQ worker búsqueda web
│       └── document_worker.js       ← BullMQ worker RAG
├── services/
│   ├── rag/
│   │   ├── rag_system.js            ← RAG + SemanticChunker + BM25 + Qdrant real
│   │   ├── embedding_service.js     ← LM Studio embeddings
│   │   ├── lexical_search.js        ← BM25 inverted index
│   │   └── reranker.js              ← LLM-based + heuristic fallback
│   ├── ocr/
│   │   ├── ocr_pipeline.js          ← PaddleOCR primario + Tesseract fallback
│   │   ├── paddle_server.py         ← Microservicio Python FastAPI
│   │   ├── Dockerfile
│   │   └── requirements.txt
│   ├── document_processor.js
│   ├── document_builder.js
│   ├── crm_manager.js
│   ├── ocr_service.js
│   └── web_search.js
├── infrastructure/
│   ├── db/
│   │   ├── 001_initial.sql          ← Schema PostgreSQL completo
│   │   └── migrate.js               ← Runner: node infrastructure/db/migrate.js
│   └── docker/
│       └── docker-compose.yml       ← Qdrant + Redis + Postgres + OCR
├── agents/                          ← Audio, imagen (STT/TTS/Image gen)
├── lib/                             ← LLM client, WhatsApp sender, message extractor
├── prompts/aria_system.md
├── skills/                          ← 4 skills Anhermer (audit, budget, docs, reports)
└── .env.example
```

---

## FLUJO COMPLETO DE UN MENSAJE v4.0

```
WhatsApp mensaje
    ↓
agent.js (Baileys listener)
    ↓
AriaBrain.process(userId, message)
    ↓
SessionEngine.getOrCreate(userId)       → Redis (fallback: Map local)
    ↓
PlannerEngine.plan(text, context)       → LLM → PlannerOutput JSON
    ↓
CognitiveRouter.route(text, plan)       ← NUEVO v4.0
    │  detecta pipeline óptimo (doc_summary, doc_multi_hop, etc.)
    ↓
KnowledgeGraph.buildGraphContext()      ← NUEVO v4.0
    │  contexto de entidades relacionadas
    ↓
ConsolidationEngine.buildProfileContext() ← NUEVO v4.0
    │  perfil cognitivo del usuario
    ↓
CEOAgent.orchestrate(userId, msg, plan, { routing })
    ├── DocumentAgent.query()           → RAGSystem (Qdrant o JSON fallback)
    │   └── multi-hop si routing lo requiere
    └── ResearchAgent.research()        → Web search
    (paralelo con timeouts individuales + dedup)
    ↓
ReasoningEngine.reason(plan, context, { routing, chunks, citations })
    ├── Citation-First (si hay chunks)  ← NUEVO v4.0
    ├── Reasoner: borrador inicial
    ├── Reflector + Critic (paralelo)
    ├── Self-Consistency Check          ← NUEVO v4.0
    └── Synthesizer: respuesta final
    ↓
[BACKGROUND] KnowledgeGraph.extractAndAdd()   ← NUEVO v4.0
[BACKGROUND] ConsolidationEngine.onConversation()  ← NUEVO v4.0
    ↓
SessionEngine.addToShortTermMemory()
    ↓
MemorySystem.addEpisodic()              → PostgreSQL (fallback: JSON)
    ↓
Observability.requestEnd()              → pipeline tracking + RAG metrics
    ↓
RESPUESTA al usuario
```

---

## MÓDULOS NUEVOS v4.0

| Módulo | Archivo | Función |
|--------|---------|---------|
| CognitiveRouter | core/cognitive-router/cognitive_router.js | Pipeline routing: 12 tipos (doc_summary, doc_multi_hop, doc_compare, doc_extract, web_research, strategic, data_analysis, etc.) |
| ConsolidationEngine | core/memory-consolidation/consolidation_engine.js | Perfiles cognitivos de usuarios cada 10 conversaciones, persiste en data/ |
| KnowledgeGraph | core/knowledge-graph/knowledge_graph.js | Grafo empresarial con 13 tipos de entidad, 10 tipos de relación, extracción LLM automática |
| CitationEnforcement | core/anti-hallucination/citation_enforcement.js | Citation-First Reasoning con trazabilidad de fuentes |

## MÓDULOS MEJORADOS v4.0

| Módulo | Mejoras clave |
|--------|---------------|
| aria_brain.js | Nuevo flujo: Planner → CognitiveRouter → KnowledgeGraph → Consolidation → CEO → Reasoning |
| ceo_agent.js | Routing-aware, multi-hop execution, timeouts 15s/agente, deduplicación de contexto |
| document_agent.js | queryWithChunks(), smart preview por páginas (keyword scoring), rawChunks expuestos |
| reasoning_engine.js | Citation-First, Self-Consistency Check (2 drafts), Structured Output, Uncertainty Quantification |
| observability.js | Pipeline tracking, RAG hit rate, hallucination log, buildHealthReport() |

---

## CÓMO ARRANCAR

### 1. Infraestructura (Docker)
```bash
cd infrastructure/docker
docker compose up -d
# Levanta: Qdrant:6333, Redis:6379, Postgres:5432
```

### 2. Variables de entorno
```bash
cp .env.example .env
# Editar: LM_STUDIO_URL, POSTGRES_URL, REDIS_URL, QDRANT_URL, etc.
```

### 3. Base de datos
```bash
npm install
node infrastructure/db/migrate.js
```

### 4. WhatsApp bot
```bash
node agent.js
# Escanear QR con WhatsApp
```

### 5. API REST (opcional)
```bash
node apps/api/src/index.js
# http://localhost:3001
```

### 6. Workers BullMQ (requiere Redis)
```bash
node apps/workers/src/index.js
```

### 7. OCR server Python (requiere paddlepaddle)
```bash
cd services/ocr
pip install -r requirements.txt
python paddle_server.py
# http://localhost:8001
```

### 8. Compilar @aria/shared (TypeScript)
```bash
cd packages/shared
npm install
npm run build
# Genera dist/ con tipos .d.ts para IDEs
```

---

## COMPORTAMIENTO SIN INFRAESTRUCTURA

El sistema está diseñado para arrancar sin Redis, PostgreSQL ni Qdrant.
Cada capa tiene fallback automático:

| Servicio | Con infra | Sin infra |
|----------|-----------|-----------|
| Redis | SessionEngine persiste en Redis | Map en memoria |
| PostgreSQL | EpisodicMemory en tabla memories | JSON en data/ |
| Qdrant | VectorStore en Qdrant | JSON en data/vectors.json |
| Qdrant | RAGSystem busca en Qdrant | JSON cosine similarity |
| LangSmith | Tracing completo | Solo logs |
| PaddleOCR | OCR de alta calidad | Tesseract fallback |

---

## API ENDPOINTS

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | /health | Health check |
| GET | /metrics | Métricas de observabilidad |
| POST | /chat | Enviar mensaje de texto |
| POST | /voice | Enviar audio base64 |
| POST | /document/upload | Subir documento |
| GET | /session/:userId | Obtener sesión activa |
| DELETE | /session/:userId | Resetear sesión |

```bash
curl -X POST http://localhost:3001/chat \
  -H "Content-Type: application/json" \
  -d '{"userId": "573001234567", "message": "¿Qué dice el contrato sobre penalidades?"}'
```

---

## ROADMAP PRIORIZADO v5.0

Basado en auditoría técnica post-v4.0. En orden de impacto:

### PRIORIDAD 1 — RAG Enterprise
- Migrar embeddings a **jina-embeddings-v3** o **bge-m3**
- Reemplazar reranker LLM por **bge-reranker-v2-m3** o **jina-reranker-v2**
- Qdrant como store obligatorio (eliminar fallback JSON)

### PRIORIDAD 2 — Context Compression Engine
- Compress context antes de enviar al LLM
- Resumir chunks, eliminar redundancia, fusionar contexto, priorizar señales

### PRIORIDAD 3 — Recursive Multi-Hop Retrieval
- Query decomposition en sub-preguntas
- Retrieval chains con sub-question generation
- Síntesis multi-paso

### PRIORIDAD 4 — Self-Consistency + Verifier
- Reemplazar prompts de razonamiento por verificación real
- Contradiction detection, answer ranking, uncertainty modeling

### PRIORIDAD 5 — Tool System Real
- Browser agent, Excel, CRM, correo, ERP
- Operador empresarial, no solo chatbot

### PRIORIDAD 6 — Enterprise PDF Parsing
- Docling, MinerU, Nougat, Unstructured
- Tablas, layouts, scans, firmas, diagramas

### PRIORIDAD 7 — Knowledge Graph Upgrade
- Migrar de JSON a Neo4j/Memgraph/FalkorDB

### PRIORIDAD 8 — Evaluación Automática
- Retrieval accuracy, hallucination rate, groundedness
- Answer quality, latency, token cost, chunk hit rate

---

## EVALUACIÓN POST-v4.0

| Dimensión | v3.1 | v4.0 | Objetivo v5.0 |
|-----------|------|------|---------------|
| Arquitectura | 8.5 | 9.0 | 9.5 |
| Inteligencia real | 5.5 | 7.5 | 8.5 |
| RAG | 4.5 | 7.0 | 8.5 |
| Memoria | 6.0 | 8.0 | 9.0 |
| Anti-alucinación | 5.0 | 7.5 | 8.5 |
| Escalabilidad | 7.5 | 8.0 | 9.0 |
| Enterprise readiness | 6.0 | 8.0 | 9.0 |
