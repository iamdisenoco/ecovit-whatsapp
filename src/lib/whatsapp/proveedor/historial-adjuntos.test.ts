// Los adjuntos de la historia, los textos en español y la limpieza de los
// vacíos de la sincronización (131051). El proveedor es un `fetch` falso que
// responde como la bandeja real (JSON crudo, URL de adjunto relativa), así se
// prueba también la lectura; el almacén es el de memoria.
import { describe, expect, it } from 'vitest';
import { AlmacenMemoria } from '../webhook/almacen-memoria';
import { ADJUNTO_SIN_DESCARGAR } from '../webhook/procesar';
import { textoVistaPrevia } from '@/lib/inbox/vista-previa';
import {
  ARCHIVO_NO_MOSTRADO,
  TEXTO_NO_SOPORTADO,
} from '../textos-mensaje';
import {
  FuenteHistorialZernio,
  TEXTO_ADJUNTO,
  importarHistorial,
  type FuenteHistorial,
  type ResultadoTramo,
} from './historial';
import { leerTextoMensaje, leerWebhookZernio } from './zernio-webhook';

const CUENTA = 'cuenta-zernio';
const CONECTADO = '2026-11-01T00:00:00.000Z';
const AHORA = Date.parse('2026-11-28T12:00:00.000Z');
/** La fecha falsa con que llegan los vacíos de la sincronización. */
const SINCRONIZACION = '2026-10-31T23:50:00.000Z';

type Crudo = Record<string, unknown>;

/** El 400 de la documentación de get-whatsapp-media. */
const CUERPO_VENCIDO = JSON.stringify({
  error:
    'Media is no longer available on WhatsApp servers (expired or deleted by Meta).',
  type: 'invalid_request_error',
});

/** La bandeja del proveedor, en JSON crudo. Solo responde GET. */
class BandejaFalsa {
  chats: Crudo[] = [];
  mensajes = new Map<string, Crudo[]>();
  /** Estado HTTP de cada archivo por su id (200 si no está). */
  media = new Map<string, number>();
  pedidosMedia: string[] = [];
  pedidosMensajes = 0;
  pedidosChats = 0;
  /** La llave deja de servir apenas se pide el primer archivo. */
  llaveSeVence = false;
  private llaveVencida = false;
  /** El cuerpo de un 400/404/410 por id (si no, el de la doc: «venció»). */
  cuerpoMedia = new Map<string, string>();
  /** El content-type que devuelve el servidor por id (si no, image/jpeg). */
  tipoMedia = new Map<string, string>();
  noGet = 0;
  /** Los próximos N pedidos de archivos responden 429. */
  limitarMedia = 0;
  /** Cuánto «tarda» cada archivo (para el presupuesto). */
  reloj = AHORA;
  tardaMedia = 0;

  chat(id: string, telefono: string) {
    this.chats.push({
      id,
      accountId: CUENTA,
      platform: 'whatsapp',
      participantId: telefono,
      participantName: `Cliente ${id}`,
    });
    this.mensajes.set(id, []);
  }

  mensaje(chat: string, m: Crudo) {
    this.mensajes.get(chat)!.push({ direction: 'incoming', ...m });
  }

  fetch: typeof fetch = (async (entrada: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') !== 'GET') {
      this.noGet++;
      throw new Error('solo GET');
    }
    const url = new URL(entrada);
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    if (auth !== 'Bearer llave' || this.llaveVencida)
      return new Response('{"error":"invalid key"}', { status: 401 });
    const p = url.pathname;
    if (p === '/api/v1/inbox/conversations') this.pedidosChats++;
    if (p === '/api/v1/inbox/conversations')
      return Response.json({ data: this.chats, pagination: {} });
    const enChat = /^\/api\/v1\/inbox\/conversations\/([^/]+)\/messages$/.exec(
      p
    );
    if (enChat) {
      this.pedidosMensajes++;
      const lista = this.mensajes.get(enChat[1]) ?? [];
      return Response.json({ messages: lista, pagination: {} });
    }
    if (p === '/api/v1/contacts')
      return Response.json({ contacts: [], pagination: {} });
    const media = /^\/api\/v1\/whatsapp\/media\/(\w+)$/.exec(p);
    if (media) {
      this.pedidosMedia.push(media[1]);
      if (this.llaveSeVence) {
        this.llaveVencida = true;
        return new Response('{"error":"invalid key"}', { status: 401 });
      }
      this.reloj += this.tardaMedia;
      if (this.limitarMedia > 0) {
        this.limitarMedia--;
        return new Response('', {
          status: 429,
          headers: { 'retry-after': '1' },
        });
      }
      const status = this.media.get(media[1]) ?? 200;
      if (status !== 200)
        return new Response(this.cuerpoMedia.get(media[1]) ?? CUERPO_VENCIDO, {
          status,
        });
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { 'content-type': this.tipoMedia.get(media[1]) ?? 'image/jpeg' },
      });
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
}

function adjunto(id: string, tipo = 'image', mime = 'image/jpeg') {
  return {
    attachments: [
      {
        id: `a${id}`,
        type: tipo,
        mimeType: mime,
        url: `/api/v1/whatsapp/media/${id}?accountId=${CUENTA}`,
      },
    ],
    message: '',
  };
}

const vacio = (id: string, createdAt = SINCRONIZACION): Crudo => ({
  id,
  createdAt,
  message: TEXTO_NO_SOPORTADO,
  attachments: [],
  metadata: {
    source: 'coexistence_history',
    unsupported: {
      code: 131051,
      title: 'Message type unknown',
      details: 'Unsupported message received',
    },
  },
});

function almacen() {
  return new AlmacenMemoria({
    accountId: 'cuenta-1',
    usuarioId: 'usuario-1',
    conectadoDesde: CONECTADO,
  });
}

/**
 * El importador de verdad, con el fetch falso. `sinBajar` imita al de antes:
 * no bajaba adjuntos, guardaba el texto crudo y no saltaba nada.
 */
function fuente(b: BandejaFalsa, sinBajar = false): FuenteHistorial {
  const f = new FuenteHistorialZernio({
    apiKey: 'llave',
    baseUrl: 'https://zernio.com/api/v1',
    fetch: b.fetch,
  });
  if (!sinBajar) return f;
  return {
    conversaciones: f.conversaciones.bind(f),
    contactos: f.contactos.bind(f),
    mensajes: async (...x: Parameters<FuenteHistorial['mensajes']>) => {
      const p = await f.mensajes(...x);
      return {
        ...p,
        items: p.items.map((m) => ({
          ...m,
          sinContenido: false,
          texto: m.texto === ARCHIVO_NO_MOSTRADO ? TEXTO_NO_SOPORTADO : m.texto,
        })),
      };
    },
  };
}

async function importar(
  a: AlmacenMemoria,
  b: BandejaFalsa,
  extra: Partial<Parameters<typeof importarHistorial>[0]> = {},
  sinBajar = false
) {
  const tramos: ResultadoTramo[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const r = await importarHistorial({
      cuentaId: CUENTA,
      almacen: a,
      fuente: fuente(b, sinBajar),
      ahora: () => b.reloj,
      esperar: async (ms) => {
        b.reloj += ms;
      },
      cursor,
      ...extra,
    });
    tramos.push(r);
    if (r.terminado) return tramos;
    cursor = r.cursor;
  }
  throw new Error('no terminó');
}

const msj = (a: AlmacenMemoria, id: string) =>
  a.mensajes.find((m) => m.message_id === id);

describe('historial: adjuntos', () => {
  it('baja y guarda: URL interna, tipo correcto y la ruta del webhook', async () => {
    const b = new BandejaFalsa();
    b.chat('c1', '573001112233');
    b.mensaje('c1', { id: 'w.img', createdAt: '2026-10-01T10:00:00Z', ...adjunto('11') });
    b.mensaje('c1', { id: 'w.aud', createdAt: '2026-10-01T10:01:00Z', ...adjunto('12', 'audio', 'audio/ogg; codecs=opus') });
    b.mensaje('c1', { id: 'w.pdf', createdAt: '2026-10-01T10:02:00Z', ...adjunto('13', 'file', 'application/pdf'), message: 'la cotización' });
    b.mensaje('c1', { id: 'w.vid', createdAt: '2026-10-01T10:03:00Z', ...adjunto('14', 'video', 'video/mp4') });
    const a = almacen();
    const [r] = await importar(a, b);

    expect(r.adjuntosBajados).toBe(4);
    expect(b.noGet).toBe(0);
    expect(msj(a, 'w.img')).toMatchObject({
      content_type: 'image',
      content_text: null,
      media_url: '/api/whatsapp/adjunto/account-cuenta-1/inbound/w.img-0.jpg',
    });
    expect(msj(a, 'w.aud')?.content_type).toBe('audio');
    expect(msj(a, 'w.vid')?.content_type).toBe('video');
    // El pie del documento se conserva.
    expect(msj(a, 'w.pdf')).toMatchObject({
      content_type: 'document',
      content_text: 'la cotización',
    });
    expect(a.archivos.has('account-cuenta-1/inbound/w.img-0.jpg')).toBe(true);
    // La vista previa ya no dice «[adjunto]».
    expect(a.conversaciones[0].last_message_text).toBe('[video]');
  });

  it('testigo: sin bajada (el importador de antes) queda «[adjunto]» sin URL', async () => {
    const b = new BandejaFalsa();
    b.chat('c1', '573001112233');
    b.mensaje('c1', { id: 'w.img', createdAt: '2026-10-01T10:00:00Z', ...adjunto('11') });
    const a = almacen();
    await importar(a, b, {}, true);
    expect(msj(a, 'w.img')).toMatchObject({
      content_text: TEXTO_ADJUNTO,
      media_url: null,
    });
    expect(b.pedidosMedia).toEqual([]);
  });

  it('vencido (400): «sin descargar» y no se vuelve a pedir', async () => {
    const b = new BandejaFalsa();
    b.chat('c1', '573001112233');
    b.mensaje('c1', { id: 'w.v', createdAt: '2026-10-01T10:00:00Z', ...adjunto('21') });
    b.mensaje('c1', { id: 'w.pie', createdAt: '2026-10-01T10:01:00Z', ...adjunto('22'), message: 'mire' });
    b.mensaje('c1', { id: 'w.ok', createdAt: '2026-10-01T10:02:00Z', ...adjunto('23') });
    b.media.set('21', 400);
    b.media.set('22', 404);
    const a = almacen();
    const [r] = await importar(a, b);
    expect(r.adjuntosVencidos).toBe(2);
    expect(r.adjuntosBajados).toBe(1);
    expect(msj(a, 'w.v')).toMatchObject({
      media_url: null,
      content_text: ADJUNTO_SIN_DESCARGAR,
    });
    expect(msj(a, 'w.pie')?.content_text).toBe(`mire\n${ADJUNTO_SIN_DESCARGAR}`);
    expect(b.pedidosMedia.sort()).toEqual(['21', '22', '23']);

    await importar(a, b);
    // Ni el vencido ni el bajado se vuelven a pedir.
    expect(b.pedidosMedia).toHaveLength(3);
  });

  it('un fallo pasajero (500) queda pendiente y la corrida siguiente lo completa', async () => {
    const b = new BandejaFalsa();
    b.chat('c1', '573001112233');
    b.mensaje('c1', { id: 'w.x', createdAt: '2026-10-01T10:00:00Z', ...adjunto('31') });
    b.media.set('31', 500);
    const a = almacen();
    const [r1] = await importar(a, b);
    expect(r1.adjuntosFallidos).toBe(1);
    expect(msj(a, 'w.x')).toMatchObject({ content_text: TEXTO_ADJUNTO, media_url: null });
    b.media.delete('31');
    const [r2] = await importar(a, b);
    expect(r2.adjuntosBajados).toBe(1);
    expect(msj(a, 'w.x')?.media_url).toMatch(/^\/api\/whatsapp\/adjunto\//);
  });

  it('no baja dos veces lo que ya bajó', async () => {
    const b = new BandejaFalsa();
    b.chat('c1', '573001112233');
    b.mensaje('c1', { id: 'w.1', createdAt: '2026-10-01T10:00:00Z', ...adjunto('41') });
    const a = almacen();
    await importar(a, b);
    // Testigo: la primera corrida sí lo pidió.
    expect(b.pedidosMedia).toEqual(['41']);
    const [r] = await importar(a, b);
    expect(b.pedidosMedia).toEqual(['41']);
    expect(r.adjuntosBajados).toBe(0);
  });

  it('completa un «[adjunto]» de una importación vieja (actualiza, no inserta)', async () => {
    const b = new BandejaFalsa();
    b.chat('c1', '573001112233');
    b.mensaje('c1', { id: 'w.1', createdAt: '2026-10-01T10:00:00Z', ...adjunto('51') });
    const a = almacen();
    await importar(a, b, {}, true);
    // Testigo: como quedó INKSPIRA.
    expect(msj(a, 'w.1')).toMatchObject({ content_text: TEXTO_ADJUNTO, media_url: null });
    expect(a.conversaciones[0].last_message_text).toBe(TEXTO_ADJUNTO);
    const id = msj(a, 'w.1')!.id;

    const [r] = await importar(a, b);
    expect(r.mensajes).toBe(0);
    expect(r.adjuntosBajados).toBe(1);
    expect(a.mensajes).toHaveLength(1);
    expect(msj(a, 'w.1')).toMatchObject({ id, content_text: null, content_type: 'image' });
    expect(msj(a, 'w.1')?.media_url).toMatch(/w\.1-0\.jpg$/);
    expect(a.conversaciones[0].last_message_text).toBe('[image]');
  });

  it('un 429 en la bajada se espera y se sigue', async () => {
    const b = new BandejaFalsa();
    b.chat('c1', '573001112233');
    b.mensaje('c1', { id: 'w.1', createdAt: '2026-10-01T10:00:00Z', ...adjunto('61') });
    b.limitarMedia = 1;
    const a = almacen();
    const [r] = await importar(a, b);
    expect(r.adjuntosBajados).toBe(1);
    expect(b.pedidosMedia).toEqual(['61', '61']);
  });

  it('sin tiempo, los adjuntos quedan pendientes y la página no se vuelve a pedir', async () => {
    const b = new BandejaFalsa();
    b.chat('c1', '573001112233');
    for (let i = 0; i < 6; i++)
      b.mensaje('c1', {
        id: `w.${i}`,
        createdAt: `2026-10-01T10:0${i}:00Z`,
        ...adjunto(`7${i}`),
      });
    b.tardaMedia = 4_000;
    const a = almacen();
    const tramos = await importar(a, b, { presupuestoMs: 10_000 });
    // Una sola página de mensajes en toda la corrida.
    expect(b.pedidosMensajes).toBe(1);
    const pendientes = tramos.reduce((n, t) => n + t.adjuntosPendientes, 0);
    // Testigo: de verdad faltó tiempo.
    expect(pendientes).toBeGreaterThan(0);
    expect(a.mensajes.filter((m) => !m.media_url)).toHaveLength(pendientes);
    const guardados = a.mensajes.filter((m) => m.media_url).length;
    expect(guardados).toBeGreaterThan(0);
    const primera = [...b.pedidosMedia];
    // Otra corrida completa lo que quedó y no vuelve a pedir lo guardado. (El
    // que se bajó sin tiempo para subirlo se descartó y se vuelve a pedir.)
    await importar(a, b);
    expect(a.mensajes.every((m) => m.media_url)).toBe(true);
    const segunda = b.pedidosMedia.slice(primera.length);
    expect(segunda).toHaveLength(6 - guardados);
  });

  it('una página con adjuntos que siempre fallan termina en una sola corrida', async () => {
    const b = new BandejaFalsa();
    b.chat('c1', '573001112233');
    b.mensaje('c1', { id: 'w.ok', createdAt: '2026-10-01T09:59:00Z', ...adjunto('80') });
    for (let i = 1; i <= 4; i++) {
      b.mensaje('c1', { id: `w.${i}`, createdAt: `2026-10-01T10:0${i}:00Z`, ...adjunto(`8${i}`) });
      b.media.set(`8${i}`, 500);
    }
    // Uno que el bucket no acepta (lo dice el servidor) y uno que lo declara.
    b.mensaje('c1', { id: 'w.zip', createdAt: '2026-10-01T10:06:00Z', ...adjunto('86', 'file', 'application/pdf') });
    b.tipoMedia.set('86', 'application/zip');
    b.mensaje('c1', { id: 'w.heic', createdAt: '2026-10-01T10:07:00Z', ...adjunto('87', 'image', 'image/heic') });
    const a = almacen();
    const tramos = await importar(a, b, { presupuestoMs: 10_000 });
    expect(tramos.at(-1)!.terminado).toBe(true);
    expect(b.pedidosMensajes).toBe(1);
    const [r] = tramos;
    expect(r.adjuntosBajados).toBe(1);
    expect(r.adjuntosFallidos).toBe(4);
    expect(r.adjuntosVencidos).toBe(2);
    // El de tipo declarado no admitido ni se pide; cada otro, una vez.
    expect(b.pedidosMedia.sort()).toEqual(['80', '81', '82', '83', '84', '86']);
    expect(msj(a, 'w.zip')?.content_text).toBe(ADJUNTO_SIN_DESCARGAR);
    expect(msj(a, 'w.heic')?.content_text).toBe(ADJUNTO_SIN_DESCARGAR);
    // Los pasajeros quedan pendientes, no perdidos.
    expect(msj(a, 'w.1')).toMatchObject({ content_text: TEXTO_ADJUNTO, media_url: null });
    // La corrida siguiente no vuelve a pedir los perdidos.
    await importar(a, b);
    expect(b.pedidosMedia.filter((x) => x === '86' || x === '87')).toEqual(['86']);
  });

  it('un archivo que siempre da 403 no bloquea dos corridas seguidas', async () => {
    const b = new BandejaFalsa();
    b.chat('c1', '573001112233');
    b.mensaje('c1', { id: 'w.1', createdAt: '2026-10-01T10:00:00Z', ...adjunto('91') });
    b.mensaje('c1', { id: 'w.2', createdAt: '2026-10-01T10:01:00Z', ...adjunto('92') });
    b.mensaje('c1', { id: 'w.3', createdAt: '2026-10-01T10:02:00Z', ...adjunto('93') });
    b.media.set('91', 403);
    b.media.set('92', 400);
    b.cuerpoMedia.set('92', '{"error":"bad request"}');
    const a = almacen();
    const chatsAntes = b.pedidosChats;
    const [r] = await importar(a, b);
    // Testigo: se comprobó la conexión, una sola vez en la corrida.
    expect(b.pedidosChats - chatsAntes).toBe(2); // la lista + la comprobación
    expect(r.adjuntosVencidos).toBe(2);
    expect(r.adjuntosBajados).toBe(1);
    expect(msj(a, 'w.1')?.content_text).toBe(ADJUNTO_SIN_DESCARGAR);
    expect(msj(a, 'w.2')?.content_text).toBe(ADJUNTO_SIN_DESCARGAR);
    // La segunda corrida termina y no vuelve a pedirlos.
    const tramos = await importar(a, b);
    expect(tramos.at(-1)!.terminado).toBe(true);
    expect(b.pedidosMedia.filter((x) => x === '91' || x === '92')).toEqual(['91', '92']);
  });

  it('una llave mala corta con error y no marca nada', async () => {
    const b = new BandejaFalsa();
    b.chat('c1', '573001112233');
    b.mensaje('c1', { id: 'w.1', createdAt: '2026-10-01T10:00:00Z', ...adjunto('94') });
    b.mensaje('c1', { id: 'w.2', createdAt: '2026-10-01T10:01:00Z', ...adjunto('95') });
    b.llaveSeVence = true;
    const a = almacen();
    await expect(importar(a, b)).rejects.toThrow(
      /no dejó bajar los archivos \(401\)/
    );
    expect(msj(a, 'w.1')).toMatchObject({ content_text: TEXTO_ADJUNTO, media_url: null });
    expect(msj(a, 'w.2')).toMatchObject({ content_text: TEXTO_ADJUNTO, media_url: null });
    expect(b.pedidosMedia).toEqual(['94']);
  });

  it('si anotar el adjunto en el mensaje falla, no cuenta como bajado', async () => {
    const b = new BandejaFalsa();
    b.chat('c1', '573001112233');
    b.mensaje('c1', { id: 'w.1', createdAt: '2026-10-01T10:00:00Z', ...adjunto('93') });
    const a = almacen();
    a.fallarActualizarAdjunto = true;
    const [r] = await importar(a, b);
    expect(r.adjuntosBajados).toBe(0);
    expect(r.adjuntosFallidos).toBe(1);
    // Testigo: con la base bien, la corrida siguiente lo completa.
    a.fallarActualizarAdjunto = false;
    const [r2] = await importar(a, b);
    expect(r2.adjuntosBajados).toBe(1);
  });
});

describe('historial: textos en español', () => {
  it('salta el 131051 de la sincronización y traduce el 131052', async () => {
    const b = new BandejaFalsa();
    b.chat('c1', '573001112233');
    b.mensaje('c1', { id: 'w.texto', createdAt: '2026-10-01T10:00:00Z', message: 'hola' });
    b.mensaje('c1', vacio('w.vacio'));
    b.mensaje('c1', {
      id: 'w.52',
      createdAt: '2026-10-01T10:05:00Z',
      message: TEXTO_NO_SOPORTADO,
      metadata: {
        source: 'coexistence_history',
        unsupported: { code: 131052, title: 'Media download error' },
      },
    });
    b.mensaje('c1', {
      id: 'w.tarjeta',
      createdAt: '2026-10-01T10:06:00Z',
      message: '👤 Ana Pérez',
      metadata: {
        source: 'coexistence_history',
        contacts: [
          {
            name: { first_name: 'Ana', last_name: 'Pérez', formatted_name: 'Ana Pérez' },
            phones: [{ type: 'CELL', phone: '+57 300 123 4567', wa_id: '573001234567' }],
            origin: 'other',
          },
        ],
      },
    });
    const a = almacen();
    const [r] = await importar(a, b);
    expect(msj(a, 'w.vacio')).toBeUndefined();
    // Testigo: el resto del chat sí entró.
    expect(msj(a, 'w.texto')?.content_text).toBe('hola');
    expect(msj(a, 'w.52')?.content_text).toBe(ARCHIVO_NO_MOSTRADO);
    expect(msj(a, 'w.tarjeta')?.content_text).toBe(
      'Contacto compartido: Ana Pérez\n+57 300 123 4567'
    );
    expect(r.saltados).toBe(1);
    // La vista previa: el nombre, sin el teléfono.
    expect(a.conversaciones[0].last_message_text).toBe(
      'Contacto compartido: Ana Pérez'
    );
  });

  it('leerTextoMensaje: cada caso, y un texto normal no cambia', () => {
    expect(leerTextoMensaje('hola', {})).toEqual({
      texto: 'hola',
      sinContenido: false,
      codigo: null,
    });
    expect(
      leerTextoMensaje(TEXTO_NO_SOPORTADO, {
        unsupported: { code: 131051 },
        source: 'whatsapp_business_app',
      })
    ).toMatchObject({ texto: ARCHIVO_NO_MOSTRADO, sinContenido: false });
    expect(
      leerTextoMensaje(TEXTO_NO_SOPORTADO, {
        unsupported: { code: 131051 },
        source: 'coexistence_history',
      }).sinContenido
    ).toBe(true);
    // Un «nombre» que es el número no sale.
    expect(
      leerTextoMensaje('👤', {
        contacts: [
          { name: { formatted_name: '+57 300 123 4567' }, phones: [] },
        ],
      }).texto
    ).toBe('Contacto compartido');
  });

  it('el webhook también traduce lo crudo', () => {
    const [e] = leerWebhookZernio({
      id: 'ev1',
      event: 'message.received',
      message: {
        platform: 'whatsapp',
        platformMessageId: 'wamid.1',
        text: TEXTO_NO_SOPORTADO,
        sender: { id: '573001112233' },
        metadata: { unsupported: { code: 131052 } },
      },
      account: { accountId: CUENTA },
    });
    expect(e).toMatchObject({ tipo: 'mensaje_entrante', texto: ARCHIVO_NO_MOSTRADO });
    const [t] = leerWebhookZernio({
      id: 'ev2',
      event: 'message.received',
      message: {
        platform: 'whatsapp',
        platformMessageId: 'wamid.2',
        text: '👤 Luis',
        sender: { id: '573001112233' },
        metadata: {
          contacts: [{ name: { formatted_name: 'Luis' }, phones: [{ phone: '+573009998877' }] }],
        },
      },
      account: { accountId: CUENTA },
    });
    expect(t).toMatchObject({ texto: 'Contacto compartido: Luis\n+573009998877' });
  });

  it('la vista previa traduce lo que ya está guardado', () => {
    expect(textoVistaPrevia(TEXTO_NO_SOPORTADO)).toBe(ARCHIVO_NO_MOSTRADO);
    expect(textoVistaPrevia('[Unsupported message type: button]')).toBe(
      ARCHIVO_NO_MOSTRADO
    );
    expect(textoVistaPrevia('Contacto compartido: Ana\n+57 300 123 4567')).toBe(
      'Contacto compartido: Ana'
    );
    // Testigo: lo normal pasa igual.
    expect(textoVistaPrevia('[Unsupported] dijo el cliente')).toBe(
      '[Unsupported] dijo el cliente'
    );
    expect(textoVistaPrevia(null)).toBe('');
  });
});

describe('historial: limpieza de los vacíos que ya entraron', () => {
  /** Dos chats como quedaron tras la importación vieja (sin saltar el 131051). */
  async function comoQuedoInkspira() {
    const b = new BandejaFalsa();
    b.chat('A', '573001110001');
    b.mensaje('A', { id: 'A.1', createdAt: '2026-06-01T10:00:00Z', message: 'primero de A' });
    b.mensaje('A', { id: 'A.2', createdAt: '2026-06-10T10:00:00Z', message: 'último de A', direction: 'outgoing', deliveryStatus: 'read' });
    b.mensaje('A', vacio('A.vacio'));
    b.mensaje('A', {
      id: 'A.52',
      createdAt: '2026-06-05T10:00:00Z',
      message: TEXTO_NO_SOPORTADO,
      metadata: { source: 'coexistence_history', unsupported: { code: 131052 } },
    });
    b.chat('B', '573001110002');
    b.mensaje('B', { id: 'B.1', createdAt: '2026-06-20T10:00:00Z', message: 'último de B' });
    const a = almacen();
    // La corrida vieja.
    await importar(a, b, {}, true);
    return { a, b };
  }

  const orden = (a: AlmacenMemoria) =>
    [...a.conversaciones]
      .sort((x, y) => Date.parse(y.last_message_at!) - Date.parse(x.last_message_at!))
      .map((c) => c.last_message_text);

  it('el chat queda con su último mensaje real, su fecha y su lugar en el orden', async () => {
    const { a, b } = await comoQuedoInkspira();
    const chatA = () =>
      a.conversaciones.find((c) => c.id === msj(a, 'A.1')!.conversation_id)!;
    // El resumen de antes no traducía: se guardaba crudo.
    expect(chatA().last_message_text).toBe(ARCHIVO_NO_MOSTRADO);
    chatA().last_message_text = TEXTO_NO_SOPORTADO;
    // Testigo: así se veía la bandeja.
    expect(chatA().last_message_at).toBe(SINCRONIZACION);
    expect(chatA().last_inbound_at).toBe(SINCRONIZACION);
    expect(chatA().closed_at).toBe(SINCRONIZACION);
    expect(orden(a)[0]).toBe(TEXTO_NO_SOPORTADO);

    const [r] = await importar(a, b);
    expect(r.vaciosBorrados).toBe(1);
    expect(msj(a, 'A.vacio')).toBeUndefined();
    expect(chatA()).toMatchObject({
      last_message_text: 'último de A',
      last_message_at: '2026-06-10T10:00:00.000Z',
      last_inbound_at: '2026-06-05T10:00:00.000Z',
      last_reply_at: '2026-06-10T10:00:00.000Z',
      first_inbound_at: '2026-06-01T10:00:00.000Z',
      created_at: '2026-06-01T10:00:00.000Z',
      closed_at: '2026-06-10T10:00:00.000Z',
    });
    expect(orden(a)).toEqual(['último de B', 'último de A']);
  });

  it('no borra el «[Unsupported message]» del 131052', async () => {
    const { a, b } = await comoQuedoInkspira();
    // Testigo: los dos entraron con el texto crudo.
    expect(msj(a, 'A.52')?.content_text).toBe(TEXTO_NO_SOPORTADO);
    expect(msj(a, 'A.vacio')?.content_text).toBe(TEXTO_NO_SOPORTADO);
    await importar(a, b);
    expect(msj(a, 'A.vacio')).toBeUndefined();
    expect(msj(a, 'A.52')?.content_text).toBe(TEXTO_NO_SOPORTADO);
  });

  it('no borra un mensaje con ese id si su texto ya no es la marca', async () => {
    const { a, b } = await comoQuedoInkspira();
    msj(a, 'A.vacio')!.content_text = 'otra cosa';
    const [r] = await importar(a, b);
    expect(r.vaciosBorrados).toBe(0);
    expect(msj(a, 'A.vacio')).toBeDefined();
  });

  it('es idempotente', async () => {
    const { a, b } = await comoQuedoInkspira();
    await importar(a, b);
    const foto = () =>
      JSON.stringify({ m: a.mensajes.map((m) => [m.message_id, m.content_text]).sort(), c: a.conversaciones });
    const despues = foto();
    const [r] = await importar(a, b);
    expect(r.vaciosBorrados).toBe(0);
    expect(r.mensajes).toBe(0);
    // Ya estaba bien: no se reescribe.
    expect(r.chatsRecalculados).toBe(0);
    expect(foto()).toBe(despues);
  });

  it('un chat que solo tenía vacíos se borra si lo creó la historia y no tiene nada', async () => {
    const b = new BandejaFalsa();
    b.chat('V', '573001110009');
    b.mensaje('V', vacio('V.1'));
    b.chat('W', '573001110010');
    b.mensaje('W', vacio('W.1'));
    const a = almacen();
    await importar(a, b, {}, true);
    expect(a.conversaciones).toHaveLength(2);
    // Testigo: a W le cuelga algo (una asignación): se queda, vacío.
    const w = a.conversaciones.find((c) => c.id === msj(a, 'W.1')!.conversation_id)!;
    w.assigned_agent_id = 'vendedor-1';

    await importar(a, b);
    expect(a.conversaciones.map((c) => c.id)).toEqual([w.id]);
    expect(w).toMatchObject({
      last_message_text: null,
      last_inbound_at: null,
      last_message_at: w.created_at,
    });
  });
});
