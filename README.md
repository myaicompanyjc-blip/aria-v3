# 🤖 ARIA v3.0 — Agente de Razonamiento Inteligente Anhermer
> Bot de WhatsApp inteligente con LM Studio (Qwen3-30B) + capacidades multimedia

## 🖥️ Entorno de Ejecución
- **Hardware:** Mac Studio 36GB RAM
- **Modelo principal:** `qwen3-30b-a3b` via LM Studio (`http://localhost:1234/v1`)
- **Fallback:** OpenRouter (configurable)
- **Runtime:** Node.js 18+

## 🚀 Instalación rápida

```bash
cd ~/Desktop/aria-v3
npm install
cp .env.example .env
# Edita .env con tus credenciales
npm start
```

## 📁 Estructura del proyecto

```
aria-v3/
├── agent.js                    # Punto de entrada — arranca WhatsApp + servicios
├── core/
│   ├── aria_brain.js           # Cerebro central — decide qué hacer con cada mensaje
│   ├── context_builder.js      # Construye el prompt/contexto para el LLM
│   ├── intent_classifier.js    # Clasifica intención del mensaje (conversación, doc, imagen, etc.)
│   └── session_manager.js      # Maneja sesiones y contexto por usuario
├── agents/
│   ├── audio_transcriber.js    # Whisper: audio → texto
│   ├── audio_response.js       # Edge-TTS: texto → audio
│   ├── image_generator.js      # Google Flow / Playwright: genera imágenes
│   └── prompt_enhancer.js      # Mejora prompts de imagen con el LLM
├── memory/
│   ├── conversation_memory.js  # Historial de conversación por usuario (Redis + fallback JSON)
│   ├── document_store.js       # Almacena y busca en documentos indexados por usuario
│   ├── user_facts.js           # Hechos del usuario (nombre, empresa, preferencias)
│   └── context_manager.js      # Gestiona el contexto activo de cada usuario
├── services/
│   ├── document_processor.js   # Lee COMPLETO: PDF, DOCX, XLSX, PPTX con paginación
│   ├── document_builder.js     # Genera PDF/DOCX/XLSX visualmente ricos
│   ├── web_search.js           # Búsqueda web con múltiples fuentes
│   ├── crm_manager.js          # Gestión de clientes
│   └── ocr_service.js          # OCR con Tesseract
├── lib/
│   ├── llm_client.js           # Cliente LM Studio con retry, timeout, streaming
│   └── whatsapp_sender.js      # Envío de mensajes, archivos, audios
├── prompts/
│   └── aria_system.md          # Prompt del sistema de ARIA
└── skills/                     # Skills de Anhermer (cargados automáticamente)
    ├── anhermer-docs/
    ├── anhermer-audit/
    ├── anhermer-reports/
    └── anhermer-budget/
```

## 🔑 Variables de entorno requeridas (.env)

```
LM_STUDIO_BASE_URL=http://localhost:1234/v1
LM_STUDIO_MODEL=qwen3-30b-a3b
EDGE_TTS_VOICE=es-CO-SalomeNeural
```

Opcionales (para funciones extra):
```
OPENROUTER_API_KEY=...          # Fallback si LM Studio está caído
SUPABASE_URL=...                # Memoria persistente en la nube
SUPABASE_ANON_KEY=...
REDIS_URL=redis://localhost:6379
```

## 🐛 Bugs del ARIA v2 solucionados

| Bug | Causa raíz | Solución en v3 |
|-----|-----------|----------------|
| Lee solo 2 págs de PDF | `maxContextChars=25000` cortaba antes | Procesador por chunks con índice completo en memoria |
| Se congela | Timeout 60s sin retry | Timeout 30s + 2 retries + fallback |
| Contexto no se limpia | `currentDoc` no expira | Contexto expira tras 30 min de inactividad |
| Documentos feos | PDFKit sin plantilla | Templates HTML→PDF con diseño profesional |
| Fuentes superpuestas | Sin layout system | Sistema de grid con márgenes y tipografía |
| No recuerda entre sesiones | Redis solo, sin fallback | JSON local + Redis + Supabase (fallback en cascada) |
| No investiga bien | Búsqueda en DuckDuckGo básica | Multi-fuente: Brave + DuckDuckGo + scraping |

## 📱 Capacidades de ARIA v3

### ✅ Lo que funciona perfecto (conservado del v2)
- Transcripción de audio → texto (Whisper)
- Texto → audio (Edge-TTS, voz colombiana)
- Generación de imágenes (Playwright + Google Flow)
- WhatsApp (Baileys)

### 🆕 Mejorado en v3
- **Lectura de documentos COMPLETA**: indexa todas las páginas, responde preguntas específicas por página
- **Memoria por usuario**: persiste entre reinicios, no hay fuga de contexto entre usuarios
- **Generación de documentos**: plantillas HTML→PDF visualmente profesionales, sin fuentes superpuestas
- **Razonamiento**: prompt del sistema mejorado para pensar antes de responder
- **Búsqueda web**: multi-fuente con síntesis inteligente

## 🛠️ Comandos disponibles

Todos funcionan en lenguaje natural. También existen atajos con `!`:

```
!pdf [descripción]       → PDF profesional
!docx [descripción]      → Word editable  
!excel [descripción]     → Hoja de cálculo
!imagen [descripción]    → Imagen con IA
!buscar [consulta]       → Búsqueda web
!voz [texto]             → Audio de voz
!vozauto on/off          → Modo voz automático
!doc [pregunta]          → Pregunta sobre documento cargado
!help                    → Ayuda
```

## 🔄 Cómo funciona la lectura de documentos

1. Usuario envía PDF de 40 páginas
2. `document_processor.js` extrae TODAS las páginas con marcadores `[PÁGINA N]`
3. El texto completo se guarda en `document_store.js` indexado por usuario
4. Cuando el usuario pregunta "¿qué dice la página 38?", el sistema:
   - Extrae el fragmento exacto de esa página del índice
   - Lo inyecta en el contexto del LLM
   - Responde con información precisa

## 📊 Dashboard

```bash
npm run dashboard
# Abre http://localhost:3001
```
