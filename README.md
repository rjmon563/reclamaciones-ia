# Reclamaciones IA – landing de validación

Página única (`index.html`) que recoge facturas de telefonía y las guarda en Supabase
(proyecto `legajo`, tabla `reclamaciones_solicitudes`, bucket privado `reclamaciones-facturas`).
Publicada en Vercel: proyecto `reclamaciones-ia` → https://reclamaciones-ia-wine.vercel.app

Los visitantes solo pueden **enviar**; no pueden leer solicitudes ni facturas de nadie.

## Aviso por correo
Cada solicitud nueva dispara un trigger (`reclamaciones_aviso_tras_insertar`) que llama a la
función `supabase/functions/reclamaciones-aviso`. Esta envía con Resend un correo a
reclamacionesia@gmail.com con los datos del caso y enlaces a las facturas (válidos 7 días).
La clave de Resend está cifrada en Supabase Vault (`reclamaciones_resend_api_key`), nunca en el código.
