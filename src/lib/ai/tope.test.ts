import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { revisarTopeMensual } from './tope';

function admin(param: { valor: string | null; definido: boolean } | null, filas: { costo_usd: unknown; created_at: string }[], falla = false) {
  return {
    from: (tabla: string) => {
      let desde = '';
      let hasta = '';
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order']) b[m] = () => b;
      b.gte = (_c: string, v: string) => ((desde = v), b);
      b.lt = (_c: string, v: string) => ((hasta = v), b);
      b.maybeSingle = async () => (falla ? { data: null, error: { message: 'boom' } } : { data: param, error: null });
      b.range = async (from: number, to: number) => ({
        data: tabla === 'ai_usage_log'
          ? filas.filter((f) => f.created_at >= desde && f.created_at < hasta).slice(from, to + 1)
          : [],
        error: null,
      });
      return b;
    },
  } as unknown as SupabaseClient;
}

const AHORA = new Date('2026-05-18T12:00:00Z');

describe('revisarTopeMensual (borrador y playground)', () => {
  it('sin tope definido: no se gasta', async () => {
    const r = await revisarTopeMensual(admin({ valor: null, definido: false }, []), 'acc', AHORA);
    expect(r).toMatchObject({ ok: false, motivo: 'tope_sin_definir' });
  });

  it('con el gasto del mes justo en el tope: no se gasta (>=)', async () => {
    const r = await revisarTopeMensual(
      admin({ valor: '1', definido: true }, [
        { costo_usd: 0.6, created_at: '2026-05-02T00:00:00Z' },
        { costo_usd: '0.4', created_at: '2026-05-10T00:00:00Z' },
      ]),
      'acc',
      AHORA,
    );
    expect(r).toMatchObject({ ok: false, motivo: 'tope_alcanzado' });
    if (!r.ok) expect(r.mensaje).toMatch(/tope de gasto/);
  });

  it('lo de abril (en Bogotá) no cuenta para mayo', async () => {
    const r = await revisarTopeMensual(
      admin({ valor: '1', definido: true }, [
        { costo_usd: 5, created_at: '2026-05-01T04:59:00Z' },
        { costo_usd: 0.2, created_at: '2026-05-01T05:00:00Z' },
      ]),
      'acc',
      AHORA,
    );
    expect(r).toEqual({ ok: true, gastadoUsd: 0.2, topeUsd: 1 });
  });

  it('si no se puede leer, ante la duda no se gasta', async () => {
    const r = await revisarTopeMensual(admin(null, [], true), 'acc', AHORA);
    expect(r).toMatchObject({ ok: false, motivo: 'error' });
  });
});
