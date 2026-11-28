import { describe, expect, it } from "vitest";
import type { Conversation, Message } from "@/types";
import { filaTrasMensaje } from "./vista-previa";

const AHORA = Date.parse("2026-11-28T12:00:00.000Z");

const conv = {
  id: "c1",
  last_message_text: "vivo",
  last_message_at: "2026-11-28T11:00:00.000Z",
  unread_count: 2,
} as Conversation;

const msg = (created_at: string, extra: Partial<Message> = {}) =>
  ({
    id: "m",
    conversation_id: "c1",
    content_text: "texto",
    created_at,
    desde_celular: false,
    ...extra,
  }) as Message;

describe("filaTrasMensaje", () => {
  it("lo nuevo mueve la vista previa y suma un no leído", () => {
    const f = filaTrasMensaje(conv, msg("2026-11-28T11:59:00.000Z"), false, AHORA);
    expect(f.unread_count).toBe(3);
    expect(f.last_message_text).toBe("texto");
  });

  it("la historia importada (más vieja que el último) no cambia nada", () => {
    const f = filaTrasMensaje(conv, msg("2026-06-03T10:00:00.000Z"), false, AHORA);
    expect(f).toBe(conv);
  });

  it("lo de hace más de 24 h no suma no leídos aunque sea lo más nuevo del chat", () => {
    const vacio = { ...conv, last_message_at: undefined };
    const f = filaTrasMensaje(vacio, msg("2026-06-03T10:00:00.000Z"), false, AHORA);
    expect(f.unread_count).toBe(2);
    expect(f.last_message_at).toBe("2026-06-03T10:00:00.000Z");
  });

  it("en el chat abierto, el contador queda en cero", () => {
    const f = filaTrasMensaje(conv, msg("2026-11-28T11:59:00.000Z"), true, AHORA);
    expect(f.unread_count).toBe(0);
  });
});
