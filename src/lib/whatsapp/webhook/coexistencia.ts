// ============================================================
// Coexistencia con la app WhatsApp Business (RF-M03.10), en reglas puras.
//
// - Lo que un vendedor contesta desde el celular llega como `message.sent` con
//   `source: "whatsapp_business_app"`: se guarda como mensaje de agente y CALLA
//   al bot en ese chat, con el mismo `ai_autoreply_disabled` que «Tomar el
//   control». El motivo queda en `ai_handoff_summary` para distinguirlo.
// - El bot vuelve con «Retomar IA», o solo: si el cliente escribe cuando ya
//   pasaron `HORAS_CELULAR` desde la ÚLTIMA respuesta del celular en ese chat
//   (cada eco nuevo reinicia el reloj), el bot vuelve y contesta ese mensaje.
// - Lo que tiene fecha anterior a la conexión (los hasta 6 meses de historia que
//   trae la coexistencia) no despierta al bot.
// ============================================================

import type { ConversacionFila } from './almacen';

/** Lo que se escribe en `ai_handoff_summary` al callar al bot por el celular. */
export const MOTIVO_CELULAR =
  'Contestado desde el celular (WhatsApp Business): el bot se calló en este chat.';

/** Horas desde la última respuesta del celular para que el bot vuelva solo. */
export const HORAS_CELULAR = 4;
export const ESPERA_CELULAR_MS = HORAS_CELULAR * 60 * 60 * 1000;

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

/** ¿Al bot lo calló el celular en este chat (y no una persona con «Tomar»)? */
export function calladoPorCelular(conversacion: {
  ai_autoreply_disabled?: boolean | null;
  ai_handoff_summary?: string | null;
}): boolean {
  return (
    !!conversacion.ai_autoreply_disabled &&
    conversacion.ai_handoff_summary === MOTIVO_CELULAR
  );
}

/**
 * ¿Vale la pena leer el último eco del celular? Solo si el chat lo calló el
 * celular y nadie lo tiene: en cualquier otro caso el bot no vuelve solo.
 */
export function puedeVolverPorCelular(
  conversacion: Pick<
    ConversacionFila,
    'ai_autoreply_disabled' | 'ai_handoff_summary' | 'assigned_agent_id'
  >
): boolean {
  return calladoPorCelular(conversacion) && !conversacion.assigned_agent_id;
}

/** Desde cuándo el bot vuelve solo: último eco del celular + `HORAS_CELULAR`. */
export function vueltaDelBot(ultimoEcoCelular: string | null): number | null {
  const eco = ms(ultimoEcoCelular);
  return eco === null ? null : eco + ESPERA_CELULAR_MS;
}

/**
 * Al llegar un mensaje del cliente: ¿hay que devolverle el chat al bot? Sí solo
 * si lo calló el celular, nadie lo tiene asignado y la última respuesta del
 * celular en ese chat tiene `HORAS_CELULAR` o más. Sin eco no vuelve: ante la
 * duda, el chat sigue con la persona.
 */
export function debeVolverElBot(
  conversacion: Pick<
    ConversacionFila,
    'ai_autoreply_disabled' | 'ai_handoff_summary' | 'assigned_agent_id'
  >,
  ultimoEcoCelular: string | null,
  recibidoEn: string
): boolean {
  if (!puedeVolverPorCelular(conversacion)) return false;
  const vuelta = vueltaDelBot(ultimoEcoCelular);
  const ahora = ms(recibidoEn);
  if (vuelta === null || ahora === null) return false;
  return ahora >= vuelta;
}

/**
 * Lo que la bandeja dice de un chat callado por el celular: a qué hora de
 * Bogotá vuelve el bot (`HH:MM`), que ya contesta el próximo mensaje, o nada
 * si no se sabe cuándo fue el último eco.
 */
export type VueltaVisible =
  | { tipo: 'sin_hora' }
  | { tipo: 'a_las'; hora: string }
  | { tipo: 'proximo_mensaje' };

const HORA_BOGOTA = new Intl.DateTimeFormat('es-CO', {
  timeZone: 'America/Bogota',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** `HH:MM` en Bogotá, 24 horas. */
export function horaBogota(instante: number): string {
  const partes = HORA_BOGOTA.formatToParts(new Date(instante));
  const h = partes.find((p) => p.type === 'hour')?.value ?? '00';
  const m = partes.find((p) => p.type === 'minute')?.value ?? '00';
  return `${h}:${m}`;
}

export function vueltaVisible(
  ultimoEcoCelular: string | null | undefined,
  ahora: number
): VueltaVisible {
  const vuelta = vueltaDelBot(ultimoEcoCelular ?? null);
  if (vuelta === null) return { tipo: 'sin_hora' };
  if (ahora >= vuelta) return { tipo: 'proximo_mensaje' };
  return { tipo: 'a_las', hora: horaBogota(vuelta) };
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
