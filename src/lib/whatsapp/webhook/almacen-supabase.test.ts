// El almacén de verdad contra un doble de PostgREST: que hable con la 0115 como
// la 0115 espera (el doble en memoria no lo prueba).
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AlmacenSupabase } from './almacen-supabase';
import { fetchConTope } from './cliente-servicio';

vi.mock('../message-status-sync', () => ({
  applyMessageStatus: vi.fn(async () => []),
  applyPendingMessageStatuses: vi.fn(async () => []),
}));

interface Llamada {
  tabla?: string;
  rpc?: string;
  args?: unknown;
  metodo: string;
  filtros: Array<[string, unknown]>;
  columnas?: string;
  orden?: Array<[string, unknown]>;
  tope?: number;
}

/** Doble mínimo: cada `from` devuelve filas según la tabla y registra lo que se pidió. */
function doble(
  filas: Record<string, unknown[]>,
  rpc: Record<string, unknown> = {}
) {
  const llamadas: Llamada[] = [];
  const db = {
    rpc: vi.fn(async (nombre: string, args: unknown) => {
      llamadas.push({ rpc: nombre, args, metodo: 'rpc', filtros: [] });
      return { data: rpc[nombre] ?? null, error: null };
    }),
    from: (tabla: string) => {
      const ll: Llamada = { tabla, metodo: 'select', filtros: [] };
      llamadas.push(ll);
      const b: Record<string, unknown> = {};
      const filtro = (m: string) => (c: string, v: unknown) => {
        ll.filtros.push([`${m}:${c}`, v]);
        return b;
      };
      for (const m of ['eq', 'is', 'in', 'gte', 'gt', 'lt']) b[m] = filtro(m);
      b.select = (c?: string) => {
        ll.columnas = c;
        return b;
      };
      b.order = (c: string, o: unknown) => {
        (ll.orden ??= []).push([c, o]);
        return b;
      };
      b.limit = (n: number) => {
        ll.tope = n;
        return b;
      };
      b.insert = (row: unknown) => {
        ll.metodo = 'insert';
        ll.args = row;
        return b;
      };
      b.single = async () => ({ data: { id: 'nueva' }, error: null });
      b.update = (row: unknown) => {
        ll.metodo = 'update';
        ll.args = row;
        return b;
      };
      const resultado = () => ({
        data: ll.metodo === 'update' ? [{ id: 'u' }] : (filas[tabla] ?? []),
        error: null,
      });
      b.maybeSingle = async () => ({
        data: (filas[tabla] ?? [])[0] ?? null,
        error: null,
      });
      b.then = (r: (v: unknown) => unknown) => r(resultado());
      return b;
    },
  };
  return { db: db as unknown as SupabaseClient, llamadas };
}

describe('AlmacenSupabase con la 0115', () => {
  it('un chat que crea la historia se inserta cerrado y en sus fechas reales', async () => {
    const { db, llamadas } = doble({ conversations: [] });
    await new AlmacenSupabase(db).buscarOCrearConversacion(
      { accountId: 'a', usuarioId: 'u', conectadoDesde: null },
      'contacto',
      {
        creadaEn: '2026-06-03T10:00:00.000Z',
        cerradaEn: '2026-06-05T16:00:00.000Z',
      }
    );
    const insert = llamadas.find((l) => l.metodo === 'insert');
    expect(insert?.args).toMatchObject({
      status: 'closed',
      created_at: '2026-06-03T10:00:00.000Z',
      closed_at: '2026-06-05T16:00:00.000Z',
    });
  });

  it('ajustarFechasHistoria solo corre las fechas hacia afuera y no toca un chat reabierto', async () => {
    const { db, llamadas } = doble({});
    await new AlmacenSupabase(db).ajustarFechasHistoria(
      'c',
      '2026-06-01T00:00:00.000Z',
      '2026-06-09T00:00:00.000Z'
    );
    const [creado, cerrado] = llamadas.filter((l) => l.metodo === 'update');
    expect(creado.args).toEqual({ created_at: '2026-06-01T00:00:00.000Z' });
    expect(creado.filtros).toContainEqual([
      'gt:created_at',
      '2026-06-01T00:00:00.000Z',
    ]);
    expect(cerrado.args).toEqual({ closed_at: '2026-06-09T00:00:00.000Z' });
    expect(cerrado.filtros).toContainEqual(['eq:status', 'closed']);
    expect(cerrado.filtros).toContainEqual([
      'lt:closed_at',
      '2026-06-09T00:00:00.000Z',
    ]);
  });

  it('tomarEvento devuelve el texto de registrar_evento_wa (en_curso incluido)', async () => {
    for (const estado of ['nuevo', 'reintento', 'procesado', 'en_curso']) {
      const { db } = doble({}, { registrar_evento_wa: estado });
      expect(
        await new AlmacenSupabase(db).tomarEvento('e', 'mensaje_entrante')
      ).toBe(estado);
    }
  });

  it('tomarEvento no adivina ante una respuesta rara', async () => {
    const { db } = doble({}, { registrar_evento_wa: true });
    await expect(new AlmacenSupabase(db).tomarEvento('e', 't')).rejects.toThrow(
      /inesperado/
    );
  });

  it('conciliar: si el wamid ya existe no toca ninguna fila', async () => {
    const { db, llamadas } = doble({ messages: [{ id: 'ya' }] });
    expect(
      await new AlmacenSupabase(db).conciliarEnvioPendiente(
        'c',
        'Hola',
        'wamid.X'
      )
    ).toBe('ninguno');
    expect(llamadas.some((l) => l.metodo === 'update')).toBe(false);
  });

  it('conciliar: dos pendientes con el mismo texto = ambiguo, sin update', async () => {
    const { db, llamadas } = doble({ messages: [{ id: 'p1' }, { id: 'p2' }] });
    const a = new AlmacenSupabase(db);
    // El primer `messages` (buscar por wamid) da vacío: se simula con maybeSingle de otra tabla.
    a.buscarMensajePorWamid = async () => null;
    expect(await a.conciliarEnvioPendiente('c', 'Hola', 'wamid.X')).toBe(
      'ambiguo'
    );
    expect(llamadas.some((l) => l.metodo === 'update')).toBe(false);
    const busqueda = llamadas.find(
      (l) => l.tabla === 'messages' && l.filtros.length > 0
    )!;
    expect(busqueda.filtros).toContainEqual([
      'in:status',
      ['sending', 'incierto'],
    ]);
  });

  it('callar y despertar van por las funciones con bitácora', async () => {
    const { db, llamadas } = doble({});
    const a = new AlmacenSupabase(db);
    await a.callarBot('conv-1', 'wamid.C', 'nota');
    await a.despertarBot('conv-1', 'nota');
    expect(llamadas.filter((l) => l.rpc)).toEqual([
      expect.objectContaining({
        rpc: 'callar_bot_por_celular_wa',
        args: {
          p_conversacion: 'conv-1',
          p_mensaje_id: 'wamid.C',
          p_motivo: 'nota',
        },
      }),
      expect.objectContaining({
        rpc: 'despertar_bot_por_celular_wa',
        args: { p_conversacion: 'conv-1', p_motivo: 'nota' },
      }),
    ]);
  });

  it('ultimoEcoCelular: el más reciente con desde_celular, columnas nombradas', async () => {
    const { db, llamadas } = doble({
      messages: [{ created_at: '2026-11-20T12:00:00Z' }],
    });
    expect(await new AlmacenSupabase(db).ultimoEcoCelular('c-1')).toBe(
      '2026-11-20T12:00:00Z'
    );
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]).toMatchObject({
      tabla: 'messages',
      columnas: 'created_at',
      filtros: [
        ['eq:conversation_id', 'c-1'],
        ['eq:desde_celular', true],
      ],
      orden: [['created_at', { ascending: false }]],
      tope: 1,
    });
  });

  it('ultimoEcoCelular: sin eco devuelve null', async () => {
    const { db } = doble({ messages: [] });
    expect(await new AlmacenSupabase(db).ultimoEcoCelular('c-1')).toBeNull();
  });

  it('guardarReferencia escribe la conversación y la cuenta del proveedor', async () => {
    const { db, llamadas } = doble({});
    await new AlmacenSupabase(db).guardarReferencia('conv-1', {
      conversacionId: 'z-conv',
      cuentaId: 'z-cta',
    });
    expect(llamadas[0].args).toEqual({
      proveedor_conversacion_id: 'z-conv',
      proveedor_cuenta_id: 'z-cta',
    });
  });
});

describe('fetchConTope', () => {
  it('corta una llamada que no contesta', async () => {
    const colgado = ((_: unknown, init?: RequestInit) =>
      new Promise((_r, rechazar) =>
        init?.signal?.addEventListener('abort', () =>
          rechazar(new Error('abortado'))
        )
      )) as typeof fetch;
    const inicio = Date.now();
    await expect(fetchConTope(50, colgado)('http://x')).rejects.toThrow(
      'abortado'
    );
    expect(Date.now() - inicio).toBeLessThan(1000);
  });
});
