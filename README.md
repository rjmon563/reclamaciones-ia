# Reclamaciones IA – landing de validación

Página única (`index.html`) que recoge facturas de telefonía y las guarda en Supabase
(proyecto `legajo`, tabla `reclamaciones_solicitudes`, bucket privado `reclamaciones-facturas`).
Publicada en Vercel: proyecto `reclamaciones-ia` → https://reclamacionesia.es (DNS en OVH)

Los visitantes solo pueden **enviar**; no pueden leer solicitudes ni facturas de nadie.

## Aviso por correo
Cada solicitud nueva dispara un trigger (`reclamaciones_aviso_tras_insertar`) que llama a la
función `supabase/functions/reclamaciones-aviso`. Esta envía con Resend un correo a
reclamacionesia@gmail.com con los datos del caso y enlaces a las facturas (válidos 7 días).
La clave de Resend está cifrada en Supabase Vault (`reclamaciones_resend_api_key`), nunca en el código.

## Confirmación al cliente
Desde el 7/11/2026 los correos salen desde avisos@reclamacionesia.es (dominio verificado en Resend).
Cada solicitud envía: aviso interno a reclamacionesia@gmail.com + confirmación al cliente
(responder a: reclamacionesia@gmail.com hasta que exista el buzón contacto@reclamacionesia.es).
