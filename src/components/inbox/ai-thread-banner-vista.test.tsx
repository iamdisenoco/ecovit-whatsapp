// El aviso del chat que calló el celular se ve aunque la cuenta no tenga el
// bot configurado o el chat esté asignado (visto en producción el 27-nov).
import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "next-intl";
import es from "../../../messages/es.json";
import { avisoDelChat } from "@/lib/inbox/celular";
import { VistaAiBanner } from "./ai-thread-banner-vista";

const t = createTranslator({
  locale: "es",
  messages: es,
  namespace: "Inbox.aiBanner",
}) as unknown as (clave: string, valores?: Record<string, string>) => string;

const ECO = "2026-11-20T21:10:00Z"; // 16:10 en Bogotá
const AHORA = Date.parse("2026-11-20T22:00:00Z"); // antes de las 4 h

function pintar(e: {
  autoReplyOn: boolean | null;
  pausado: boolean;
  porCelular: boolean;
  asignado: string | null;
}) {
  const html = renderToStaticMarkup(
    React.createElement(VistaAiBanner, {
      aviso: avisoDelChat(e),
      t,
      porCelular: e.porCelular,
      handoffSummary: e.porCelular ? "motivo" : null,
      ultimoEcoCelular: ECO,
      assignedAgentId: e.asignado,
      ahora: AHORA,
      busy: false,
      onToggle: () => {},
    }),
  );
  return { html, texto: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() };
}

describe("el aviso del chat callado por el celular", () => {
  it("celular sin bot: se ve el aviso, sin hora y sin botón", () => {
    for (const autoReplyOn of [false, null]) {
      const { html, texto } = pintar({ autoReplyOn, pausado: true, porCelular: true, asignado: null });
      expect(texto).toBe("Lo atiende una persona desde el celular");
      expect(texto).not.toContain("20:10");
      expect(texto).not.toContain("asistente");
      expect(html).not.toContain("<button");
    }
  });

  it("celular con bot: se ve con la hora y con «Retomar IA»", () => {
    const { html, texto } = pintar({ autoReplyOn: true, pausado: true, porCelular: true, asignado: null });
    expect(texto).toContain(
      "Lo atiende una persona desde el celular · el asistente vuelve a contestar desde las 20:10",
    );
    expect(texto).toContain("Retomar IA");
    expect(html).toContain("<button");
  });

  it("sin celular y sin bot: no se ve nada", () => {
    expect(pintar({ autoReplyOn: false, pausado: false, porCelular: false, asignado: null }).html).toBe("");
    expect(pintar({ autoReplyOn: null, pausado: true, porCelular: false, asignado: "u-1" }).html).toBe("");
  });

  it("celular y asignado: se ve el aviso, con bot o sin él", () => {
    for (const autoReplyOn of [false, null, true]) {
      const { texto } = pintar({ autoReplyOn, pausado: false, porCelular: true, asignado: "u-1" });
      expect(texto).toContain("Lo atiende una persona desde el celular");
      expect(texto).not.toContain("20:10");
    }
  });

  it("con bot y sin celular sigue como antes", () => {
    expect(pintar({ autoReplyOn: true, pausado: false, porCelular: false, asignado: null }).texto).toContain(
      "Tomar el control",
    );
    expect(pintar({ autoReplyOn: true, pausado: false, porCelular: false, asignado: "u-1" }).html).toBe("");
  });
});
