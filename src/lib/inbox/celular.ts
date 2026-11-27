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
