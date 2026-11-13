// Agente de análisis de Reclamaciones IA.
// Se llama desde un trigger con {id} cuando entra una solicitud nueva.
// Lee los documentos con Claude, guarda el análisis y envía un BORRADOR a contacto@.
// El cliente no recibe nada de aquí: Antonio revisa y responde él.
// Es seguro aunque sea pública: solo actúa sobre solicitudes reales, recientes y sin analizar.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { encodeBase64 } from "jsr:@std/encoding@1.0.5/base64";

const DESTINO = "contacto@reclamacionesia.es";
const REMITENTE = "Agente Reclamaciones IA <avisos@reclamacionesia.es>";
const BUCKET = "reclamaciones-facturas";
const MODELO = "claude-sonnet-4-6";
const MAX_BYTES = 20 * 1024 * 1024; // tope de documentos que se envían a la IA
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIPOS: Record<string, string> = { particular: "particular", autonomo: "autónomo", empresa: "empresa" };
const AVISOS: Record<string, string> = { si: "dice que sí le avisaron", no: "dice que no le avisaron", no_se: "no sabe si le avisaron" };

function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function hoyMadrid(): string {
  return new Date().toLocaleDateString("es-ES", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", year: "numeric" });
}

const INSTRUCCIONES = (s: any, hoy: string, omitidos: string[]) => `Eres el analista de "Reclamaciones IA", un servicio español que revisa facturas de telefonía (móvil, fibra, fijo) para detectar cobros de más, subidas de precio, descuentos que caducan y permanencias, y que aconseja con honestidad si conviene reclamar, negociar o cambiar de compañía.

Fecha de hoy: ${hoy}.
Datos que ha dado el cliente:
- Reclama como: ${TIPOS[s.tipo_cliente] ?? "no indicado"}
- Compañía: ${s.operadora ?? "no indicada"}
- Aviso previo del cambio: ${AVISOS[s.aviso_previo] ?? "no indicado"}${s.fecha_aviso ? ` (cuándo: ${s.fecha_aviso})` : ""}
- Lo que cuenta: ${s.comentario ? JSON.stringify(s.comentario) : "nada"}
${omitidos.length ? `- Documentos que no se han podido leer por tamaño: ${omitidos.join(", ")}` : ""}

Tarea: analiza TODOS los documentos adjuntos (pueden ser varias facturas de distintos meses, contratos, avisos o capturas) y responde SOLO con un JSON válido, sin markdown ni texto fuera del JSON, con esta forma exacta:
{
  "resumen": "2-3 frases claras para Antonio: qué pasa en este caso",
  "periodos_analizados": ["mes/año de cada factura leída"],
  "cambios_precio": [{"concepto": "", "antes": "", "despues": "", "desde": "", "diferencia_mensual_sin_iva": number|null, "comentario": ""}],
  "descuentos": [{"nombre": "", "importe_mensual_sin_iva": number|null, "fecha_fin": "DD/MM/AAAA o null", "caduca_pronto": true|false}],
  "permanencias": [{"concepto_o_linea": "", "fecha_fin": "", "penalizacion": ""}],
  "avisos_en_documentos": [{"fecha": "", "texto": "cita breve del aviso de cambio de condiciones o precio, si aparece"}],
  "cobros_a_revisar": [{"concepto": "", "importe": "", "motivo": ""}],
  "impacto": {"factura_actual_con_iva": number|null, "factura_prevista_con_iva": number|null, "a_partir_de": "", "diferencia_anual_con_iva": number|null, "explicacion": ""},
  "valoracion": "solido" | "depende" | "dificil" | "sin_caso",
  "motivo_valoracion": "",
  "recomendacion": "qué debería hacer el cliente, en orden, de forma práctica (reclamar, negociar antes de una fecha, cambiar de compañía...)",
  "datos_que_faltan": ["qué documento o dato pedir al cliente para confirmar"],
  "fechas_recordatorio": [{"fecha": "DD/MM/AAAA", "motivo": ""}],
  "guion_llamada": "guion práctico, en pasos numerados y frases cortas en segunda persona, para que el cliente llame o escriba por chat a su compañía: 1) datos a tener a mano (titular, DNI/CIF, número de cliente o línea, facturas); 2) qué decir al empezar; 3) qué pedir exactamente, con las cifras y fechas reales de sus documentos (devolución de un cobro, mantener o renovar un descuento, aplicar el precio anterior...); 4) qué responder si dicen que no; 5) qué pedir al final por escrito (número de incidencia, nuevas condiciones por correo o SMS, fecha de inicio y fin de cualquier descuento, penalización si la hay); 6) qué hacer si no lo solucionan (reclamación por escrito, que podemos preparar).",
  "borrador_respuesta_cliente": "correo completo al cliente en español, tono cercano y claro, tuteando, sin jerga legal. Empieza por 'Hola' (con su nombre si lo sabes por los documentos) y firma 'El equipo de Reclamaciones IA'. Explica lo encontrado con cifras, la valoración y los pasos. Si hay caso para reclamar, menciona que podemos preparar la reclamación completa por 9 €. Termina recordando que es información orientativa, no asesoramiento jurídico."
}

Reglas importantes:
- Usa SOLO datos que aparezcan en los documentos o que haya dado el cliente. Si algo no se ve, ponlo en "datos_que_faltan"; nunca lo inventes ni lo supongas.
- Distingue siempre importes con IVA y sin IVA. Si el cliente es autónomo o empresa, explica el impacto real sin IVA (lo recupera) además del total con IVA.
- Revisa con especial cuidado las páginas interiores y el detalle de cada factura: ahí suelen estar los descuentos con su fecha de fin, los prorrateos y los avisos de cambio de precio.
- Si una subida se cobró antes de la fecha anunciada (por ejemplo, prorrateada en un mes anterior), señálalo en "cobros_a_revisar".
- Normativa orientativa en España: la operadora debe avisar de los cambios de condiciones con al menos un mes de antelación, y ese cambio da derecho a resolver el contrato sin penalización (también a microempresas, salvo renuncia expresa). Ese derecho a irse sin penalización hay que ejercerlo cuando llega el aviso (antes de que se aplique el cambio o poco después); si ya ha pasado ese plazo, NO lo uses como argumento. Si el aviso se hizo en plazo, la subida no es reclamable: dilo con honestidad.
- Valoración: "solido" = hay base clara para reclamar; "depende" = falta un dato clave (por ejemplo, si hubo aviso); "dificil" = poco fundamento; "sin_caso" = no hay nada que reclamar (aunque quizá sí algo que negociar).
- Sé honesto: si lo que más ahorra es negociar o cambiar de compañía y no reclamar, dilo así.
- "impacto": calcula "factura_prevista_con_iva" con una cuenta, nunca a ojo: factura actual con IVA + (suma de los descuentos que caducan, sin IVA) × 1,21. Escribe la cuenta en "explicacion". "diferencia_anual_con_iva" = (prevista − actual) × 12. Si no hay datos para calcularlo, pon null.
- En "guion_llamada" usa solo datos reales del caso. No le hagas amenazar con irse si tiene permanencia o penalización sin decirle antes cuánto le costaría; si puede irse sin penalización (por ejemplo, por un cambio de condiciones), díselo como argumento.
- En "fechas_recordatorio" incluye, si existen, un aviso unas 3-4 semanas antes de que caduque cada descuento importante o termine una permanencia.`;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method" });
  let id = "";
  try { id = String((await req.json()).id ?? ""); } catch { /* vacío */ }
  if (!UUID.test(id)) return json(400, { error: "id" });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // Reclamar la solicitud: reciente y sin analizar
  const hace30 = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: rows, error } = await sb.from("reclamaciones_solicitudes")
    .update({ analisis_estado: "en_curso", analisis_at: new Date().toISOString() })
    .eq("id", id).is("analisis_estado", null).gte("created_at", hace30)
    .select("*");
  if (error) return json(500, { error: "db", detail: error.message });
  if (!rows || rows.length === 0) return json(200, { skipped: true });
  const s = rows[0];

  // El análisis tarda: se responde ya y se trabaja en segundo plano
  // @ts-ignore EdgeRuntime existe en Supabase
  EdgeRuntime.waitUntil(analizar(sb, s));
  return json(202, { started: true });
});

async function enviarCorreo(key: string, subject: string, html: string, replyTo?: string) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: REMITENTE, to: [DESTINO], subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  if (!r.ok) console.error("[analisis] Resend:", r.status, (await r.text()).slice(0, 300));
}

async function analizar(sb: any, s: any) {
  const { data: resendKey } = await sb.rpc("reclamaciones_resend_key");
  const fallo = async (motivo: string) => {
    console.error("[analisis] fallo:", motivo);
    await sb.from("reclamaciones_solicitudes").update({ analisis_estado: "error", analisis: { error: motivo } }).eq("id", s.id);
    if (resendKey) await enviarCorreo(resendKey, `No se pudo analizar automáticamente: ${s.email}`,
      `<div style="font-family:Arial,sans-serif"><p>El agente no ha podido analizar la solicitud de <strong>${esc(s.email)}</strong>.</p><p>Motivo: ${esc(motivo)}</p><p>Revísala a mano con los enlaces del aviso de nueva solicitud.</p></div>`, s.email);
  };

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return await fallo("falta ANTHROPIC_API_KEY en los secretos de Supabase");

    // Descargar documentos
    const bloques: any[] = [];
    const omitidos: string[] = [];
    let total = 0;
    for (const ruta of (s.archivos ?? []) as string[]) {
      const nombre = ruta.split("/").pop() ?? ruta;
      const { data: blob, error } = await sb.storage.from(BUCKET).download(ruta);
      if (error || !blob) { omitidos.push(nombre); continue; }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (total + bytes.length > MAX_BYTES) { omitidos.push(nombre); continue; }
      total += bytes.length;
      const tipo = blob.type || (nombre.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg");
      const data = encodeBase64(bytes);
      if (tipo === "application/pdf") {
        bloques.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data }, title: nombre });
      } else if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(tipo)) {
        bloques.push({ type: "text", text: `Documento: ${nombre}` });
        bloques.push({ type: "image", source: { type: "base64", media_type: tipo, data } });
      } else {
        omitidos.push(`${nombre} (formato ${tipo} no compatible, p. ej. HEIC)`);
      }
    }
    if (!bloques.length) return await fallo("no se ha podido leer ningún documento" + (omitidos.length ? `: ${omitidos.join(", ")}` : ""));

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 8000,
        messages: [{ role: "user", content: [...bloques, { type: "text", text: INSTRUCCIONES(s, hoyMadrid(), omitidos) }] }],
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      if (/credit balance is too low/i.test(t)) return await fallo("la cuenta de Anthropic se ha quedado sin crédito (recarga en platform.claude.com)");
      return await fallo(`la IA devolvió un error ${r.status}: ${t.slice(0, 300)}`);
    }
    const data = await r.json();
    const texto = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    let a: any;
    try {
      const limpio = texto.replace(/```json|```/g, "").trim();
      a = JSON.parse(limpio.slice(limpio.indexOf("{"), limpio.lastIndexOf("}") + 1));
    } catch { return await fallo("la IA no devolvió un JSON válido"); }

    // La cuenta del impacto la hace el programa, no la IA
    const imp = a.impacto || (a.impacto = {});
    const caducan = (Array.isArray(a.descuentos) ? a.descuentos : []).filter((d: any) => d && d.caduca_pronto && typeof d.importe_mensual_sin_iva === "number");
    if (typeof imp.factura_actual_con_iva === "number" && caducan.length) {
      const r2 = (n: number) => Math.round(n * 100) / 100;
      const suma = r2(caducan.reduce((t: number, d: any) => t + d.importe_mensual_sin_iva, 0));
      imp.factura_prevista_con_iva = r2(imp.factura_actual_con_iva + suma * 1.21);
      imp.diferencia_anual_con_iva = r2((imp.factura_prevista_con_iva - imp.factura_actual_con_iva) * 12);
      imp.explicacion = `Cuenta: ${eur(imp.factura_actual_con_iva)} de la factura actual + ${eur(suma)} sin IVA de descuentos que caducan (${caducan.map((d: any) => `${d.nombre}${d.fecha_fin ? `, ${d.fecha_fin}` : ""}`).join("; ")}) × 1,21 = ${eur(imp.factura_prevista_con_iva)} al mes. Sin IVA son ${eur(suma)} más al mes. Estimación si la compañía no renueva nada.`;
    }

    await sb.from("reclamaciones_solicitudes").update({
      analisis_estado: "listo", analisis: a, analisis_at: new Date().toISOString(),
      estado: "analizada",
    }).eq("id", s.id);

    if (resendKey) await enviarCorreo(resendKey, `Borrador de análisis (${etiqueta(a.valoracion)}): ${s.email}`, htmlAnalisis(s, a, omitidos), s.email);
  } catch (e) {
    await fallo(String((e as Error).message || e));
  }
}

function etiqueta(v: string) {
  return ({ solido: "caso sólido", depende: "depende", dificil: "difícil", sin_caso: "sin caso" } as Record<string, string>)[v] ?? "revisar";
}

function eur(n: unknown) {
  return typeof n === "number" && isFinite(n) ? n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €" : "—";
}

function htmlAnalisis(s: any, a: any, omitidos: string[]) {
  const sec = (titulo: string, cuerpo: string) => cuerpo ? `<h3 style="margin:22px 0 8px;font-size:16px">${titulo}</h3>${cuerpo}` : "";
  const lista = (arr: any[], fn: (x: any) => string) => Array.isArray(arr) && arr.length ? `<ul style="margin:0;padding-left:20px">${arr.map((x) => `<li style="margin:4px 0">${fn(x)}</li>`).join("")}</ul>` : "";
  const colores: Record<string, string> = { solido: "#0B5246", depende: "#9A3412", dificil: "#55625D", sin_caso: "#55625D" };
  const imp = a.impacto || {};
  return `
<div style="font-family:Arial,sans-serif;color:#14201C;max-width:640px;line-height:1.5">
  <p style="margin:0 0 6px;font-size:13px;color:#55625D">BORRADOR PARA REVISAR · el cliente todavía no ha recibido nada</p>
  <h2 style="margin:0 0 6px">Análisis de ${esc(s.email)}</h2>
  <p style="margin:0 0 14px"><span style="display:inline-block;padding:4px 12px;border-radius:999px;background:#F6F7F4;color:${colores[a.valoracion] ?? "#14201C"};font-weight:bold">${esc(etiqueta(a.valoracion))}</span> ${esc(a.motivo_valoracion)}</p>
  <p style="padding:12px 14px;background:#E3F2EE;border-radius:10px;margin:0">${esc(a.resumen)}</p>
  ${sec("Impacto", (imp.factura_actual_con_iva != null || imp.factura_prevista_con_iva != null) ? `<p style="margin:0">Factura actual: <strong>${eur(imp.factura_actual_con_iva)}</strong> → prevista: <strong>${eur(imp.factura_prevista_con_iva)}</strong>${imp.a_partir_de ? ` (desde ${esc(imp.a_partir_de)})` : ""}. Diferencia anual: <strong>${eur(imp.diferencia_anual_con_iva)}</strong> con IVA.<br>${esc(imp.explicacion)}</p>` : "")}
  ${sec("Cambios de precio", lista(a.cambios_precio, (x) => `<strong>${esc(x.concepto)}</strong>: ${esc(x.antes)} → ${esc(x.despues)}${x.desde ? ` desde ${esc(x.desde)}` : ""}${x.diferencia_mensual_sin_iva != null ? ` (${eur(x.diferencia_mensual_sin_iva)}/mes sin IVA)` : ""}. ${esc(x.comentario)}`))}
  ${sec("Descuentos", lista(a.descuentos, (x) => `${esc(x.nombre)}: ${eur(x.importe_mensual_sin_iva)}/mes sin IVA · fin: <strong style="color:${x.caduca_pronto ? "#9A3412" : "#14201C"}">${esc(x.fecha_fin ?? "—")}</strong>`))}
  ${sec("Permanencias", lista(a.permanencias, (x) => `${esc(x.concepto_o_linea)} · hasta ${esc(x.fecha_fin)} · ${esc(x.penalizacion)}`))}
  ${sec("Avisos encontrados en los documentos", lista(a.avisos_en_documentos, (x) => `${esc(x.fecha)}: «${esc(x.texto)}»`))}
  ${sec("Cobros a revisar", lista(a.cobros_a_revisar, (x) => `${esc(x.concepto)} (${esc(x.importe)}): ${esc(x.motivo)}`))}
  ${sec("Recomendación", `<p style="margin:0">${esc(a.recomendacion)}</p>`)}
  ${sec("Datos que faltan", lista(a.datos_que_faltan, (x) => esc(x)))}
  ${sec("Fechas para recordatorios", lista(a.fechas_recordatorio, (x) => `${esc(x.fecha)}: ${esc(x.motivo)}`))}
  ${omitidos.length ? `<p style="color:#9A3412">No se han podido leer: ${esc(omitidos.join(", "))}</p>` : ""}
  ${a.guion_llamada ? `<h3 style="margin:26px 0 8px;font-size:16px">Guion para llamar a la compañía</h3><div style="white-space:pre-wrap;padding:14px 16px;border:1px solid #E1E5E1;border-radius:10px;background:#F6F7F4">${esc(a.guion_llamada)}</div>` : ""}
  <h3 style="margin:26px 0 8px;font-size:16px">Borrador de respuesta al cliente</h3>
  <p style="margin:0 0 8px;font-size:13px;color:#55625D">Revísalo, corrige lo que haga falta y envíalo respondiendo a este correo (la respuesta va al cliente).</p>
  <div style="white-space:pre-wrap;padding:14px 16px;border:1px solid #E1E5E1;border-radius:10px;background:#fff">${esc(a.borrador_respuesta_cliente)}</div>
  <p style="margin:22px 0 0;font-size:12px;color:#55625D">Análisis generado automáticamente con IA a partir de los documentos. Puede contener errores: comprueba cifras y fechas antes de enviarlo.</p>
</div>`;
}
