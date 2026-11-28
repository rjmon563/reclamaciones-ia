# ESTADO_ACTUAL — reclamacionesia.es (última actualización: 28 nov 2026)

## Técnico (web + backend) — estable, no tocar sin motivo

- **Web pública:** `index.html` (landing de validación) + `aviso-legal.html`, publicados en Vercel (proyecto `reclamaciones-ia`) en https://reclamacionesia.es (DNS en OVHcloud).
- Los visitantes solo pueden **enviar** su caso (factura + datos); no pueden leer solicitudes ni facturas de nadie más.
- **Datos:** guardados en el proyecto Supabase de **Legajo** (no uno propio), tabla `reclamaciones_solicitudes`, bucket privado `reclamaciones-facturas`.
- **Flujo al entrar una solicitud:**
  1. Trigger `reclamaciones_aviso_tras_insertar` → función `supabase/functions/reclamaciones-aviso` → email con Resend a reclamacionesia@gmail.com (datos del caso + enlaces a facturas, válidos 7 días). Clave de Resend en Supabase Vault (`reclamaciones_resend_api_key`), nunca en el código.
  2. Trigger `reclamaciones_avisar_nueva()` → función `reclamaciones-analisis` → descarga los documentos, los lee con Claude (`claude-sonnet-4-6`, clave `ANTHROPIC_API_KEY` en secretos de Supabase), guarda el resultado en `analisis_estado` / `analisis` / `analisis_at`, y envía a contacto@ un **borrador** de análisis + propuesta de respuesta.
  3. **El cliente no recibe nada automático de ese análisis — Antonio revisa y responde él mismo.** Esto es la regla de "respaldo humano visible" aplicada técnicamente.
- Correos: `avisos@reclamacionesia.es` (confirmaciones automáticas al cliente, Resend, desde el 7/11), `contacto@reclamacionesia.es` (aviso interno + respuestas a clientes, Zimbra/OVH, desde el 13/11).
- Si el análisis automático falla (sin crédito, documento ilegible...), llega un correo "No se pudo analizar automáticamente" en vez del borrador.
- Últimos cambios en la web: botón "Haz tu consulta" visible en menú móvil, consulta rápida sin necesidad de subir factura, enlaces a redes sociales en el footer.

## Contenido y redes — en marcha activa

Todo esto se lleva y se actualiza en el proyecto de claude.ai "Reclamaciones IA" (no en este repo), en los documentos:
- `guiones-serie-facturas-tarifas.md` — estado de la serie de 12 vídeos (a 28 nov: toda la serie de 10 guiones grabada, montada y programada en Metricool; falta grabar el guion 12).
- `captacion-redes-quejas.md` — captación orgánica respondiendo como Antonio (nunca como marca) en grupos de Facebook y en X a quejas reales de usuarios de telefonía.
- `temas-contenido-pendientes.md` — banco de temas para futuros guiones.
- `analisis-competencia-telefonia.md` — quién más hace algo parecido (conclusión: nadie está especializado solo en telefonía con este modelo; hueco libre).
- `guia-estrategia-visibilidad.md` — acciones concretas sacadas de ese análisis (bio, nombrar operadores, gancho de guía gratuita, mostrar precio, etc.).

Los vídeos y material gráfico que sí viven en este repo están en `media/` y `social/` (se suben aquí solo para tener una URL pública que Metricool pueda usar al programar).

## Qué NO tocar / ya resuelto

- Avisos legales y ejemplos anonimizados: ya implementados en la web, no proponer añadirlos de nuevo.
- Modelo de cobro: análisis gratis, 9€ solo si hay caso y se tramita la reclamación — ya decidido, no cambiar sin que Antonio lo pida explícitamente.
- Enfoque actual: solo telefonía e internet (móvil/fibra). Suministros (luz, gas, agua) es fase futura, no tocar todavía.
