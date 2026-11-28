// La fase «contactos» del historial: la agenda del número completa los nombres
// de los contactos que YA existen en la app. Cada prueba lleva su testigo en el
// informe del PR (el defecto que se inyectó para verla en rojo).
import { describe, expect, it } from 'vitest';
import { AlmacenMemoria } from '../webhook/almacen-memoria';
import {
  completarNombresSupabase,
  nombreUtil,
} from '../webhook/contactos-supabase';
import type { Inquilino } from '../webhook/almacen';
import {
  CONTACTOS_POR_PAGINA,
  FuenteHistorialZernio,
  LimiteDeVelocidad,
  codificarCursor,
  importarHistorial,
  leerCursor,
  type ContactoRemoto,
  type ConversacionRemota,
  type FuenteHistorial,
  type MensajeRemoto,
} from './historial';

const CUENTA = 'cuenta-zernio';
const INQ: Inquilino = {
  accountId: 'cuenta-1',
  usuarioId: 'usuario-1',
  conectadoDesde: '2026-11-01T00:00:00.000Z',
};

/** Una bandeja sin chats y con una agenda paginada por `skip`. */
class AgendaDoble implements FuenteHistorial {
  conversacionesRemotas: ConversacionRemota[] = [];
  mensajesRemotos = new Map<string, MensajeRemoto[]>();
  agenda: ContactoRemoto[] = [];
  saltosPedidos: number[] = [];
  limitar: { veces: number; esperaMs: number } | null = null;

  async conversaciones(_c: string, cursor: string | null, limite: number) {
    const desde = cursor ? Number(cursor) : 0;
    const fin = desde + limite;
    return {
      items: this.conversacionesRemotas.slice(desde, fin),
      siguiente: fin < this.conversacionesRemotas.length ? String(fin) : null,
    };
  }
  async mensajes(_c: string, conv: string) {
    return { items: this.mensajesRemotos.get(conv) ?? [], siguiente: null };
  }
  async contactos(_c: string, salto: number, limite: number) {
    if (this.limitar && this.limitar.veces > 0) {
      this.limitar.veces--;
      throw new LimiteDeVelocidad(this.limitar.esperaMs);
    }
    this.saltosPedidos.push(salto);
    const fin = salto + limite;
    return {
      items: this.agenda.slice(salto, fin),
      siguiente: fin < this.agenda.length ? fin : null,
    };
  }
}

const tel = (i: number) => `5730000${String(i).padStart(5, '0')}`;

function agenda(n: number, nombre = (i: number) => `Agenda ${i}`) {
  const z = new AgendaDoble();
  for (let i = 0; i < n; i++)
    z.agenda.push({ id: `k${i}`, nombre: nombre(i), telefono: tel(i) });
  return z;
}

function almacen(contactos: Array<{ telefono: string; nombre: string }> = []) {
  const a = new AlmacenMemoria(INQ);
  contactos.forEach((c, i) =>
    a.contactos.push({ id: `app-${i}`, waUserId: null, ...c })
  );
  return a;
}

const base = { cuentaId: CUENTA, ahora: () => 0 };

describe('historial, fase contactos: paginación', () => {
  it('recorre toda la agenda por skip y termina', async () => {
    const z = agenda(250);
    const a = almacen();
    const r = await importarHistorial({ ...base, almacen: a, fuente: z });
    expect(r.terminado).toBe(true);
    expect(r.contactosLeidos).toBe(250);
    expect(z.saltosPedidos).toEqual([0, 100, 200]);
    expect(CONTACTOS_POR_PAGINA).toBe(100);
  });

  it('se corta por tiempo y sigue desde el mismo skip', async () => {
    const z = agenda(250);
    const a = almacen([{ telefono: tel(249), nombre: tel(249) }]);
    let reloj = 0;
    // Cada pedido de contactos «tarda» 15 s: el tramo de 25 s corta a la mitad.
    const original = z.contactos.bind(z);
    z.contactos = async (c, s, l) => {
      reloj += 15_000;
      return original(c, s, l);
    };
    const r1 = await importarHistorial({
      ...base,
      ahora: () => reloj,
      almacen: a,
      fuente: z,
    });
    expect(r1.terminado).toBe(false);
    expect(leerCursor(r1.cursor)).toMatchObject({
      fase: 'contactos',
      saltoContactos: 200,
    });
    const r2 = await importarHistorial({
      ...base,
      ahora: () => reloj,
      almacen: a,
      fuente: z,
      cursor: r1.cursor,
    });
    expect(r2.terminado).toBe(true);
    // Nadie se pidió dos veces ni quedó sin pedir.
    expect(z.saltosPedidos).toEqual([0, 100, 200]);
    expect(r1.nombres + r2.nombres).toBe(1);
    expect(a.contactos[0].nombre).toBe('Agenda 249');
  });

  it('un cursor de antes de la fase de contactos sigue por los chats', () => {
    const viejo = Buffer.from(
      JSON.stringify({ pagina: 'p2', hechas: [], enCurso: null, listas: 3 })
    ).toString('base64url');
    expect(leerCursor(viejo)).toMatchObject({
      pagina: 'p2',
      fase: 'chats',
      saltoContactos: 0,
    });
  });

  it('después de los chats: el contacto que crea la historia recibe su nombre', async () => {
    const z = agenda(0);
    z.conversacionesRemotas.push({
      id: 'conv-1',
      cuentaId: CUENTA,
      plataforma: 'whatsapp',
      participanteId: tel(7),
      // En coexistencia el chat suele traer el teléfono como nombre.
      participanteNombre: `+${tel(7)}`,
      bsuid: null,
    });
    z.mensajesRemotos.set('conv-1', [
      {
        id: 'wamid.1',
        creadoEn: '2026-06-03T10:00:00.000Z',
        saliente: false,
        texto: 'hola',
        adjuntos: [],
        estadoEntrega: null,
        borrado: false,
      },
    ]);
    z.agenda.push({ id: 'k7', nombre: 'Ferretería Ruiz', telefono: tel(7) });
    const a = almacen();
    const r = await importarHistorial({ ...base, almacen: a, fuente: z });
    expect(r.terminado).toBe(true);
    expect(r.nombres).toBe(1);
    expect(a.contactos).toHaveLength(1);
    expect(a.contactos[0].nombre).toBe('Ferretería Ruiz');
  });
});

describe('historial, fase contactos: la regla del nombre', () => {
  it('cruza por teléfono normalizado y solo con ese teléfono', async () => {
    const z = new AgendaDoble();
    z.agenda.push(
      { id: 'k1', nombre: 'Doña Marta', telefono: '573001112233' },
      { id: 'k2', nombre: 'Otro', telefono: '573009998877' }
    );
    // En la app quedó con el relleno del teléfono, escrito con espacios.
    const a = almacen([
      { telefono: '573001112233', nombre: '+57 300 111 2233' },
      { telefono: '573005556677', nombre: '' },
    ]);
    const r = await importarHistorial({ ...base, almacen: a, fuente: z });
    expect(r.nombres).toBe(1);
    expect(a.contactos.map((c) => c.nombre)).toEqual(['Doña Marta', '']);
  });

  it('nunca pisa un nombre puesto a mano', async () => {
    const z = agenda(2);
    const a = almacen([
      { telefono: tel(0), nombre: 'Marta (obra 4)' },
      { telefono: tel(1), nombre: tel(1) },
    ]);
    const r = await importarHistorial({ ...base, almacen: a, fuente: z });
    expect(r.nombres).toBe(1);
    expect(a.contactos.map((c) => c.nombre)).toEqual([
      'Marta (obra 4)',
      'Agenda 1',
    ]);
  });

  it('ignora un nombre de la agenda que es un teléfono', async () => {
    const z = agenda(3, (i) =>
      i === 0 ? `+${tel(0)}` : i === 1 ? '+57 300 000-0001' : '   '
    );
    const a = almacen([0, 1, 2].map((i) => ({ telefono: tel(i), nombre: '' })));
    const r = await importarHistorial({ ...base, almacen: a, fuente: z });
    expect(r.nombres).toBe(0);
    expect(a.contactos.every((c) => c.nombre === '')).toBe(true);
    expect(nombreUtil('+57 (300) 111-2233')).toBeNull();
    expect(nombreUtil('  Ana 2  ')).toBe('Ana 2');
  });

  it('no crea contactos para quien no tiene chat', async () => {
    const z = agenda(40);
    const a = almacen([{ telefono: tel(3), nombre: '' }]);
    const r = await importarHistorial({ ...base, almacen: a, fuente: z });
    expect(r.contactosLeidos).toBe(40);
    expect(r.nombres).toBe(1);
    expect(a.contactos).toHaveLength(1);
  });

  it('correrla dos veces no completa nada la segunda', async () => {
    const z = agenda(5);
    const a = almacen([{ telefono: tel(2), nombre: '' }]);
    const r1 = await importarHistorial({ ...base, almacen: a, fuente: z });
    const r2 = await importarHistorial({ ...base, almacen: a, fuente: z });
    expect([r1.nombres, r2.nombres]).toEqual([1, 0]);
  });
});

describe('historial, fase contactos: el 429', () => {
  it('uno corto se espera; uno largo corta, dice cuánto y retoma el mismo skip', async () => {
    const esperas: number[] = [];
    const z = agenda(150);
    z.limitar = { veces: 1, esperaMs: 1_000 };
    const r = await importarHistorial({
      ...base,
      almacen: almacen(),
      fuente: z,
      esperar: async (ms) => {
        esperas.push(ms);
      },
    });
    expect(esperas).toEqual([1_000]);
    expect(r.terminado).toBe(true);

    const z2 = agenda(150);
    const a2 = almacen([{ telefono: tel(120), nombre: '' }]);
    // Primero la página 0; el 429 llega al pedir la del skip 100.
    const cursor = codificarCursor({
      ...leerCursor(null),
      fase: 'contactos',
      saltoContactos: 100,
    });
    z2.limitar = { veces: 1, esperaMs: 60_000 };
    const r2 = await importarHistorial({
      ...base,
      almacen: a2,
      fuente: z2,
      cursor,
    });
    expect(r2.terminado).toBe(false);
    expect(r2.esperarMs).toBe(60_000);
    expect(leerCursor(r2.cursor).saltoContactos).toBe(100);
    const r3 = await importarHistorial({
      ...base,
      almacen: a2,
      fuente: z2,
      cursor: r2.cursor,
    });
    expect(r3.terminado).toBe(true);
    expect(z2.saltosPedidos).toEqual([100]);
    expect(a2.contactos[0].nombre).toBe('Agenda 120');
  });
});

describe('FuenteHistorialZernio: la agenda', () => {
  function fetchDoble(respuestas: Array<() => Response>) {
    const pedidos: Array<{ url: string; metodo: string }> = [];
    const f = (async (url: string, init?: RequestInit) => {
      pedidos.push({ url, metodo: init?.method ?? 'GET' });
      return respuestas.shift()!();
    }) as unknown as typeof fetch;
    return { f, pedidos };
  }

  it('pide la cuenta y WhatsApp por skip, con GET, y avanza por lo que llegó', async () => {
    const { f, pedidos } = fetchDoble([
      () =>
        Response.json({
          contacts: [
            {
              id: 'k1',
              name: 'Ana',
              platform: 'whatsapp',
              platformIdentifier: '+573001112233',
            },
            {
              id: 'k2',
              name: '+573004445566',
              platform: 'whatsapp',
              platformIdentifier: '+573004445566',
            },
          ],
          // El proveedor devolvió 2 aunque se pidieron 100.
          pagination: { total: 5, limit: 100, skip: 0, hasMore: true },
        }),
      () =>
        Response.json({
          contacts: [],
          pagination: { total: 5, limit: 100, skip: 2, hasMore: false },
        }),
    ]);
    const fuente = new FuenteHistorialZernio({ apiKey: 'k', fetch: f });
    const p1 = await fuente.contactos('acc', 0, 100);
    expect(p1.items).toEqual([
      { id: 'k1', nombre: 'Ana', telefono: '573001112233' },
      { id: 'k2', nombre: '+573004445566', telefono: '573004445566' },
    ]);
    expect(p1.siguiente).toBe(2);
    const p2 = await fuente.contactos('acc', 2, 100);
    expect(p2.siguiente).toBeNull();
    const q = new URL(pedidos[0].url);
    expect(q.pathname).toBe('/api/v1/contacts');
    expect(Object.fromEntries(q.searchParams)).toEqual({
      accountId: 'acc',
      platform: 'whatsapp',
      limit: '100',
      skip: '0',
    });
    expect(pedidos.every((p) => p.metodo === 'GET')).toBe(true);
  });

  it('un contacto: el teléfono del canal de ESA cuenta; 404 es null; 429 avisa', async () => {
    const { f, pedidos } = fetchDoble([
      () =>
        Response.json({
          contact: { id: 'k1', name: 'Ana' },
          channels: [
            {
              accountId: 'otra',
              platform: 'whatsapp',
              platformIdentifier: '+15550001111',
            },
            {
              accountId: 'acc',
              platform: 'whatsapp',
              platformIdentifier: '+573001112233',
            },
          ],
        }),
      () => new Response('{"error":"not found"}', { status: 404 }),
      () => new Response('', { status: 429, headers: { 'Retry-After': '3' } }),
    ]);
    const fuente = new FuenteHistorialZernio({ apiKey: 'k', fetch: f });
    expect(await fuente.contacto('k1', 'acc')).toEqual({
      id: 'k1',
      nombre: 'Ana',
      telefono: '573001112233',
    });
    expect(await fuente.contacto('k2', 'acc')).toBeNull();
    const e = await fuente.contacto('k3', 'acc').catch((x) => x);
    expect(e).toBeInstanceOf(LimiteDeVelocidad);
    expect(new URL(pedidos[0].url).pathname).toBe('/api/v1/contacts/k1');
    expect(pedidos.every((p) => p.metodo === 'GET')).toBe(true);
  });
});

/** Un doble mínimo del cliente de Supabase: registra la cadena de cada consulta. */
function dbDoble(filas: Array<Record<string, unknown>>) {
  const llamadas: Array<{ op: string; args: unknown[] }[]> = [];
  const db = {
    from(tabla: string) {
      const cadena: { op: string; args: unknown[] }[] = [
        { op: 'from', args: [tabla] },
      ];
      llamadas.push(cadena);
      let esUpdate = false;
      const q: Record<string, unknown> = {};
      for (const op of ['select', 'eq', 'in', 'is', 'update'])
        q[op] = (...args: unknown[]) => {
          cadena.push({ op, args });
          if (op === 'update') esUpdate = true;
          return q;
        };
      q.then = (ok: (v: unknown) => unknown) => {
        if (!esUpdate) {
          // Como la base: solo las filas cuyo `phone_normalized` está en el in().
          const en = cadena.find((c) => c.op === 'in')?.args[1] as string[];
          const data = filas.filter((f) =>
            (en ?? []).includes(String(f.phone).replace(/\D/g, ''))
          );
          return Promise.resolve({ data, error: null }).then(ok);
        }
        // El update condicional: solo «cambia» si el nombre leído sigue igual.
        const id = cadena.find((c) => c.op === 'eq' && c.args[0] === 'id')
          ?.args[1];
        const fila = filas.find((f) => f.id === id);
        const cond = cadena.find(
          (c) => (c.op === 'eq' || c.op === 'is') && c.args[0] === 'name'
        );
        const vigente =
          fila && cond && (cond.args[1] ?? null) === (fila.name ?? null);
        return Promise.resolve({
          data: vigente ? [{ id }] : [],
          error: null,
        }).then(ok);
      };
      return q;
    },
  };
  return { db, llamadas };
}

describe('de punta a punta: del JSON del proveedor al contacto de la app', () => {
  it('cruza el `platformIdentifier` en E.164 con el teléfono en dígitos de la app', async () => {
    const respuestas = [
      () =>
        Response.json({
          data: [],
          pagination: { hasMore: false, nextCursor: null },
        }),
      () =>
        Response.json({
          contacts: [
            {
              id: 'k1',
              name: 'Doña Marta',
              platform: 'whatsapp',
              platformIdentifier: '+573001112233',
              displayIdentifier: '+573001112233 (+573001112233)',
            },
          ],
          pagination: { total: 1, limit: 100, skip: 0, hasMore: false },
        }),
    ];
    const f = (async () => respuestas.shift()!()) as unknown as typeof fetch;
    const a = almacen([{ telefono: '573001112233', nombre: '573001112233' }]);
    const r = await importarHistorial({
      ...base,
      almacen: a,
      fuente: new FuenteHistorialZernio({ apiKey: 'k', fetch: f }),
    });
    expect(r.terminado).toBe(true);
    expect(r.nombres).toBe(1);
    expect(a.contactos[0].nombre).toBe('Doña Marta');
  });
});

describe('completarNombresSupabase', () => {
  it('solo escribe el nombre, condicionado al que leyó, y no toca a quien tiene uno', async () => {
    const filas = [
      {
        id: 'c1',
        phone: '573001112233',
        name: '573001112233',
        wa_user_id: null,
        wa_parent_user_id: null,
        wa_username: null,
      },
      {
        id: 'c2',
        phone: '573004445566',
        name: 'Marta (obra 4)',
        wa_user_id: null,
        wa_parent_user_id: null,
        wa_username: null,
      },
    ];
    const { db, llamadas } = dbDoble(filas);
    const n = await completarNombresSupabase(db as never, INQ, [
      { telefono: '+57 300 111 2233', nombre: 'Ana' },
      { telefono: '573004445566', nombre: 'Marta' },
      { telefono: '573009999999', nombre: 'Nadie' },
    ]);
    expect(n).toBe(1);
    const updates = llamadas.filter((c) => c.some((x) => x.op === 'update'));
    expect(updates).toHaveLength(1);
    const u = updates[0];
    const cambios = u.find((x) => x.op === 'update')!.args[0] as object;
    expect(Object.keys(cambios).sort()).toEqual(['name', 'updated_at']);
    expect(u).toContainEqual({ op: 'eq', args: ['name', '573001112233'] });
    // Ninguna escritura que cree contactos.
    expect(
      llamadas.flat().some((x) => x.op === 'insert' || x.op === 'upsert')
    ).toBe(false);
  });

  it('si alguien lo escribió en el medio, el update no cambia nada y no cuenta', async () => {
    const filas = [
      {
        id: 'c1',
        phone: '573001112233',
        name: '',
        wa_user_id: null,
        wa_parent_user_id: null,
        wa_username: null,
      },
    ];
    const { db } = dbDoble(filas);
    // Entre la lectura y el update, la persona escribió el nombre.
    const original = db.from.bind(db);
    let lecturas = 0;
    db.from = (t: string) => {
      const q = original(t) as Record<string, (...a: unknown[]) => unknown>;
      const select = q.select;
      q.select = (...a: unknown[]) => {
        if (++lecturas === 2) filas[0].name = 'Puesto a mano';
        return select(...a);
      };
      return q;
    };
    const n = await completarNombresSupabase(db as never, INQ, [
      { telefono: '573001112233', nombre: 'Ana' },
    ]);
    expect(n).toBe(0);
  });

  it('parte el in() en tramos de a lo sumo 25 teléfonos', async () => {
    const { db, llamadas } = dbDoble([]);
    await completarNombresSupabase(
      db as never,
      INQ,
      Array.from({ length: 60 }, (_, i) => ({
        telefono: tel(i),
        nombre: `N${i}`,
      }))
    );
    const ins = llamadas.flat().filter((x) => x.op === 'in');
    expect(ins).toHaveLength(3);
    // Cada teléfono lleva sus variantes: ninguna consulta pasa de 25 teléfonos.
    for (const x of ins)
      expect((x.args[1] as string[]).length).toBeLessThanOrEqual(25 * 7);
  });
});
