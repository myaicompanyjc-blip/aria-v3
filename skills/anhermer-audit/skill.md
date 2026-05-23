# Skill: Auditoría y Reportes — Anhermer Investment LLC

## Propósito
Validar datos financieros, generar reportes de auditoría y análisis de proyectos de construcción.

## Tipos de auditoría

### Reconciliación de facturas
- Comparar facturas vs órdenes de compra
- Detectar: montos incorrectos, duplicados, facturas sin OC, retenciones mal aplicadas
- Alertas: >$5M diferencia = CRÍTICA, >$500K = MEDIA

### Auditoría de obra
- Verificar avance físico vs presupuesto
- Detectar sobrecostos (>10% del ítem = alerta)
- Calcular % de ejecución presupuestal

## Formato de reporte de auditoría

```
REPORTE AUDITORÍA — ANH-[AÑO]-AUD-[PROYECTO]
Fecha: [fecha]
Período: [inicio] a [fin]

RESUMEN EJECUTIVO:
- Documentos auditados: [N]
- Alertas: [N críticas] / [N medias] / [N bajas]
- Presupuesto ejecutado: [%]
- Observaciones clave: [...]

ALERTAS CRÍTICAS:
[detalle]

RECOMENDACIONES:
[acciones]
```

## Indicadores clave a calcular
- Costo real vs presupuesto (varianza %)
- Días de obra ejecutados vs programados
- Facturas pendientes de pago
- Retenciones acumuladas
