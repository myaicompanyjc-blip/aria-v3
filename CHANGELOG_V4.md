# ARIA v4.0 — Changelog de Mejoras

## Resumen Ejecutivo

Implementación completa de las mejoras identificadas en la auditoría técnica.
ARIA pasa de v3.1 (inteligencia superficial) a v4.0 (sistema cognitivo persistente).

---

## 🆕 Módulos Nuevos

### `core/cognitive-router/cognitive_router.js`
**Problema resuelto:** El Planner decidía el intent pero no la ESTRATEGIA de procesamiento.

El CognitiveRouter detecta automáticamente el pipeline óptimo para cada pregunta:
- `doc_summary` → resumir documento completo
- `doc_exact_query` → buscar dato exacto con cita obligatoria
- `doc_multi_hop` → pregunta que requiere múltiples búsquedas encadenadas
- `doc_compare` → comparar secciones/documentos
- `doc_extract` → extraer lista/tabla estructurada
- `web_research` → investigación multi-fuente
- `strategic_planning` → crear estrategia con memoria + web
- `data_analysis` → analizar números/tablas
- `memory_recall` → recordar conversaciones anteriores

**Ejemplo:**
```
"¿Qué dice el contrato sobre incumplimiento y penalizaciones?"
→ Detecta: doc_multi_hop
→ Ejecuta: 3 búsquedas encadenadas (incumplimiento → cláusulas relacionadas → penalizaciones)
→ Resultado: contexto completo de todas las secciones relevantes
```

---

### `core/memory-consolidation/consolidation_engine.js`
**Problema resuelto:** ARIA "recordaba" cosas pero no "aprendía" patrones.

El motor de consolidación:
- Analiza conversaciones acumuladas y extrae patrones cognitivos
- Construye perfiles de usuario: rol, industria, objetivos, estilo comunicativo
- Genera "insights" semánticos reutilizables
- Corre en background cada 10 conversaciones (no bloquea respuestas)
- Persiste en `data/cognitive_profiles.json` y `data/user_insights.json`

**Ejemplo de perfil generado:**
```json
{
  "role": "Gerente Comercial B2B",
  "industry": "Software empresarial",
  "objectives": ["automatización de ventas", "captación de clientes"],
  "communicationStyle": "técnico",
  "prefersTechnical": true,
  "topTopics": ["contratos", "estrategia comercial", "reportes"]
}
```

---

### `core/knowledge-graph/knowledge_graph.js`
**Problema resuelto:** Memoria lineal sin inferencia ni conexiones entre entidades.

Grafo de conocimiento empresarial que conecta:
```
Cliente A ↔ Contrato B ↔ Empresa C ↔ Factura D ↔ Riesgo Legal
```

Capacidades:
- Extracción automática de entidades via LLM (personas, empresas, contratos, facturas, etc.)
- Relaciones tipadas (firmó, tiene, aplica_penalización, vence_el, etc.)
- Búsqueda en el grafo por query
- Contexto del grafo inyectado al LLM automáticamente
- Persiste en `data/knowledge_graph.json`
- **Upgrade path:** Reemplazar con Neo4j/FalkorDB sin cambiar API pública

---

### `core/anti-hallucination/citation_enforcement.js`
**Problema resuelto:** El Critic detectaba alucinaciones post-hoc pero no las prevenía.

Citation-First Reasoning:
- Cuando hay chunks de documentos, el LLM **cita mientras responde** (no después)
- Cada afirmación referencia su fragmento: `[F1]`, `[F2]`, etc.
- Las referencias se expanden a citas reales: `[Contrato Marco, p.15]`
- Si algo no está en el documento, lo declara explícitamente
- Validación post-generación disponible (`validateResponse`)

---

## 🔧 Módulos Mejorados

### `core/aria_brain.js` → v4.0
- Integra CognitiveRouter después del Planner
- Inyecta perfil cognitivo y contexto del grafo al contexto del LLM
- Ejecuta KnowledgeGraph + ConsolidationEngine en background (sin bloquear respuesta)
- Pasa routing al CEO Agent y al Reasoning Engine

### `core/reasoning/reasoning_engine.js` → v4.0
- **Citation-First Reasoning:** cuando hay chunks + intent doc_query, usa CitationEnforcementEngine en lugar del Reasoner estándar
- **Self-Consistency Check:** para respuestas de alto riesgo, genera 2 drafts y elige el más conservador
- **Structured Output:** cuando el pipeline requiere tabla/lista, usa prompt especializado
- Pasa `routing` al Reasoner para adaptar la estrategia

### `core/agents/ceo_agent.js` → v4.0
- **Routing-aware:** recibe routing del CognitiveRouter y ajusta ejecución
- **Multi-hop execution:** para pipelines `doc_multi_hop`, ejecuta retrieval encadenado
- **Timeout individual por agente:** si un agente tarda >15s, continúa sin él
- **Context deduplication:** elimina fragmentos duplicados antes de pasar al Reasoner
- Expone `rawChunks` al ReasoningEngine para Citation Engine

### `core/agents/document_agent.js` → v4.0
- `queryWithChunks()`: acepta chunks pre-recuperados del multi-hop
- **Smart preview:** reemplaza `doc.text.substring(0, 6000)` con búsqueda real por páginas relevantes
- Expone `rawChunks` en el resultado

### `core/observability/observability.js` → v4.0
- Pipeline tracking por request
- RAG hit rate diario
- Hallucination log persistente (`data/hallucination_log.jsonl`)
- Latency breakdown por fase
- `buildHealthReport()`: genera reporte de salud para el admin

---

## 🚫 Bugs Críticos Corregidos

### 1. `context_builder.js` — substring de 8000 chars
**Antes:**
```js
const preview = doc.text.substring(0, 8000); // ❌ MALO
```
**Ahora:**
El DocumentAgent v4.0 usa `_buildSmartPreview()` que busca páginas relevantes con keyword scoring en lugar de cortar el texto crudo.

### 2. Memoria que "recordaba pero no aprendía"
**Antes:** Solo EpisodicMemory (guarda eventos) y SemanticMemory (guarda hechos).
**Ahora:** ConsolidationEngine genera perfiles cognitivos abstractos que persisten entre sesiones.

### 3. Sin multi-hop retrieval
**Antes:** 1 búsqueda → respuesta.
**Ahora:** CognitiveRouter detecta preguntas multi-hop y ejecuta hasta 3 búsquedas encadenadas.

### 4. Alucinaciones detectadas post-hoc
**Antes:** Critic detecta después de generar.
**Ahora:** CitationEnforcementEngine previene durante la generación (Citation-First).

### 5. Sin conocimiento de relaciones entre entidades
**Antes:** Cada conversación era independiente.
**Ahora:** KnowledgeGraph conecta entidades y provee contexto de relaciones.

---

## 📋 Lo que aún se puede mejorar (Roadmap futuro)

| Mejora | Prioridad | Descripción |
|--------|-----------|-------------|
| Neo4j/FalkorDB | Alta | Reemplazar JSON graph con grafo real para datasets grandes |
| Embedding premium (jina-v3/bge-m3) | Alta | Mejor precisión semántica en RAG |
| Browser Agent | Media | Búsqueda web con acceso a contenido real de páginas |
| Tool use (código, spreadsheets) | Media | Ejecutar código Python para análisis de datos |
| Multi-model routing | Media | Usar Claude para síntesis, DeepSeek para análisis, etc. |
| Temporal weighting en RAG | Baja | Priorizar documentos más recientes automáticamente |
| A/B testing de prompts | Baja | Comparar versiones de prompts automáticamente |
| Streaming responses | Baja | Enviar respuesta por partes en WhatsApp |

---

## 📊 Evaluación Post-Mejoras (estimada)

| Dimensión | v3.1 | v4.0 |
|-----------|------|------|
| Arquitectura | 8.5/10 | 9.0/10 |
| Inteligencia real | 5.5/10 | 7.5/10 |
| RAG | 4.5/10 | 7.0/10 |
| Memoria | 6.0/10 | 8.0/10 |
| Anti-alucinación | 5.0/10 | 7.5/10 |
| Escalabilidad | 7.5/10 | 8.0/10 |
| Nivel enterprise | 6.0/10 | 8.0/10 |

---

## 🗂 Estructura de Archivos Nuevos

```
aria-v3/
├── core/
│   ├── cognitive-router/
│   │   └── cognitive_router.js      ← NUEVO
│   ├── memory-consolidation/
│   │   └── consolidation_engine.js  ← NUEVO
│   ├── knowledge-graph/
│   │   └── knowledge_graph.js       ← NUEVO
│   ├── anti-hallucination/
│   │   └── citation_enforcement.js  ← NUEVO
│   ├── aria_brain.js                ← MEJORADO v4.0
│   ├── reasoning/
│   │   └── reasoning_engine.js      ← MEJORADO v4.0
│   ├── agents/
│   │   ├── ceo_agent.js             ← MEJORADO v4.0
│   │   └── document_agent.js        ← MEJORADO v4.0
│   └── observability/
│       └── observability.js         ← MEJORADO v4.0
└── data/
    ├── cognitive_profiles.json      ← NUEVO (auto-generado)
    ├── user_insights.json           ← NUEVO (auto-generado)
    ├── knowledge_graph.json         ← NUEVO (auto-generado)
    ├── metrics.jsonl                ← NUEVO (auto-generado)
    └── hallucination_log.jsonl      ← NUEVO (auto-generado)
```
