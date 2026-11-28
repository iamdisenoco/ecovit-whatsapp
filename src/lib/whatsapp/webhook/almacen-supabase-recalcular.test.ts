// `recalcularChat` contra un doble de PostgREST que APLICA los filtros, el
// orden y el tope: si la consulta pide mal, la prueba falla.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AlmacenSupabase } from './almacen-supabase';

type Fila = Record<string, unknown>;

function valor(fila: Fila, columna: string): unknown {
  const json = /^(\w+)->>(\w+)$/.exec(columna);
  if (json) {
    const v = (fila[json[1]] as Fila | undefined)?.[json[2]];
    return v === undefined || v === null ? null : String(v);
  }
  return fila[columna] ?? null;
}

const comparar = (a: unknown, b: unknown) => {
  const x = typeof a === 'string' ? Date.parse(a) : NaN;
  const y = typeof b === 'string' ? Date.parse(b) : NaN;
  if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};

/** Una condición `col.op.valor` de `.or()`. */
function cumpleOr(fila: Fila, expr: string): boolean {
  return expr.split(',').some((parte) => {
    const [col, op, ...resto] = parte.split('.');
    const v = resto.join('.');
    if (op === 'eq') return String(valor(fila, col)) === v;
    if (op === 'is') return v === 'true' ? valor(fila, col) === true : valor(fila, col) === null;
    throw new Error(`or no soportado: ${parte}`);
  });
}

function base(tablas: Record<string, Fila[]>, antesDeEscribir?: (tabla: string) => void) {
  const escrituras: Array<{ tabla: string; metodo: string }> = [];
  const db = {
    from(tabla: string) {
      const filtros: Array<(f: Fila) => boolean> = [];
      let orden: { col: string; asc: boolean } | null = null;
      let tope = Infinity;
      let metodo: 'select' | 'update' | 'delete' = 'select';
      let cambios: Fila = {};
      let cabeza = false;
      const b: Record<string, unknown> = {};
      const filtro = (fn: (v: unknown, x: unknown) => boolean) => (c: string, x: unknown) => {
        filtros.push((f) => fn(valor(f, c), x));
        return b;
      };
      b.eq = filtro((v, x) => v !== null && comparar(v, x) === 0 && String(v) !== '' );
      b.neq = filtro((v, x) => v === null || comparar(v, x) !== 0);
      b.is = filtro((v, x) => (x === null ? v === null : v === x));
      b.lt = filtro((v, x) => v !== null && comparar(v, x) < 0);
      b.lte = filtro((v, x) => v !== null && comparar(v, x) <= 0);
      b.gt = filtro((v, x) => v !== null && comparar(v, x) > 0);
      b.in = filtro((v, x) => (x as unknown[]).includes(v));
      b.or = (expr: string) => {
        filtros.push((f) => cumpleOr(f, expr));
        return b;
      };
      b.select = (_c?: string, o?: { head?: boolean }) => {
        cabeza = !!o?.head;
        return b;
      };
      b.order = (col: string, o: { ascending: boolean }) => {
        orden = { col, asc: o.ascending };
        return b;
      };
      b.limit = (n: number) => {
        tope = n;
        return b;
      };
      b.update = (c: Fila) => {
        metodo = 'update';
        cambios = c;
        return b;
      };
      b.delete = () => {
        metodo = 'delete';
        return b;
      };
      const correr = () => {
        if (!(tabla in tablas)) return { data: null, count: null, error: { message: `no existe ${tabla}` } };
        if (metodo !== 'select') {
          antesDeEscribir?.(tabla);
          escrituras.push({ tabla, metodo });
        }
        let filas = tablas[tabla].filter((f) => filtros.every((fn) => fn(f)));
        if (metodo === 'update') {
          // Como el disparador `set_updated_at`.
          for (const f of filas) Object.assign(f, cambios, { updated_at: `2026-11-28T20:00:0${escrituras.length}.000Z` });
          return { data: filas.map((f) => ({ id: f.id })), error: null };
        }
        if (metodo === 'delete') {
          tablas[tabla] = tablas[tabla].filter((f) => !filas.includes(f));
          return { data: filas.map((f) => ({ id: f.id })), error: null };
        }
        if (orden) {
          const { col, asc } = orden;
          filas = [...filas].sort((a, z) => (asc ? 1 : -1) * comparar(a[col], z[col]));
        }
        filas = filas.slice(0, tope);
        return cabeza ? { data: null, count: filas.length, error: null } : { data: filas, error: null };
      };
      b.maybeSingle = async () => {
        const r = correr();
        return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data };
      };
      b.then = (ok: (v: unknown) => unknown) => ok(correr());
      return b;
    },
  };
  return { db: db as unknown as SupabaseClient, tablas, escrituras };
}

const CORTE = '2026-11-01T00:00:00.000Z';
const SINC = '2026-10-31T23:50:00.000Z';

function chat(extra: Fila = {}): Fila {
  return {
    id: 'c',
    status: 'closed',
    assigned_agent_id: null,
    asignado_por: null,
    ai_autoreply_disabled: false,
    ai_handoff_summary: null,
    ai_reply_count: 0,
    created_at: '2026-06-01T10:00:00+00:00',
    closed_at: `${SINC.slice(0, 19)}+00:00`,
    updated_at: '2026-11-28T10:00:00.123456+00:00',
    last_message_text: '[Unsupported message]',
    last_message_at: SINC,
    first_inbound_at: '2026-06-01T10:00:00+00:00',
    last_inbound_at: SINC,
    last_reply_at: SINC,
    ...extra,
  };
}

const m = (created_at: string, sender_type: string, extra: Fila = {}): Fila => ({
  conversation_id: 'c',
  created_at,
  sender_type,
  status: 'delivered',
  ai_generated: false,
  content_type: 'text',
  content_text: `de ${created_at.slice(0, 10)}`,
  ...extra,
});

/** Desordenados a propósito: el orden lo tiene que pedir la consulta. */
const mensajes = () => [
  m('2026-06-05T10:00:00Z', 'customer'),
  m('2026-06-12T10:00:00Z', 'agent', { status: 'failed' }),
  m('2026-06-01T10:00:00Z', 'customer'),
  m('2026-06-10T10:00:00Z', 'agent', { status: 'read' }),
  m('2026-06-03T10:00:00Z', 'customer', { conversation_id: 'otro' }),
  m('2026-07-01T10:00:00Z', 'customer', { conversation_id: 'otro' }),
];

const vacias = () => ({ ai_usage_log: [], flow_runs: [], notifications: [], bitacora: [], avisos: [] });

describe('recalcularChat (doble que filtra de verdad)', () => {
  it('toma el último mensaje del chat, sin los fallidos como respuesta', async () => {
    const d = base({ conversations: [chat()], messages: mensajes(), ...vacias() });
    const r = await new AlmacenSupabase(d.db).recalcularChat('c', CORTE);
    expect(r).toBe('recalculado');
    expect(d.tablas.conversations[0]).toMatchObject({
      last_message_text: 'de 2026-06-12',
      last_message_at: '2026-06-12T10:00:00Z',
      first_inbound_at: '2026-06-01T10:00:00Z',
      last_inbound_at: '2026-06-05T10:00:00Z',
      last_reply_at: '2026-06-10T10:00:00Z',
      created_at: '2026-06-01T10:00:00Z',
      closed_at: '2026-06-12T10:00:00Z',
    });
  });

  it('si entra un mensaje entre la lectura y la escritura, gana el nuevo', async () => {
    let entro = false;
    const d = base({ conversations: [chat()], messages: mensajes(), ...vacias() }, (tabla) => {
      if (tabla !== 'conversations' || entro) return;
      entro = true;
      // Lo que hace un entrante vivo: su fila y el disparador mueven el chat.
      Object.assign(d.tablas.conversations[0], {
        last_message_text: 'nuevo',
        last_message_at: '2026-11-28T19:00:00Z',
        last_inbound_at: '2026-11-28T19:00:00Z',
        updated_at: '2026-11-28T19:00:00.5+00:00',
      });
    });
    const r = await new AlmacenSupabase(d.db).recalcularChat('c', CORTE);
    expect(r).toBe('otro_escribio');
    expect(d.tablas.conversations[0]).toMatchObject({
      last_message_text: 'nuevo',
      last_message_at: '2026-11-28T19:00:00Z',
      last_inbound_at: '2026-11-28T19:00:00Z',
    });
  });

  it('si ya estaba bien no escribe (no mueve updated_at)', async () => {
    const d = base({ conversations: [chat()], messages: mensajes(), ...vacias() });
    const a = new AlmacenSupabase(d.db);
    await a.recalcularChat('c', CORTE);
    // Testigo: la primera sí escribió.
    expect(d.escrituras).toHaveLength(1);
    const marca = d.tablas.conversations[0].updated_at;
    expect(await a.recalcularChat('c', CORTE)).toBe('sin_cambios');
    expect(d.escrituras).toHaveLength(1);
    expect(d.tablas.conversations[0].updated_at).toBe(marca);
  });

  describe('chat sin mensajes', () => {
    const casos: Array<[string, Fila, Partial<Record<string, Fila[]>>]> = [
      ['la IA está pausada', { ai_autoreply_disabled: true }, {}],
      ['tiene dueño', { assigned_agent_id: 'v1' }, {}],
      ['alguien lo asignó', { asignado_por: 'p1' }, {}],
      ['tiene bitácora', {}, { bitacora: [{ entidad_id: 'c' }] }],
      ['tiene un aviso', {}, { avisos: [{ datos: { conversacion_id: 'c' } }] }],
      ['lo creó el webhook', { created_at: '2026-11-20T10:00:00+00:00' }, {}],
    ];
    for (const [nombre, extra, colgado] of casos)
      it(`no se borra si ${nombre}: queda sin vista previa`, async () => {
        const d = base({ conversations: [chat(extra)], messages: [], ...vacias(), ...colgado });
        expect(await new AlmacenSupabase(d.db).recalcularChat('c', CORTE)).toBe('vacio');
        expect(d.tablas.conversations[0]).toMatchObject({ last_message_text: null, last_inbound_at: null });
      });

    it('testigo: sin nada colgado y creado por la historia, se borra', async () => {
      const d = base({
        conversations: [chat()],
        messages: [],
        ...vacias(),
        // Lo de OTRO chat no cuenta.
        bitacora: [{ entidad_id: 'otro' }],
        avisos: [{ datos: { conversacion_id: 'otro' } }],
      });
      expect(await new AlmacenSupabase(d.db).recalcularChat('c', CORTE)).toBe('borrado');
      expect(d.tablas.conversations).toHaveLength(0);
    });

    it('si una tabla no se puede consultar, no se borra', async () => {
      const t = { conversations: [chat()], messages: [], ...vacias() } as Record<string, Fila[]>;
      delete t.avisos;
      const d = base(t);
      expect(await new AlmacenSupabase(d.db).recalcularChat('c', CORTE)).toBe('vacio');
    });
  });
});
