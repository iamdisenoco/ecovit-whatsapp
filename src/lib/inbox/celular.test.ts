import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import es from "../../../messages/es.json";
import { textoCelular } from "./celular";

const t = createTranslator({
  locale: "es",
  messages: es,
  namespace: "Inbox.aiBanner",
}) as unknown as (clave: string, valores?: Record<string, string>) => string;

const ECO = "2026-11-20T21:10:00Z"; // 16:10 en Bogotá

describe("el aviso del chat callado por el celular", () => {
  it("antes de las 4 h: la hora de Bogotá en que vuelve el asistente", () => {
    expect(textoCelular(t, ECO, null, Date.parse("2026-11-20T22:00:00Z"))).toBe(
      "Lo atiende una persona desde el celular · el asistente vuelve a contestar desde las 20:10",
    );
  });

  it("pasadas las 4 h: contesta el próximo mensaje", () => {
    expect(textoCelular(t, ECO, null, Date.parse("2026-11-21T01:10:00Z"))).toBe(
      "Lo atiende una persona desde el celular · el asistente contesta el próximo mensaje del cliente",
    );
  });

  it("sin eco o con el chat asignado: solo quién lo atiende", () => {
    expect(textoCelular(t, null, null, Date.now())).toBe(
      "Lo atiende una persona desde el celular",
    );
    expect(textoCelular(t, ECO, "u-1", Date.parse("2026-11-20T22:00:00Z"))).toBe(
      "Lo atiende una persona desde el celular",
    );
  });
});
