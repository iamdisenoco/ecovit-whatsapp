// ============================================================
// ECOVIT · coexistencia: lo que la bandeja dice de un chat que el celular
// calló. Lo ve el equipo, no el cliente.
// ============================================================

import { vueltaVisible } from "@/lib/whatsapp/webhook/coexistencia";

/** El `t` de `Inbox.aiBanner` (de `useTranslations` o `createTranslator`). */
type Traductor = (clave: string, valores?: Record<string, string>) => string;

/**
 * «Lo atiende una persona desde el celular», y si se sabe, cuándo vuelve el
 * asistente (hora de Bogotá). Con el chat asignado el asistente no vuelve
 * solo: no se promete nada.
 */
export function textoCelular(
  t: Traductor,
  ultimoEco: string | null | undefined,
  asignado: string | null | undefined,
  ahora: number,
): string {
  const base = t("celular");
  if (asignado) return base;
  const vuelta = vueltaVisible(ultimoEco, ahora);
  if (vuelta.tipo === "a_las") {
    return `${base} · ${t("celularVuelveA", { hora: vuelta.hora })}`;
  }
  if (vuelta.tipo === "proximo_mensaje") {
    return `${base} · ${t("celularProximo")}`;
  }
  return base;
}

/**
 * Qué aviso lleva el chat arriba:
 * - `nada`: sin bot y sin celular, o bot activo con el chat ya asignado.
 * - `celular`: solo «Lo atiende una persona desde el celular», sin hora ni
 *   botón. Va cuando el celular calló el chat y no hay bot que retomar (la
 *   cuenta no lo tiene configurado, o todavía no se sabe), o cuando el chat
 *   está asignado y el bot no corre igual.
 * - `pausado`: bot configurado y en pausa aquí; con celular dice la hora.
 * - `activo`: el bot contesta solo en este chat.
 */
export type AvisoChat = "nada" | "celular" | "pausado" | "activo";

export function avisoDelChat(e: {
  /** `null` mientras se lee la cuenta. */
  autoReplyOn: boolean | null;
  pausado: boolean;
  porCelular: boolean;
  asignado: string | null | undefined;
}): AvisoChat {
  if (!e.autoReplyOn) return e.porCelular ? "celular" : "nada";
  if (e.pausado) return "pausado";
  if (e.asignado) return e.porCelular ? "celular" : "nada";
  return "activo";
}
