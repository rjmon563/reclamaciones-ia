// Aviso por correo de cada solicitud nueva de Reclamaciones IA.
// Se llama desde un trigger de la base de datos con {id}.
// Es seguro aunque sea pública: solo actúa sobre solicitudes reales, recientes
// y aún no avisadas, y envía un único correo por solicitud.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const DESTINO = "reclamacionesia@gmail.com";
const REMITENTE = "Reclamaciones IA <onboarding@resend.dev>";
const BUCKET = "reclamaciones-facturas";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TIPOS: Record<string, string> = { particular: "Particular", autonomo: "Autónomo", empresa: "Empresa" };
const AVISOS: Record<string, string> = { si: "Sí", no: "No", no_se: "No lo sabe" };

function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method" });
  let id = "";
  try { id = String((await req.json()).id ?? ""); } catch { /* vacío */ }
  if (!UUID.test(id)) return json(400, { error: "id" });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // Reclamar la solicitud: solo si es reciente y no se ha avisado ya
  const hace15 = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: rows, error } = await sb
    .from("reclamaciones_solicitudes")
    .update({ notificado_at: new Date().toISOString() })
    .eq("id", id).is("notificado_at", null).gte("created_at", hace15)
    .select("*");
  if (error) return json(500, { error: "db", detail: error.message });
  if (!rows || rows.length === 0) return json(200, { skipped: true });
  const s = rows[0];

  const liberar = () => sb.from("reclamaciones_solicitudes").update({ notificado_at: null }).eq("id", id);

  // Enlaces temporales (7 días) a las facturas
  const enlaces: string[] = [];
  for (const ruta of (s.archivos ?? []) as string[]) {
    const { data } = await sb.storage.from(BUCKET).createSignedUrl(ruta, 60 * 60 * 24 * 7);
    const nombre = ruta.split("/").pop() ?? ruta;
    enlaces.push(data?.signedUrl
      ? `<li><a href="${esc(data.signedUrl)}">${esc(nombre)}</a></li>`
      : `<li>${esc(nombre)} (no se pudo generar el enlace)</li>`);
  }

  const { data: key, error: kErr } = await sb.rpc("reclamaciones_resend_key");
  if (kErr || !key) { await liberar(); return json(500, { error: "key" }); }

  const fila = (k: string, v: unknown) => v ? `<tr><td style="padding:4px 12px 4px 0;color:#55625D">${k}</td><td style="padding:4px 0"><strong>${esc(v)}</strong></td></tr>` : "";
  const html = `
  <div style="font-family:Arial,sans-serif;color:#14201C;max-width:560px">
    <h2 style="margin:0 0 12px">Nueva solicitud de análisis</h2>
    <table style="border-collapse:collapse;font-size:15px">
      ${fila("Correo", s.email)}
      ${fila("Nombre", s.nombre)}
      ${fila("Tipo", TIPOS[s.tipo_cliente] ?? s.tipo_cliente)}
      ${fila("Compañía", s.operadora)}
      ${fila("¿Le avisaron?", AVISOS[s.aviso_previo] ?? s.aviso_previo)}
      ${fila("Fecha del aviso", s.fecha_aviso)}
      ${fila("Recordatorios", s.acepta_recordatorios ? "Sí, quiere que le avisemos" : "No")}
      ${fila("Documentos", `${(s.archivos ?? []).length}`)}
      ${fila("Recibida", new Date(s.created_at).toLocaleString("es-ES", { timeZone: "Europe/Madrid" }))}
    </table>
    ${s.comentario ? `<p style="margin:16px 0 4px;color:#55625D">Qué ha pasado:</p><blockquote style="margin:0;padding:8px 12px;background:#F6F7F4;border-radius:8px">${esc(s.comentario)}</blockquote>` : ""}
    <p style="margin:16px 0 4px;color:#55625D">Facturas (enlaces válidos 7 días):</p>
    <ul style="margin:0;padding-left:20px">${enlaces.join("")}</ul>
    <p style="margin:20px 0 0;font-size:13px;color:#55625D">Recuerda: prometimos respuesta en menos de 24 horas. Para contestar al cliente, responde a este correo.</p>
  </div>`;

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: REMITENTE,
      to: [DESTINO],
      reply_to: s.email,
      subject: `Nueva solicitud: ${s.operadora ?? "telefonía"} · ${TIPOS[s.tipo_cliente] ?? ""} · ${s.email}`,
      html,
    }),
  });
  const res = await r.json().catch(() => ({}));
  if (!r.ok) { await liberar(); return json(502, { error: "resend", detail: res }); }
  return json(200, { sent: true, resend_id: res.id });
});
