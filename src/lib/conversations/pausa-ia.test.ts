import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ejecutarPausaIa, leerAccionPausaIa } from './pausa-ia';

type Llamada = { fn: string; args: Record<string, unknown> };

/** Un doble de la base que solo conoce las RPC; cualquier `from()` es un defecto. */
function dobleDb(respuestas: Record<string, { data?: unknown; error?: { message: string } }>) {
  const llamadas: Llamada[] = [];
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      llamadas.push({ fn, args });
      const r = respuestas[fn] ?? { data: null };
      return { data: r.data ?? null, error: r.error ?? null };
    },
    from: () => {
      throw new Error('escritura directa: tiene que ir por función');
    },
  };
  return { db: db as unknown as SupabaseClient, llamadas };
}

describe('leerAccionPausaIa', () => {
  it('sin marca no hay acción (p_visto obligatorio)', () => {
    expect(leerAccionPausaIa({ accion: 'tomar' })).toBeNull();
    expect(leerAccionPausaIa({ accion: 'retomar', visto: '' })).toBeNull();
    expect(leerAccionPausaIa({ paused: true })).toBeNull();
  });
  it('lee tomar y retomar', () => {
    expect(leerAccionPausaIa({ accion: 'retomar', visto: 'm1' })).toEqual({
      accion: 'retomar',
      visto: 'm1',
    });
    expect(
      leerAccionPausaIa({ accion: 'tomar', visto: 'm1', asignado_visto: null })
    ).toEqual({ accion: 'tomar', visto: 'm1', asignadoVisto: null });
  });
});

describe('ejecutarPausaIa', () => {
  it('retomar: reanudar_ia_conversacion con la marca que vio la pantalla, y queda sin dueño', async () => {
    const { db, llamadas } = dobleDb({ reanudar_ia_conversacion: { data: 'm2' } });
    const r = await ejecutarPausaIa(db, 'c1', 'u1', { accion: 'retomar', visto: 'm1' });
    expect(llamadas).toEqual([
      { fn: 'reanudar_ia_conversacion', args: { p_conversacion: 'c1', p_visto: 'm1' } },
    ]);
    expect(r).toEqual({ ok: true, pausada: false, asignado: null, actualizadoEn: 'm2' });
  });

  it('retomar: si la función rechaza (otra persona lo tiene), se devuelve su mensaje', async () => {
    const { db } = dobleDb({
      reanudar_ia_conversacion: { error: { message: 'ahora la tiene Ana' } },
    });
    const r = await ejecutarPausaIa(db, 'c1', 'u1', { accion: 'retomar', visto: 'm1' });
    expect(r).toEqual({ ok: false, status: 409, error: 'ahora la tiene Ana' });
  });

  it('tomar sin dueño: toma con la marca vista y después pausa', async () => {
    const { db, llamadas } = dobleDb({ tomar_conversacion: { data: 'm2' } });
    const r = await ejecutarPausaIa(db, 'c1', 'u1', {
      accion: 'tomar',
      visto: 'm1',
      asignadoVisto: null,
    });
    expect(llamadas.map((l) => l.fn)).toEqual(['tomar_conversacion', 'pausar_ia_conversacion']);
    expect(llamadas[0].args).toEqual({ p_conversacion: 'c1', p_visto: 'm1' });
    expect(r).toEqual({ ok: true, pausada: true, asignado: 'u1', actualizadoEn: 'm2' });
  });

  it('tomar rechazado: no se pausa nada', async () => {
    const { db, llamadas } = dobleDb({
      tomar_conversacion: { error: { message: 'La conversación ya la tiene Ana.' } },
    });
    const r = await ejecutarPausaIa(db, 'c1', 'u1', {
      accion: 'tomar',
      visto: 'm1',
      asignadoVisto: null,
    });
    expect(llamadas.map((l) => l.fn)).toEqual(['tomar_conversacion']);
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it('tomar un chat que ya tiene dueño: solo pausa, no se lo quita', async () => {
    const { db, llamadas } = dobleDb({});
    const r = await ejecutarPausaIa(db, 'c1', 'u1', {
      accion: 'tomar',
      visto: 'm1',
      asignadoVisto: 'u9',
    });
    expect(llamadas.map((l) => l.fn)).toEqual(['pausar_ia_conversacion']);
    expect(r).toMatchObject({ ok: true, asignado: 'u9' });
  });
});
