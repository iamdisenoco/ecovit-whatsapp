import { describe, expect, it } from 'vitest';
import { correrImportacion, type TramoHistorial } from './historial-cliente';

const tramo = (n: number, fin = false): TramoHistorial => ({
  procesadas: 1,
  mensajes: 10,
  listas: n,
  cursor: fin ? null : `c${n}`,
  terminado: fin,
  esperarMs: null,
});

describe('correrImportacion', () => {
  it('si un tramo falla, devuelve el último cursor bueno y se sigue desde ahí', async () => {
    const pedidos: Array<string | null> = [];
    const guardados: Array<string | null> = [];
    let fallar = true;
    const pedirTramo = async (c: string | null) => {
      pedidos.push(c);
      if (c === null) return tramo(1);
      if (c === 'c1') return tramo(2);
      if (c === 'c2' && fallar) throw new Error('Se cortó la conexión.');
      return tramo(3, true);
    };
    const deps = {
      pedirTramo,
      guardarCursor: (c: string | null) => guardados.push(c),
      alAvanzar: () => {},
    };
    const r1 = await correrImportacion(null, deps);
    expect(r1).toMatchObject({ ok: false, cursor: 'c2', listas: 2 });
    expect(guardados.at(-1)).toBe('c2');

    fallar = false;
    pedidos.length = 0;
    const r2 = await correrImportacion(r1.ok ? null : r1.cursor, deps);
    expect(r2).toMatchObject({ ok: true, listas: 3 });
    // «Seguir» no vuelve a empezar: arranca en c2.
    expect(pedidos).toEqual(['c2']);
    // Al terminar no queda nada que seguir.
    expect(guardados.at(-1)).toBeNull();
  });

  it('respeta la espera que pide el servidor', async () => {
    const esperas: number[] = [];
    const r = await correrImportacion(null, {
      pedirTramo: async (c) =>
        c === null ? { ...tramo(1), esperarMs: 3000 } : tramo(2, true),
      guardarCursor: () => {},
      alAvanzar: () => {},
      esperar: async (ms) => {
        esperas.push(ms);
      },
    });
    expect(r.ok).toBe(true);
    expect(esperas).toEqual([3000]);
  });
});
