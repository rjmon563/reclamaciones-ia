// Agente de "consulta rápida" de Reclamaciones IA.
// Para gente que solo quiere preguntar algo sin subir facturas todavía.
// Se llama desde la web justo después de insertar en reclamaciones_consultas,
// con {id}. Genera un borrador de respuesta (tono cercano, humano) y lo manda
// a contacto@ para que Antonio lo revise y conteste él, igual que en
// reclamaciones-analisis: el cliente no recibe nada directamente de aquí.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const DESTINO = "contacto@reclamacionesia.es";
const REMITENTE = "Agente Reclamaciones IA <avisos@reclamacionesia.es>";
const MODELO = "claude-sonnet-4-6";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Base legal verificada contra el texto consolidado real del BOE ---
// Mismo mecanismo que reclamaciones-analisis: en vez de que la IA cite de
// memoria, se consulta boe-connector (misma cuenta de Supabase) y solo se
// permite citar lo que viene literalmente de ahí.
const NORMAS_BASE = [
  { id: "BOE-A-2022-10757", nombre: "Ley 11/2022, de 28 de junio, General de Telecomunicaciones" },
  { id: "BOE-A-2007-20555", nombre: "Texto Refundido de la Ley General para la Defensa de los Consumidores y Usuarios (TRLGDCU)" },
  { id: "BOE-A-2018-16673", nombre: "Ley Orgánica 3/2018, de Protección de Datos Personales y garantía de los derechos digitales (LOPDGDD)" },
];
const PALABRAS_CLAVE_LEGAL = [
  "permanencia", "penalización por", "resolver el contrato", "resolución del contrato",
  "modificación de las condiciones", "duración del contrato", "baja del servicio",
  "preaviso", "sin penalización", "rescindir el contrato", "sin coste alguno",
  "derecho de desistimiento",
  "sistemas de información crediticia", "deudas ciertas, vencidas y exigibles",
  "objeto de reclamación", "incumplimiento de obligaciones dinerarias",
  "posibilidad de inclusión en dichos sistemas", "cinco años desde la fecha de vencimiento",
];
const MAX_ARTICULOS_POR_NORMA = 4;
const MAX_CHARS_TEXTO_LEGAL = 9000;

function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function hoyMadrid(): string {
  return new Date().toLocaleDateString("es-ES", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", year: "numeric" });
}

async function llamarBoeConnector(body: Record<string, unknown>) {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/boe-connector`;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, apikey: key },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`boe-connector ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return await r.json();
}

function extraerNodosDeTexto(obj: unknown, out: { texto: string; clase: string }[] = []) {
  if (!obj || typeof obj !== "object") return out;
  const o = obj as Record<string, unknown>;
  if (typeof o["#text"] === "string" && typeof o["@_class"] === "string") {
    out.push({ texto: o["#text"] as string, clase: o["@_class"] as string });
  }
  for (const v of Object.values(o)) {
    if (Array.isArray(v)) v.forEach((x) => extraerNodosDeTexto(x, out));
    else if (v && typeof v === "object") extraerNodosDeTexto(v, out);
  }
  return out;
}

function agruparEnArticulos(nodos: { texto: string; clase: string }[]) {
  const articulos: { titulo: string; cuerpo: string[] }[] = [];
  let actual: { titulo: string; cuerpo: string[] } | null = null;
  for (const n of nodos) {
    if (n.clase === "articulo") {
      if (actual) articulos.push(actual);
      actual = { titulo: n.texto, cuerpo: [] };
    } else if (actual) {
      actual.cuerpo.push(n.texto);
    }
  }
  if (actual) articulos.push(actual);
  return articulos;
}

async function obtenerBaseLegalVerificada(): Promise<string> {
  const citas: string[] = [];
  for (const norma of NORMAS_BASE) {
    try {
      const resp = await llamarBoeConnector({ action: "texto", id: norma.id });
      const nodos = extraerNodosDeTexto(resp.contenido);
      const articulos = agruparEnArticulos(nodos);
      const vistos = new Set<string>();
      const puntuados: { art: { titulo: string; cuerpo: string[] }; score: number }[] = [];
      for (const art of articulos) {
        if (!art.titulo.trim().toLowerCase().startsWith("artículo")) continue;
        if (vistos.has(art.titulo)) continue;
        const texto = (art.titulo + " " + art.cuerpo.join(" ")).toLowerCase();
        const score = PALABRAS_CLAVE_LEGAL.filter((k) => texto.includes(k)).length;
        if (score > 0) {
          vistos.add(art.titulo);
          puntuados.push({ art, score });
        }
      }
      puntuados.sort((a, b) => b.score - a.score);
      const relevantes = puntuados.slice(0, MAX_ARTICULOS_POR_NORMA).map((p) => p.art);
      for (const art of relevantes) {
        const texto = (art.titulo + " " + art.cuerpo.join(" ")).replace(/\s+/g, " ").trim().slice(0, 1400);
        if (texto) citas.push(`[${norma.nombre}]\n${texto}`);
      }
    } catch (e) {
      console.error("[consulta] texto BOE falló:", norma.id, (e as Error).message);
    }
  }
  return citas.join("\n\n").slice(0, MAX_CHARS_TEXTO_LEGAL);
}

const INSTRUCCIONES = (mensaje: string, hoy: string, baseLegal: string) => `Eres el analista de "Reclamaciones IA", un servicio español que ayuda a revisar problemas con telefonía, fibra e internet (cobros de más, subidas de tarifa, permanencias, bajas que siguen cobrando, servicios no contratados) y aconseja con honestidad qué hacer.

Esto NO es el formulario completo de subir facturas: es una consulta rápida de alguien que solo ha escrito su problema, sin adjuntar nada todavía. No tienes facturas que analizar, así que no inventes cifras ni fechas concretas que no te haya dado la persona.

Fecha de hoy: ${hoy}.
Lo que ha escrito la persona (tal cual, puede tener faltas o estar desordenado):
"""
${mensaje}
"""

${baseLegal
  ? `TEXTO LEGAL VERIFICADO (extraído en vivo del texto consolidado del BOE, es la única fuente que puedes citar como artículo de ley; si no hay ningún artículo de la lista que aplique de verdad a este caso, no cites ninguno):\n${baseLegal}`
  : `No se ha podido verificar el texto legal en vivo contra el BOE en este momento. No cites artículos ni números de ley concretos.`}

Tarea: responde SOLO con un JSON válido, sin markdown ni texto fuera del JSON, con esta forma exacta:
{
  "resumen": "1-2 frases claras para Antonio: qué pide o qué le pasa a esta persona",
  "valoracion": "posible_caso" | "necesita_mas_datos" | "fuera_de_alcance",
  "motivo_valoracion": "por qué esa valoración, en una frase",
  "base_legal": [{"norma": "nombre exacto tal como aparece arriba", "articulo": "título del artículo tal como aparece arriba", "cita_literal": "fragmento literal o resumen muy fiel"}],
  "pedir_factura": true | false,
  "respuesta_cliente": "la respuesta que recibiría la persona. Tono: como si se lo contara un amigo que sabe del tema, no un departamento legal. Cercano, directo, frases cortas, nada de 'estimado usuario' ni jerga. Si hace falta, puedes abrir reconociendo brevemente la situación (ej. 'qué rabia, es de lo más repetido que vemos') antes de pasar al consejo, pero sin alargarte ni sonar a guion. Da el siguiente paso concreto que puede dar YA, aunque no suba ninguna factura. Si con lo que cuenta merece la pena revisar su caso a fondo, invítale a subir la factura o el contrato para el análisis gratuito completo, sin presionar. Firma 'El equipo de Reclamaciones IA'. Termina recordando en una frase corta que es información orientativa, no asesoramiento jurídico."
}

Reglas importantes:
- "base_legal" solo puede contener artículos que aparezcan literalmente en el TEXTO LEGAL VERIFICADO de arriba. Si ninguno aplica de verdad al caso, deja la lista vacía [].
- Si el mensaje no tiene que ver con telefonía/fibra/internet (por ejemplo, es sobre un banco o un seguro), dilo con honestidad en "respuesta_cliente": que ese no es el ámbito actual del servicio, sin inventar que sí podéis ayudar.
- Si falta información clave para saber si hay caso, "valoracion" es "necesita_mas_datos" y en "respuesta_cliente" pide justo ese dato, de forma concreta (p.ej. "¿te avisaron antes de la subida, por SMS o correo?").
- Sé honesto: si por lo que cuenta no parece que haya nada que reclamar, dilo con cercanía, no con un no seco, y explica por qué.`;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method" });
  let id = "";
  try { id = String((await req.json()).id ?? ""); } catch { /* vacío */ }
  if (!UUID.test(id)) return json(400, { error: "id" });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const hace30 = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: rows, error } = await sb.from("reclamaciones_consultas")
    .update({ respuesta_estado: "en_curso" })
    .eq("id", id).is("respuesta_estado", null).gte("created_at", hace30)
    .select("*");
  if (error) return json(500, { error: "db", detail: error.message });
  if (!rows || rows.length === 0) return json(200, { skipped: true });
  const s = rows[0];

  // @ts-ignore EdgeRuntime existe en Supabase
  EdgeRuntime.waitUntil(responder(sb, s));
  return json(202, { started: true });
});

async function enviarCorreo(key: string, subject: string, html: string, replyTo?: string) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: REMITENTE, to: [DESTINO], subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  if (!r.ok) console.error("[consulta] Resend:", r.status, (await r.text()).slice(0, 300));
}

async function responder(sb: any, s: any) {
  const { data: resendKey } = await sb.rpc("reclamaciones_resend_key");
  const fallo = async (motivo: string) => {
    console.error("[consulta] fallo:", motivo);
    await sb.from("reclamaciones_consultas").update({ respuesta_estado: "error", respuesta: { error: motivo } }).eq("id", s.id);
    if (resendKey) await enviarCorreo(resendKey, `No se pudo responder automáticamente a una consulta: ${s.email}`,
      `<div style="font-family:Arial,sans-serif"><p>El agente no ha podido generar la respuesta para <strong>${esc(s.email)}</strong>.</p><p>Motivo: ${esc(motivo)}</p><p>Mensaje original: ${esc(s.mensaje)}</p></div>`, s.email);
  };

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return await fallo("falta ANTHROPIC_API_KEY en los secretos de Supabase");

    let baseLegal = "";
    try {
      baseLegal = await obtenerBaseLegalVerificada();
    } catch (e) {
      console.error("[consulta] base legal BOE falló por completo:", (e as Error).message);
    }

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 3000,
        messages: [{ role: "user", content: [{ type: "text", text: INSTRUCCIONES(s.mensaje, hoyMadrid(), baseLegal) }] }],
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

    await sb.from("reclamaciones_consultas").update({
      respuesta_estado: "lista", respuesta: a, respuesta_at: new Date().toISOString(),
      estado: "respondida",
    }).eq("id", s.id);

    if (resendKey) await enviarCorreo(resendKey, `Borrador de consulta rápida (${etiqueta(a.valoracion)}): ${s.email}`, htmlConsulta(s, a), s.email);
  } catch (e) {
    await fallo(String((e as Error).message || e));
  }
}

function etiqueta(v: string) {
  return ({ posible_caso: "posible caso", necesita_mas_datos: "faltan datos", fuera_de_alcance: "fuera de alcance" } as Record<string, string>)[v] ?? "revisar";
}

function htmlConsulta(s: any, a: any) {
  const sec = (titulo: string, cuerpo: string) => cuerpo ? `<h3 style="margin:22px 0 8px;font-size:16px">${titulo}</h3>${cuerpo}` : "";
  const lista = (arr: any[], fn: (x: any) => string) => Array.isArray(arr) && arr.length ? `<ul style="margin:0;padding-left:20px">${arr.map((x) => `<li style="margin:4px 0">${fn(x)}</li>`).join("")}</ul>` : "";
  const colores: Record<string, string> = { posible_caso: "#0B5246", necesita_mas_datos: "#9A3412", fuera_de_alcance: "#55625D" };
  return `
<div style="font-family:Arial,sans-serif;color:#14201C;max-width:640px;line-height:1.5">
  <p style="margin:0 0 6px;font-size:13px;color:#55625D">BORRADOR PARA REVISAR · consulta rápida, sin factura · el cliente todavía no ha recibido nada</p>
  <h2 style="margin:0 0 6px">Consulta de ${esc(s.email)}${s.nombre ? ` (${esc(s.nombre)})` : ""}</h2>
  <p style="margin:0 0 14px"><span style="display:inline-block;padding:4px 12px;border-radius:999px;background:#F6F7F4;color:${colores[a.valoracion] ?? "#14201C"};font-weight:bold">${esc(etiqueta(a.valoracion))}</span> ${esc(a.motivo_valoracion)}</p>
  <h3 style="margin:0 0 8px;font-size:16px">Mensaje original</h3>
  <p style="padding:12px 14px;background:#F6F7F4;border-radius:10px;margin:0 0 14px;white-space:pre-wrap">${esc(s.mensaje)}</p>
  <p style="padding:12px 14px;background:#E3F2EE;border-radius:10px;margin:0">${esc(a.resumen)}</p>
  ${a.pedir_factura ? `<p style="margin:14px 0 0;color:#0B5246"><strong>Sugerencia:</strong> invitarle a subir su factura para el análisis completo.</p>` : ""}
  ${sec("Base legal citada (verificada en vivo contra el BOE)", lista(a.base_legal, (x) => `<strong>${esc(x.norma)}</strong> — ${esc(x.articulo)}<br><span style="color:#55625D">«${esc(x.cita_literal)}»</span>`))}
  <h3 style="margin:26px 0 8px;font-size:16px">Borrador de respuesta al cliente</h3>
  <p style="margin:0 0 8px;font-size:13px;color:#55625D">Revísalo, corrige lo que haga falta y envíalo respondiendo a este correo (la respuesta va al cliente).</p>
  <div style="white-space:pre-wrap;padding:14px 16px;border:1px solid #E1E5E1;border-radius:10px;background:#fff">${esc(a.respuesta_cliente)}</div>
  <p style="margin:22px 0 0;font-size:12px;color:#55625D">Borrador generado automáticamente con IA a partir del mensaje. Compruébalo antes de enviarlo.</p>
</div>`;
}
