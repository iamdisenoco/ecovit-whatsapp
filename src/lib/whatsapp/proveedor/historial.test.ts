import { describe, expect, it } from 'vitest';
import type { Conversation } from '@/types';
import { applyInboxFilter, isAwaitingReply } from '@/lib/inbox/inbox-filters';
import { AlmacenMemoria } from '../webhook/almacen-memoria';
import { Procesador } from '../webhook/procesar';
import {
  FuenteHistorialZernio,
  LimiteDeVelocidad,
  PRESUPUESTO_MS,
  SinFechaDeConexion,
  importarHistorial,
  leerCursor,
  type ConversacionRemota,
  type FuenteHistorial,
  type MensajeRemoto,
  type ResultadoTramo,
} from './historial';
import type { EventoMensajeEntrante } from './tipos';

const CUENTA = 'cuenta-zernio';
const CONECTADO = '2026-11-01T00:00:00.000Z';
const AHORA = Date.parse('2026-11-28T12:00:00.000Z');

/** El doble de la bandeja del proveedor: páginas por índice, como un cursor. */
class ZernioDoble implements FuenteHistorial {
  conversacionesRemotas: ConversacionRemota[] = [];
  mensajesRemotos = new Map<string, MensajeRemoto[]>();
  pedidosConversaciones = 0;
  pedidosMensajes = 0;
  /** Los próximos N pedidos responden 429 con esta espera. */
  limitar: { veces: number; esperaMs: number } | null = null;

  private revisarLimite() {
    if (this.limitar && this.limitar.veces > 0) {
      this.limitar.veces--;
      throw new LimiteDeVelocidad(this.limitar.esperaMs);
    }
  }

  async conversaciones(_c: string, cursor: string | null, limite: number) {
    this.revisarLimite();
    this.pedidosConversaciones++;
    const desde = cursor ? Number(cursor) : 0;
    const items = this.conversacionesRemotas.slice(desde, desde + limite);
    const fin = desde + limite;
    return {
      items,
      siguiente: fin < this.conversacionesRemotas.length ? String(fin) : null,
    };
  }

  async mensajes(
    _c: string,
    conv: string,
    cursor: string | null,
    limite: number
  ) {
    this.revisarLimite();
    this.pedidosMensajes++;
    const todos = this.mensajesRemotos.get(conv) ?? [];
    const desde = cursor ? Number(cursor) : 0;
    const fin = desde + limite;
    return {
      items: todos.slice(desde, fin),
      siguiente: fin < todos.length ? String(fin) : null,
    };
  }
}

function telefono(i: number) {
  return `5730000000${String(i).padStart(2, '0')}`;
}

function mensaje(
  conv: string,
  n: number,
  extra: Partial<MensajeRemoto> = {}
): MensajeRemoto {
  return {
    id: `wamid.${conv}.${n}`,
    // Junio, uno por hora: todo anterior a la conexión.
    creadoEn: new Date(
      Date.parse('2026-06-03T10:00:00.000Z') + n * 3600_000
    ).toISOString(),
    saliente: n % 2 === 1,
    texto: `texto ${n}`,
    adjuntos: [],
    estadoEntrega: n % 2 === 1 ? 'read' : 'pending',
    borrado: false,
    ...extra,
  };
}

/** `chats` conversaciones, cada una con `porChat` mensajes. */
function bandeja(chats: number, porChat: number): ZernioDoble {
  const z = new ZernioDoble();
  for (let i = 0; i < chats; i++) {
    const id = `conv-${i}`;
    z.conversacionesRemotas.push({
      id,
      cuentaId: CUENTA,
      plataforma: 'whatsapp',
      participanteId: telefono(i),
      participanteNombre: `Cliente ${i}`,
      bsuid: `CO.${i}`,
    });
    z.mensajesRemotos.set(
      id,
      Array.from({ length: porChat }, (_, n) => mensaje(id, n))
    );
  }
  return z;
}

function almacen() {
  return new AlmacenMemoria({
    accountId: 'cuenta-1',
    usuarioId: 'usuario-1',
    conectadoDesde: CONECTADO,
  });
}

const base = { cuentaId: CUENTA, ahora: () => AHORA };

/** Corre tramos hasta terminar. */
async function hastaTerminar(
  a: AlmacenMemoria,
  z: FuenteHistorial,
  extra: Partial<Parameters<typeof importarHistorial>[0]> = {}
) {
  const tramos: ResultadoTramo[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100; i++) {
    const r = await importarHistorial({
      ...base,
      almacen: a,
      fuente: z,
      cursor,
      ...extra,
    });
    tramos.push(r);
    if (r.terminado) return tramos;
    cursor = r.cursor;
  }
  throw new Error('no terminó');
}

/** Las filas sin ids generados, para comparar dos corridas. */
function foto(a: AlmacenMemoria) {
  return {
    contactos: a.contactos.map((c) => c.telefono).sort(),
    conversaciones: a.conversaciones.length,
    mensajes: a.mensajes.map((m) => m.message_id).sort(),
  };
}

describe('importarHistorial: paginación', () => {
  it('recorre todas las páginas de chats y de mensajes', async () => {
    const z = bandeja(5, 7);
    const a = almacen();
    const r = await importarHistorial({
      ...base,
      almacen: a,
      fuente: z,
      conversacionesPorPagina: 2,
      mensajesPorPagina: 3,
      maxConversaciones: 100,
    });
    expect(r.terminado).toBe(true);
    expect(r.procesadas).toBe(5);
    expect(r.listas).toBe(5);
    expect(r.mensajes).toBe(35);
    expect(a.mensajes).toHaveLength(35);
    expect(a.contactos).toHaveLength(5);
    expect(a.conversaciones).toHaveLength(5);
    // 3 páginas de chats (2+2+1) y 3 de mensajes por chat (3+3+1).
    expect(z.pedidosConversaciones).toBe(3);
    expect(z.pedidosMensajes).toBe(15);
  });

  it('guarda la referencia del proveedor en cada chat', async () => {
    const z = bandeja(2, 1);
    const a = almacen();
    await importarHistorial({ ...base, almacen: a, fuente: z });
    const refs = [...a.referencias.values()].map((r) => r.conversacionId);
    expect(refs.sort()).toEqual(['conv-0', 'conv-1']);
    expect([...a.referencias.values()][0].cuentaId).toBe(CUENTA);
  });
});

describe('importarHistorial: idempotencia', () => {
  it('correrlo dos veces deja las mismas filas', async () => {
    const z = bandeja(4, 5);
    const a = almacen();
    await hastaTerminar(a, z);
    const primera = foto(a);
    const tramos = await hastaTerminar(a, z);
    expect(foto(a)).toEqual(primera);
    expect(tramos.reduce((s, t) => s + t.mensajes, 0)).toBe(0);
  });
});

function entrante(
  wamid: string,
  conv: string,
  tel: string,
  enviadoEn: string
): EventoMensajeEntrante {
  return {
    tipo: 'mensaje_entrante',
    eventoId: `ev-${wamid}`,
    generadoEn: enviadoEn,
    prueba: false,
    mensajeId: wamid,
    referencia: { conversacionId: conv, cuentaId: CUENTA },
    remitente: {
      telefono: tel,
      waUserId: null,
      waParentUserId: null,
      waUsername: null,
      nombre: 'X',
    },
    texto: 'hola',
    adjuntos: [],
    enviadoEn,
    enEspera: false,
    esHistoria: false,
    citaA: null,
  };
}

describe('importarHistorial: con el webhook', () => {
  it('no repite un mensaje que ya entró por webhook', async () => {
    const z = bandeja(1, 3);
    const a = almacen();
    const m = z.mensajesRemotos.get('conv-0')![0];
    await new Procesador(a).procesar([
      entrante(m.id, 'conv-0', telefono(0), m.creadoEn),
    ]);
    await importarHistorial({ ...base, almacen: a, fuente: z });
    expect(a.mensajes.filter((x) => x.message_id === m.id)).toHaveLength(1);
    expect(a.mensajes).toHaveLength(3);
    // Cayó en el mismo chat que había creado el webhook.
    expect(a.conversaciones).toHaveLength(1);
  });

  it('el webhook no repite ni despierta a nadie con un mensaje ya importado', async () => {
    const z = bandeja(1, 2);
    const a = almacen();
    await importarHistorial({ ...base, almacen: a, fuente: z });
    const m = z.mensajesRemotos.get('conv-0')![0];
    const r = await new Procesador(a).procesar([
      entrante(m.id, 'conv-0', telefono(0), m.creadoEn),
    ]);
    expect(r.repetidos).toBe(1);
    expect(r.trabajos).toHaveLength(0);
    expect(a.mensajes).toHaveLength(2);
  });

  it('solo guarda lo ESTRICTAMENTE anterior a la conexión; lo demás es del webhook', async () => {
    const z = bandeja(1, 0);
    const antes = new Date(Date.parse(CONECTADO) - 1).toISOString();
    z.mensajesRemotos.set('conv-0', [
      mensaje('conv-0', 0),
      mensaje('conv-0', 1, { creadoEn: antes }),
      // Justo en la conexión, 20 días después y hace un minuto: del webhook.
      mensaje('conv-0', 2, { creadoEn: CONECTADO, saliente: false }),
      mensaje('conv-0', 3, { creadoEn: '2026-11-21T00:00:00.000Z' }),
      mensaje('conv-0', 4, {
        creadoEn: new Date(AHORA - 60_000).toISOString(),
        saliente: false,
      }),
    ]);
    const a = almacen();
    const r = await importarHistorial({ ...base, almacen: a, fuente: z });
    expect(a.mensajes.map((m) => m.message_id).sort()).toEqual([
      'wamid.conv-0.0',
      'wamid.conv-0.1',
    ]);
    expect(r.saltados).toBe(3);
  });

  it('un mensaje vivo atrasado que llega por webhook despierta al bot', async () => {
    const z = bandeja(1, 1);
    const vivo = mensaje('conv-0', 2, {
      creadoEn: '2026-11-20T00:00:00.000Z',
      saliente: false,
    });
    z.mensajesRemotos.get('conv-0')!.push(vivo);
    const a = almacen();
    await importarHistorial({ ...base, almacen: a, fuente: z });
    const r = await new Procesador(a).procesar([
      entrante(vivo.id, 'conv-0', telefono(0), vivo.creadoEn),
    ]);
    expect(r.repetidos).toBe(0);
    expect(r.trabajos.map((t) => t.clase)).toEqual(['motores']);
    expect(a.conversaciones[0].unread_count).toBe(1);
  });

  it('sin fecha de conexión no importa nada y lo dice sin nombrar al proveedor', async () => {
    const a = new AlmacenMemoria({
      accountId: 'cuenta-1',
      usuarioId: 'usuario-1',
      conectadoDesde: null,
    });
    const z = bandeja(2, 2);
    const e = await importarHistorial({ ...base, almacen: a, fuente: z }).catch(
      (x) => x
    );
    expect(e).toBeInstanceOf(SinFechaDeConexion);
    expect(e.message).not.toMatch(/zernio/i);
    expect(z.pedidosConversaciones).toBe(0);
    expect(a.mensajes).toHaveLength(0);
  });
});

describe('importarHistorial: es historia', () => {
  it('no despierta al bot ni a los motores ni lo calla', async () => {
    const z = bandeja(2, 4);
    const a = almacen();
    const llamadas: string[] = [];
    for (const m of [
      'callarBot',
      'despertarBot',
      'pausarFlujos',
      'registrarEntrante',
      'registrarSaliente',
    ] as const) {
      const original = a[m].bind(a) as (...x: unknown[]) => Promise<unknown>;
      (a as unknown as Record<string, unknown>)[m] = (...x: unknown[]) => {
        llamadas.push(m);
        return original(...x);
      };
    }
    // Un chat que ya existía, callado a mano y con el bot a cero.
    const { contactoId } = await a.buscarOCrearContacto(a.inquilino, {
      telefono: telefono(0),
      waUserId: null,
      waParentUserId: null,
      waUsername: null,
      nombre: 'X',
    });
    const { conversacion } = await a.buscarOCrearConversacion(
      a.inquilino,
      contactoId
    );
    const c = a.conversacion(conversacion.id);
    c.ai_autoreply_disabled = true;
    c.ai_handoff_summary = 'tomado';
    c.status = 'closed';

    await importarHistorial({ ...base, almacen: a, fuente: z });

    expect(llamadas).toEqual([]);
    expect(a.flujosPausados).toEqual([]);
    expect(c.ai_autoreply_disabled).toBe(true);
    expect(c.ai_handoff_summary).toBe('tomado');
    expect(c.status).toBe('closed');
    for (const conv of a.conversaciones) {
      expect(conv.unread_count).toBe(0);
      // La ventana de 24 h no revive: el último entrante es de junio.
      expect(conv.last_inbound_at).toBe('2026-06-03T12:00:00.000Z');
      expect(conv.last_message_at).toBe('2026-06-03T13:00:00.000Z');
      expect(conv.last_message_text).toBe('texto 3');
      expect(conv.first_inbound_at).toBe('2026-06-03T10:00:00.000Z');
    }
    expect(a.mensajes.every((m) => !m.desde_celular)).toBe(true);
  });

  it('no pisa un resumen más nuevo del webhook', async () => {
    const z = bandeja(1, 2);
    const a = almacen();
    const nuevo = new Date(AHORA - 3600_000).toISOString();
    await new Procesador(a).procesar([
      entrante('wamid.vivo', 'conv-0', telefono(0), nuevo),
    ]);
    const c = a.conversaciones[0];
    // Lo puso el webhook, no la prueba.
    expect(c.last_message_at).toBe(nuevo);
    expect(c.last_message_text).toBe('hola');
    await importarHistorial({ ...base, almacen: a, fuente: z });
    expect(c.last_message_text).toBe('hola');
    expect(c.last_message_at).toBe(nuevo);
    expect(c.last_inbound_at).toBe(nuevo);
  });
});

describe('importarHistorial: cada mensaje', () => {
  it('lo saliente queda como asesor y lo entrante como cliente', async () => {
    const z = bandeja(1, 4);
    const a = almacen();
    await importarHistorial({ ...base, almacen: a, fuente: z });
    const por = (n: number) =>
      a.mensajes.find((m) => m.message_id === `wamid.conv-0.${n}`)!;
    expect(por(0).sender_type).toBe('customer');
    expect(por(0).status).toBe('delivered');
    expect(por(1).sender_type).toBe('agent');
    expect(por(1).sender_id).toBeNull();
    expect(por(1).status).toBe('read');
    // La fecha es la original, no la de la importación.
    expect(por(1).created_at).toBe('2026-06-03T11:00:00.000Z');
  });

  it('salta los mensajes borrados', async () => {
    const z = bandeja(1, 3);
    z.mensajesRemotos.get('conv-0')![1].borrado = true;
    const a = almacen();
    const r = await importarHistorial({ ...base, almacen: a, fuente: z });
    expect(a.mensajes.map((m) => m.message_id)).not.toContain('wamid.conv-0.1');
    expect(a.mensajes).toHaveLength(2);
    expect(r.saltados).toBe(1);
  });

  it('un adjunto sin texto queda como [adjunto], sin URL', async () => {
    const z = bandeja(1, 0);
    z.mensajesRemotos.set('conv-0', [
      mensaje('conv-0', 0, {
        texto: null,
        adjuntos: [{ tipo: 'image', mime: 'image/jpeg' }],
      }),
    ]);
    const a = almacen();
    await importarHistorial({ ...base, almacen: a, fuente: z });
    expect(a.mensajes[0]).toMatchObject({
      content_type: 'image',
      content_text: '[adjunto]',
      media_url: null,
      media_type: 'image/jpeg',
    });
  });
});

describe('importarHistorial: cursor y reanudación', () => {
  it('por tramos da lo mismo que de una vez', async () => {
    const z1 = bandeja(7, 3);
    const enUna = almacen();
    await importarHistorial({
      ...base,
      almacen: enUna,
      fuente: z1,
      maxConversaciones: 100,
    });

    const z2 = bandeja(7, 3);
    const enTramos = almacen();
    const tramos = await hastaTerminar(enTramos, z2, {
      maxConversaciones: 2,
      conversacionesPorPagina: 3,
    });
    expect(tramos.length).toBe(4);
    expect(tramos.map((t) => t.listas)).toEqual([2, 4, 6, 7]);
    expect(tramos.slice(0, -1).every((t) => !t.terminado && t.cursor)).toBe(
      true
    );
    expect(foto(enTramos)).toEqual(foto(enUna));
  });

  it('corta a mitad de un chat y sigue desde ahí', async () => {
    const z = bandeja(2, 9);
    const a = almacen();
    let reloj = AHORA;
    // Cada página de mensajes «tarda» 10 s; el tramo tiene 15 s.
    const original = z.mensajes.bind(z);
    z.mensajes = async (...x) => {
      reloj += 10_000;
      return original(...x);
    };
    const r1 = await importarHistorial({
      ...base,
      ahora: () => reloj,
      almacen: a,
      fuente: z,
      presupuestoMs: 15_000,
      mensajesPorPagina: 3,
    });
    expect(r1.terminado).toBe(false);
    expect(r1.procesadas).toBe(0);
    expect(a.mensajes).toHaveLength(6);
    expect(leerCursor(r1.cursor).enCurso).toEqual({
      id: 'conv-0',
      cursor: '6',
      creada: true,
    });

    const pedidosAntes = z.pedidosMensajes;
    const r2 = await importarHistorial({
      ...base,
      ahora: () => reloj,
      almacen: a,
      fuente: z,
      cursor: r1.cursor,
      presupuestoMs: 1_000_000,
      mensajesPorPagina: 3,
    });
    expect(r2.terminado).toBe(true);
    expect(a.mensajes).toHaveLength(18);
    // Retomó en la página 3 del chat 0: 1 + 3 del chat 1.
    expect(z.pedidosMensajes - pedidosAntes).toBe(4);
  });

  it('ante un 429 corto espera; ante uno largo corta y dice cuánto esperar', async () => {
    const z = bandeja(2, 1);
    const a = almacen();
    const esperas: number[] = [];
    z.limitar = { veces: 1, esperaMs: 1_000 };
    const r = await importarHistorial({
      ...base,
      almacen: a,
      fuente: z,
      esperar: async (ms) => {
        esperas.push(ms);
      },
    });
    expect(esperas).toEqual([1_000]);
    expect(r.terminado).toBe(true);

    const z2 = bandeja(2, 1);
    z2.limitar = { veces: 1, esperaMs: 120_000 };
    const r2 = await importarHistorial({
      ...base,
      almacen: almacen(),
      fuente: z2,
    });
    expect(r2.terminado).toBe(false);
    expect(r2.esperarMs).toBe(120_000);
    expect(r2.cursor).toBeTruthy();
  });

  it('un cursor ilegible se rechaza sin nombrar al proveedor', async () => {
    await expect(
      importarHistorial({
        ...base,
        almacen: almacen(),
        fuente: bandeja(1, 1),
        cursor: '%%%',
      })
    ).rejects.toThrow(/punto de avance/);
  });
});

/** La conversación de memoria con la forma que lee la bandeja. */
function comoBandeja(
  c: AlmacenMemoria['conversaciones'][number]
): Conversation {
  return {
    ...c,
    last_reply_at: c.last_reply_at ?? null,
  } as unknown as Conversation;
}

describe('importarHistorial: el chat', () => {
  it('un chat que crea la historia nace cerrado y no queda «esperando»', async () => {
    // 3 mensajes: el último (n=2) es del cliente, así que abierto esperaría.
    const z = bandeja(1, 3);
    const a = almacen();
    await importarHistorial({ ...base, almacen: a, fuente: z });
    const c = a.conversaciones[0];
    expect(c.status).toBe('closed');
    // En sus fechas reales: del primer al último mensaje importado.
    expect(c.created_at).toBe('2026-06-03T10:00:00.000Z');
    expect(c.closed_at).toBe('2026-06-03T12:00:00.000Z');
    expect(c.last_reply_at! < c.last_inbound_at!).toBe(true);
    expect(isAwaitingReply(comoBandeja(c))).toBe(false);
    expect(applyInboxFilter([comoBandeja(c)], 'waiting', AHORA)).toEqual([]);
  });

  it('las fechas del chat abarcan todas las páginas, también entre tramos', async () => {
    // De una vez, con páginas de 3.
    const z = bandeja(1, 7);
    const a = almacen();
    await importarHistorial({
      ...base,
      almacen: a,
      fuente: z,
      mensajesPorPagina: 3,
    });
    expect(a.conversaciones[0].created_at).toBe('2026-06-03T10:00:00.000Z');
    expect(a.conversaciones[0].closed_at).toBe('2026-06-03T16:00:00.000Z');

    // Cortado a mitad del chat: el segundo tramo sigue corriendo las fechas.
    const z2 = bandeja(1, 7);
    const b = almacen();
    let reloj = AHORA;
    const original = z2.mensajes.bind(z2);
    z2.mensajes = async (...x) => {
      reloj += 10_000;
      return original(...x);
    };
    const r1 = await importarHistorial({
      ...base,
      ahora: () => reloj,
      almacen: b,
      fuente: z2,
      mensajesPorPagina: 3,
      presupuestoMs: 15_000,
    });
    expect(r1.terminado).toBe(false);
    expect(b.conversaciones[0].closed_at).toBe('2026-06-03T15:00:00.000Z');
    await importarHistorial({
      ...base,
      ahora: () => reloj,
      almacen: b,
      fuente: z2,
      cursor: r1.cursor,
      mensajesPorPagina: 3,
      presupuestoMs: 1_000_000,
    });
    expect(b.conversaciones[0].created_at).toBe('2026-06-03T10:00:00.000Z');
    expect(b.conversaciones[0].closed_at).toBe('2026-06-03T16:00:00.000Z');
  });

  it('a un chat que ya existía no le cambia las fechas', async () => {
    const z = bandeja(1, 7);
    const a = almacen();
    const { contactoId } = await a.buscarOCrearContacto(a.inquilino, {
      telefono: telefono(0),
      waUserId: null,
      waParentUserId: null,
      waUsername: null,
      nombre: 'X',
    });
    await a.buscarOCrearConversacion(a.inquilino, contactoId);
    const creado = a.conversaciones[0].created_at;
    await importarHistorial({
      ...base,
      almacen: a,
      fuente: z,
      mensajesPorPagina: 3,
    });
    expect(a.conversaciones[0].created_at).toBe(creado);
    expect(a.conversaciones[0].closed_at).toBeNull();
  });

  it('un chat que ya existía no cambia de estado', async () => {
    const z = bandeja(1, 3);
    const a = almacen();
    const { contactoId } = await a.buscarOCrearContacto(a.inquilino, {
      telefono: telefono(0),
      waUserId: null,
      waParentUserId: null,
      waUsername: null,
      nombre: 'X',
    });
    await a.buscarOCrearConversacion(a.inquilino, contactoId);
    await importarHistorial({ ...base, almacen: a, fuente: z });
    expect(a.conversaciones).toHaveLength(1);
    expect(a.conversaciones[0].status).toBe('open');
    expect(a.conversaciones[0].closed_at).toBeNull();
  });

  it('un chat sin mensajes importables no se crea', async () => {
    const z = bandeja(2, 0);
    z.mensajesRemotos.set('conv-0', [
      mensaje('conv-0', 0, { creadoEn: '2026-11-20T00:00:00.000Z' }),
      mensaje('conv-0', 1, { borrado: true }),
    ]);
    const a = almacen();
    const r = await importarHistorial({ ...base, almacen: a, fuente: z });
    expect(r.terminado).toBe(true);
    expect(r.listas).toBe(2);
    expect(a.contactos).toHaveLength(0);
    expect(a.conversaciones).toHaveLength(0);
    expect(a.referencias.size).toBe(0);
  });

  it('a un chat que ya existía y no tiene nada importable no lo toca', async () => {
    const z = bandeja(1, 0);
    z.mensajesRemotos.set('conv-0', [
      mensaje('conv-0', 0, { creadoEn: '2026-11-20T00:00:00.000Z' }),
    ]);
    const a = almacen();
    await new Procesador(a).procesar([
      entrante('wamid.vivo', 'conv-0', telefono(0), '2026-11-20T00:00:00.000Z'),
    ]);
    const antes = structuredClone(a.conversaciones[0]);
    await importarHistorial({ ...base, almacen: a, fuente: z });
    expect(a.conversaciones[0]).toEqual(antes);
    expect(a.mensajes).toHaveLength(1);
  });
});

describe('importarHistorial: robustez y tiempo', () => {
  it('una fecha ilegible salta ese mensaje y sigue', async () => {
    const z = bandeja(1, 3);
    z.mensajesRemotos.get('conv-0')![1].creadoEn = 'no-es-fecha';
    const a = almacen();
    const r = await importarHistorial({ ...base, almacen: a, fuente: z });
    expect(r.terminado).toBe(true);
    expect(r.saltados).toBe(1);
    expect(a.mensajes.map((m) => m.message_id).sort()).toEqual([
      'wamid.conv-0.0',
      'wamid.conv-0.2',
    ]);
  });

  it('cada página de mensajes entra en un solo lote', async () => {
    const z = bandeja(2, 7);
    const a = almacen();
    let sueltos = 0;
    const original = a.insertarMensajeSiNuevo.bind(a);
    a.insertarMensajeSiNuevo = async (f) => {
      sueltos++;
      return original(f);
    };
    await importarHistorial({
      ...base,
      almacen: a,
      fuente: z,
      mensajesPorPagina: 3,
    });
    expect(a.mensajes).toHaveLength(14);
    expect(sueltos).toBe(0);
    // 3 páginas (3+3+1) por chat.
    expect(a.lotes).toBe(6);
  });

  it('el presupuesto también se mira antes de pedir otra página de chats', async () => {
    const z = bandeja(3, 1);
    let reloj = AHORA;
    const chats = z.conversaciones.bind(z);
    const mensajes = z.mensajes.bind(z);
    // La página de chats tarda 10 s y la de mensajes 20 s; el tramo tiene 25 s.
    z.conversaciones = async (...x) => {
      reloj += 10_000;
      return chats(...x);
    };
    z.mensajes = async (...x) => {
      reloj += 20_000;
      return mensajes(...x);
    };
    const r = await importarHistorial({
      ...base,
      ahora: () => reloj,
      almacen: almacen(),
      fuente: z,
      conversacionesPorPagina: 1,
      presupuestoMs: 25_000,
    });
    expect(r.terminado).toBe(false);
    expect(r.listas).toBe(1);
    // No pidió la segunda página: ya no quedaba tiempo.
    expect(z.pedidosConversaciones).toBe(1);
  });

  it('el tramo deja margen bajo los 60 s de Vercel', () => {
    expect(PRESUPUESTO_MS).toBeLessThanOrEqual(30_000);
  });
});

describe('FuenteHistorialZernio', () => {
  function fetchDoble(respuestas: Array<() => Response>) {
    const pedidos: Array<{ url: string; metodo: string }> = [];
    const f = (async (url: string, init?: RequestInit) => {
      pedidos.push({ url, metodo: init?.method ?? 'GET' });
      return respuestas.shift()!();
    }) as unknown as typeof fetch;
    return { f, pedidos };
  }

  it('lee chats y mensajes con GET y pasa el cursor como `cursor`', async () => {
    const { f, pedidos } = fetchDoble([
      () =>
        Response.json({
          data: [
            {
              id: 'c1',
              accountId: 'a',
              platform: 'whatsapp',
              participantId: '573000000001',
              participantName: 'N',
              businessScopedUserId: 'CO.1',
            },
          ],
          pagination: { hasMore: true, nextCursor: 'k1' },
        }),
      () =>
        Response.json({
          status: 'success',
          messages: [
            {
              id: 'wamid.1',
              createdAt: '2026-06-03T22:58:00.000Z',
              direction: 'outgoing',
              message: 'hola',
              attachments: [],
              deliveryStatus: 'delivered',
              isDeleted: false,
            },
          ],
          pagination: { hasMore: false, nextCursor: null },
        }),
    ]);
    const fuente = new FuenteHistorialZernio({
      apiKey: 'llave',
      baseUrl: 'https://x.test/api/v1',
      fetch: f,
    });
    const c = await fuente.conversaciones('a', 'k0', 20);
    expect(c.siguiente).toBe('k1');
    expect(c.items[0]).toMatchObject({ id: 'c1', bsuid: 'CO.1' });
    const m = await fuente.mensajes('a', 'c1', null, 100);
    expect(m.siguiente).toBeNull();
    expect(m.items[0]).toMatchObject({ id: 'wamid.1', saliente: true });
    expect(pedidos.every((p) => p.metodo === 'GET')).toBe(true);
    expect(new URL(pedidos[0].url).searchParams.get('cursor')).toBe('k0');
    expect(new URL(pedidos[1].url).pathname).toBe(
      '/api/v1/inbox/conversations/c1/messages'
    );
  });

  it('un 429 da LimiteDeVelocidad y un 500 un error sin nombre de proveedor', async () => {
    const { f } = fetchDoble([
      () => new Response('', { status: 429, headers: { 'Retry-After': '7' } }),
      () => new Response('{"error":"x"}', { status: 500 }),
    ]);
    const fuente = new FuenteHistorialZernio({ apiKey: 'k', fetch: f });
    const e1 = await fuente.conversaciones('a', null, 1).catch((e) => e);
    expect(e1).toBeInstanceOf(LimiteDeVelocidad);
    expect(e1.esperaMs).toBe(7_000);
    const e2 = await fuente.conversaciones('a', null, 1).catch((e) => e);
    expect(e2.message).not.toMatch(/zernio/i);
    expect(e2.message).toMatch(/500/);
  });
});
