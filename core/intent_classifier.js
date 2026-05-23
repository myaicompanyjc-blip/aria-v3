/**
 * IntentClassifier — Detecta la intención del usuario
 * Limpio, sin los 50 if/else de aria_ceo.js v2
 */

const INTENTS = [
  // Generación de imagen
  {
    id: 'image_generate',
    patterns: [
      /(?:genera|crea|haz|dame|quiero|necesito)\s+(?:una?\s+)?(?:imagen|foto|ilustraci[oó]n|dibujo|fotograf[ií]a)/i,
      /(?:imagen|foto|ilustraci[oó]n)\s+(?:de|del|con|sobre)\s+/i,
      /^(?:haz|crea|genera)\s+un\s+(?:logo|banner|poster|afiche)/i,
    ]
  },
  // Análisis de imagen recibida
  {
    id: 'image_analyze',
    patterns: [
      /(?:analiza|describe|qu[eé]\s+(?:dice|hay|ves|muestra|aparece)|lee|leer|descr[ií]beme?)\s*(?:la\s+)?(?:imagen|foto|imágen|this)/i,
      /(?:qué\s+contiene|qué\s+tiene)\s+(?:la\s+)?(?:imagen|foto)/i,
      /^(?:sí|ok|dale|bueno|claro|adelante|describe|analiza)$/i,
    ]
  },
  // Edición de imagen
  {
    id: 'image_edit',
    patterns: [
      /(?:edita|modifica|cambia|agrega|quita|pon|ponle|agrégale)\s+(?:la\s+)?(?:imagen|foto)/i,
      /(?:editar|modificar)\s+(?:con|el|la)\s+/i,
    ]
  },
  // Generación de documentos
  {
    id: 'doc_pdf',
    patterns: [
      /(?:genera|crea|haz|hazme|necesito|quiero)\s+(?:un\s+)?(?:pdf|documento\s+pdf)/i,
      /^!pdf\s+/i,
    ]
  },
  {
    id: 'doc_word',
    patterns: [
      /(?:genera|crea|haz|hazme|necesito|quiero)\s+(?:un\s+)?(?:word|docx|documento\s+(?:word|editable))/i,
      /^!docx\s+/i,
    ]
  },
  {
    id: 'doc_excel',
    patterns: [
      /(?:genera|crea|haz|hazme|necesito|quiero)\s+(?:un\s+)?(?:excel|hoja\s+de\s+c[aá]lculo|xlsx|tabla\s+excel)/i,
      /^!excel\s+/i,
    ]
  },
  // Consulta sobre documento cargado
  {
    id: 'doc_query',
    patterns: [
      /p[aá]gina\s*#?\d+/i,
      /qu[eé]\s+(?:dice|hay|tiene|contiene|menciona|habla)\s+(?:en|sobre|acerca)/i,
      /(?:busca|encuentra)\s+(?:en\s+el\s+)?(?:documento|pdf|archivo|texto)/i,
      /resumen\s+(?:del\s+)?(?:documento|pdf|archivo)/i,
      /de\s+qu[eé]\s+trata\s+(?:el\s+)?(?:documento|pdf)/i,
      /^!doc\s+/i,
    ]
  },
  // Búsqueda web
  {
    id: 'web_search',
    patterns: [
      /(?:busca|investiga|consulta|googlea)\s+(?:en\s+(?:internet|la\s+web|google)|sobre|acerca\s+de)\s+/i,
      /(?:busca|investiga)\s+(?:informaci[oó]n\s+(?:sobre|de|acerca))\s+/i,
      /noticias\s+(?:de|sobre)\s+/i,
      /(?:precio|cotizaci[oó]n)\s+(?:del?\s+)?(?:d[oó]lar|d[oó]lares|euro|bitcoin)/i,
      /clima\s+en\s+/i,
      /^!buscar\s+/i,
    ]
  },
  // Voz
  {
    id: 'voice_speak',
    patterns: [
      /(?:narra|lee\s+en\s+voz|di(?:me)?\s+con\s+voz|convierte\s+(?:a\s+)?audio|texto\s+a\s+voz)\s+/i,
      /(?:genera|crea)\s+(?:un\s+)?audio\s+(?:diciendo|con)\s+/i,
      /^!voz\s+/i,
    ]
  },
  {
    id: 'voice_toggle',
    patterns: [
      /^!vozauto\s+(on|off)$/i,
      /(?:activ|desactiv)\s+(?:la\s+)?voz\s+autom[aá]tica/i,
      /modo\s+voz\s+(on|off|activado|desactivado)/i,
    ]
  },
  // Recordatorio
  {
    id: 'reminder',
    patterns: [
      /(?:rec[uú]erdame?|pon\s+(?:un\s+)?recordatorio|avísame|alerta)\s+/i,
      /en\s+\d+\s+(?:minutos?|horas?|d[ií]as?)\s+/i,
      /^!recordatorio\s+/i,
    ]
  },
  // Comandos de ayuda
  {
    id: 'help',
    patterns: [
      /^!help$/i,
      /^(?:ayuda|help|qué\s+puedes\s+hacer|cómo\s+funciona|comandos?)$/i,
    ]
  },
  // Construcción (documentos especializados)
  {
    id: 'doc_construction',
    patterns: [
      /requisici[oó]n\s+(?:de\s+)?materiales?/i,
      /orden\s+de\s+compra/i,
      /certificado\s+de\s+obra/i,
      /acta\s+de\s+vecindad/i,
      /vale\s+de\s+caja/i,
      /informe\s+de\s+avance/i,
      /liquidaci[oó]n\s+de\s+obra/i,
      /^!(?:requisicion|oc|certificado|acta|valecaja|almacen|informe|liquidacion)\s+/i,
    ]
  },
  // Conversación general (catch-all)
  {
    id: 'conversation',
    patterns: []
  }
];

class IntentClassifier {
  /**
   * Clasifica la intención de un mensaje
   * @param {string} message
   * @returns {{id: string, confidence: number, match: any}}
   */
  classify(message) {
    if (!message || typeof message !== 'string') {
      return { id: 'conversation', confidence: 0.5, match: null };
    }

    const msg = message.trim();

    for (const intent of INTENTS) {
      if (intent.id === 'conversation') continue; // catch-all al final
      for (const pattern of intent.patterns) {
        const match = msg.match(pattern);
        if (match) {
          return { id: intent.id, confidence: 0.9, match };
        }
      }
    }

    return { id: 'conversation', confidence: 0.5, match: null };
  }

  /**
   * Extrae el contenido principal según la intención
   * Por ejemplo: "genera una imagen de un gato" → "un gato"
   */
  extractPayload(message, intentId) {
    const msg = message.trim();

    switch (intentId) {
      case 'image_generate':
        return msg
          .replace(/^(?:genera|crea|haz|dame|quiero|necesito)\s+(?:una?\s+)?(?:imagen|foto|ilustraci[oó]n|dibujo)\s+(?:de|del|con|sobre)?\s*/i, '')
          .replace(/^(?:haz|crea|genera)\s+/i, '')
          .trim() || msg;

      case 'doc_pdf':
      case 'doc_word':
      case 'doc_excel':
        return msg
          .replace(/^(?:genera|crea|haz|hazme|necesito|quiero)\s+(?:un\s+)?(?:pdf|word|docx|excel|hoja\s+de\s+c[aá]lculo|xlsx|documento[^:]*?)\s*/i, '')
          .replace(/^!(?:pdf|docx|excel)\s+/i, '')
          .trim() || msg;

      case 'doc_query':
        return msg.replace(/^!doc\s+/i, '').trim() || msg;

      case 'web_search':
        return msg
          .replace(/^(?:busca|investiga|consulta|googlea)\s+(?:en\s+(?:internet|la\s+web|google)\s+)?(?:sobre\s+|acerca\s+de\s+|informaci[oó]n\s+(?:sobre|de)\s+)?/i, '')
          .replace(/^!buscar\s+/i, '')
          .trim() || msg;

      case 'voice_speak':
        return msg
          .replace(/^(?:narra|di\s+con\s+voz|convierte\s+a\s+audio)\s+/i, '')
          .replace(/^!voz\s+/i, '')
          .trim() || msg;

      case 'reminder':
        return msg.replace(/^!recordatorio\s+/i, '').trim() || msg;

      default:
        return msg;
    }
  }

  /**
   * ¿Es un saludo simple sin contexto adicional?
   */
  isGreeting(message) {
    return /^(?:hola|buenas?|hey|hi|hello|buenos\s+días|buenas\s+tardes|buenas\s+noches|qué\s+tal|cómo\s+estás?)[\s!?,.]*$/i.test(message.trim());
  }
}

module.exports = new IntentClassifier();
