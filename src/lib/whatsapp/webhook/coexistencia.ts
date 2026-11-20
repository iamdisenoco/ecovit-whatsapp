// ============================================================
// Coexistencia con la app WhatsApp Business (RF-M03.10), en reglas puras.
//
// - Lo que un vendedor contesta desde el celular llega como `message.sent` con
//   `source: "whatsapp_business_app"`: se guarda como mensaje de agente y CALLA
//   al bot en ese chat, con el mismo `ai_autoreply_disabled` que «Tomar el
//   control». El motivo queda en `ai_handoff_summary` para distinguirlo.
// - El bot no vuelve solo: vuelve con «Devolver al bot». Salvo una cosa: si el
//   cliente llevaba 24 h sin escribir y vuelve a escribir, el bot vuelve.
// - Lo que tiene fecha anterior a la conexión (los hasta 6 meses de historia que
//   trae la coexistencia) no despierta al bot.
// ============================================================

import type { ConversacionFila } from './almacen';

/** Lo que se escribe en `ai_handoff_summary` al callar al bot por el celular. */
export const MOTIVO_CELULAR =
  'Contestado desde el celular (WhatsApp Business): el bot se calló en este chat.';

export const VEINTICUATRO_HORAS_MS = 24 * 60 * 60 * 1000;

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** ¿Es historia de antes de conectar el número? Sin fecha de conexión: `true` (falla cerrado). */
export function esAnteriorALaConexion(
  enviadoEn: string,
  conectadoDesde: string | null
): boolean {
  const envio = ms(enviadoEn);
  const conexion = ms(conectadoDesde);
  // Falla cerrado: sin fecha de conexión (o con una fecha ilegible) no se sabe
  // qué es historia, así que todo lo es. El bot no se despierta por adivinar.
  if (conexion === null || envio === null) return true;
  return envio < conexion;
}

/**
 * ¿Un eco del celular calla al bot? Solo si es de después de conectar: la
 * historia sincronizada no apaga el bot en chats que ya terminaron.
 */
export function ecoDelCelularCallaAlBot(
  enviadoEn: string,
  conectadoDesde: string | null
): boolean {
  // Callar es la dirección segura: sin fecha de conexión, el eco calla al bot.
  if (ms(conectadoDesde) === null) return true;
  return !esAnteriorALaConexion(enviadoEn, conectadoDesde);
}

/**
 * Al llegar un mensaje del cliente: ¿hay que devolverle el chat al bot? Sí solo
 * si lo calló el celular (no una persona con «Tomar»), nadie lo tiene asignado
 * y el último mensaje del cliente fue hace 24 h o más.
 */
export function debeDespertarPorInactividad(
  conversacion: Pick<
    ConversacionFila,
    | 'ai_autoreply_disabled'
    | 'ai_handoff_summary'
    | 'assigned_agent_id'
    | 'last_inbound_at'
  >,
  recibidoEn: string
): boolean {
  if (!conversacion.ai_autoreply_disabled) return false;
  if (conversacion.ai_handoff_summary !== MOTIVO_CELULAR) return false;
  if (conversacion.assigned_agent_id) return false;
  const anterior = ms(conversacion.last_inbound_at);
  const ahora = ms(recibidoEn);
  if (anterior === null || ahora === null) return false;
  return ahora - anterior >= VEINTICUATRO_HORAS_MS;
}

/**
 * ¿Este entrante puede despertar al bot (y a los motores)? No si es historia,
 * si otra app tiene el chat (`standby`), o si es anterior a la conexión.
 */
export function entrantePuedeDespertarAlBot(
  evento: { enviadoEn: string; enEspera: boolean; esHistoria: boolean },
  conectadoDesde: string | null
): boolean {
  if (evento.esHistoria || evento.enEspera) return false;
  return !esAnteriorALaConexion(evento.enviadoEn, conectadoDesde);
}
