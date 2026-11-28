import type { Conversation, Message } from "@/types";

/** Lo que tiene más de esto no es un mensaje que acaba de llegar. */
const RECIENTE_MS = 24 * 60 * 60 * 1000;

/**
 * Cómo cambia la fila de la lista con un INSERT de `messages` en tiempo real.
 *
 * Solo lo NUEVO mueve la vista previa y suma no leídos: un mensaje más viejo
 * que el último del chat —la historia que trae «Importar historial», con su
 * fecha original— no cambia nada. Y lo que tiene más de 24 h no suma no leídos
 * aunque sea el más nuevo del chat. El contador real lo trae el UPDATE de la
 * conversación; esto es solo el adelanto optimista.
 */
export function filaTrasMensaje(
  c: Conversation,
  m: Message,
  activa: boolean,
  ahora: number = Date.now(),
): Conversation {
  const cuando = Date.parse(m.created_at);
  const ultimo = c.last_message_at ? Date.parse(c.last_message_at) : NaN;
  if (Number.isFinite(ultimo) && !(cuando > ultimo)) return c;
  const reciente = Number.isFinite(cuando) && ahora - cuando <= RECIENTE_MS;
  return {
    ...c,
    last_message_text: m.content_text ?? "",
    last_message_at: m.created_at,
    unread_count: activa ? 0 : reciente ? c.unread_count + 1 : c.unread_count,
    // Un eco del celular reinicia la hora en que vuelve el bot.
    ...(m.desde_celular ? { ultimo_eco_celular_at: m.created_at } : {}),
  };
}
