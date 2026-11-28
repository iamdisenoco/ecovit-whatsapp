// ============================================================
// El bucle del botón «Importar historial», sin React, para poder probarlo.
//
// Llama tramo a tramo hasta `terminado`. Cada cursor bueno se guarda (en la
// pantalla, en el estado y en localStorage): si un tramo falla, se puede
// «Seguir» desde ahí en vez de empezar de cero. Los textos no nombran al
// proveedor.
// ============================================================

export interface TramoHistorial {
  procesadas: number;
  mensajes: number;
  listas: number;
  /** Nombres de contactos completados en el tramo (falta en un servidor viejo). */
  nombres?: number;
  cursor: string | null;
  terminado: boolean;
  esperarMs: number | null;
}

export interface Avance {
  listas: number;
  nuevos: number;
  nombres: number;
  esperando: boolean;
}

export interface DependenciasImportacion {
  /** Un tramo: lanza con el texto para la persona si falla. */
  pedirTramo: (cursor: string | null) => Promise<TramoHistorial>;
  /** Se llama con cada cursor bueno; `null` al terminar (no queda nada que seguir). */
  guardarCursor: (cursor: string | null) => void;
  alAvanzar: (a: Avance) => void;
  esperar?: (ms: number) => Promise<void>;
  maxTramos?: number;
}

export type FinImportacion =
  | { ok: true; listas: number; nuevos: number; nombres: number }
  | {
      ok: false;
      error: string;
      cursor: string | null;
      listas: number;
      nuevos: number;
      nombres: number;
    };

const numero = (n: number) => n.toLocaleString('es-CO');
export const textoChats = (n: number) =>
  `${numero(n)} ${n === 1 ? 'chat' : 'chats'}`;
export const textoMensajes = (n: number) =>
  `${numero(n)} ${n === 1 ? 'mensaje nuevo' : 'mensajes nuevos'}`;
export const textoNombres = (n: number) =>
  `${numero(n)} ${n === 1 ? 'nombre de contacto' : 'nombres de contactos'}`;

/** «Listo: N chats revisados, M mensajes nuevos y K nombres de contactos.» */
export function textoListo(listas: number, nuevos: number, nombres: number) {
  return `Listo: ${textoChats(listas)} revisados, ${textoMensajes(nuevos)} y ${textoNombres(nombres)}.`;
}

export async function correrImportacion(
  desde: string | null,
  d: DependenciasImportacion
): Promise<FinImportacion> {
  const esperar =
    d.esperar ??
    ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  let cursor = desde;
  let nuevos = 0;
  let nombres = 0;
  let listas = 0;
  try {
    for (let i = 0; i < (d.maxTramos ?? 2000); i++) {
      const t = await d.pedirTramo(cursor);
      nuevos += t.mensajes;
      nombres += t.nombres ?? 0;
      listas = t.listas;
      if (t.terminado) {
        d.guardarCursor(null);
        return { ok: true, listas, nuevos, nombres };
      }
      cursor = t.cursor;
      d.guardarCursor(cursor);
      if (t.esperarMs) {
        d.alAvanzar({ listas, nuevos, nombres, esperando: true });
        await esperar(t.esperarMs);
      }
      d.alAvanzar({ listas, nuevos, nombres, esperando: false });
    }
    throw new Error('Se detuvo antes de terminar.');
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      cursor,
      listas,
      nuevos,
      nombres,
    };
  }
}
