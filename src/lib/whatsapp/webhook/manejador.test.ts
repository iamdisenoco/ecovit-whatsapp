// Prueba de integración de la ruta del webhook con un doble de la base en
// memoria y el proveedor simulado (mismo formato y firma que Zernio). No hay
// base real: lo que aquí «se guarda» vive en `AlmacenMemoria`.
import { describe, expect, it, vi } from 'vitest';
import { firmarCuerpo } from '../proveedor/firma';
import {
  cuentaDesconectada,
  mensajeEnviado,
  mensajeRecibido,
} from '../proveedor/ejemplos-zernio';
import { ProveedorSimulado } from '../proveedor/simulado';
import { ErrorConfiguracion } from '../proveedor/tipos';
import { AlmacenMemoria } from './almacen-memoria';
import { manejarWebhook, type DependenciasWebhook } from './manejador';

const SECRETO = 'secreto-de-prueba';

function armar(almacen = new AlmacenMemoria()) {
  const proveedor = new ProveedorSimulado([SECRETO]);
  const cola: Array<() => Promise<void>> = [];
  const motores = vi.fn(async () => {});
  const deps: DependenciasWebhook = {
    proveedor: () => proveedor,
    almacen: () => almacen,
    despues: (t) => cola.push(t),
    motores,
  };
  return { almacen, cola, motores, deps };
}

function pedido(cuerpo: unknown, firma?: string | null) {
  const crudo = JSON.stringify(cuerpo);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  const f = firma === undefined ? firmarCuerpo(crudo, SECRETO) : firma;
  if (f !== null) headers['x-zernio-signature'] = f;
  return new Request('http://local/api/whatsapp/webhook', {
    method: 'POST',
    body: crudo,
    headers,
  });
}

const ENTRANTE = mensajeRecibido({
  id: 'evt-1',
  wamid: 'wamid.1',
  telefono: '+573001112233',
});

describe('POST /api/whatsapp/webhook', () => {
  it('200 con firma buena: guarda y deja el bot para after()', async () => {
    const { almacen, cola, motores, deps } = armar();
    const res = await manejarWebhook(pedido(ENTRANTE), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ procesados: 1, repetidos: 0 });
    expect(almacen.mensajes).toHaveLength(1);
    expect(almacen.procesado('evt-1')).toBe(true);
    expect(motores).not.toHaveBeenCalled(); // todavía no: va después de responder
    for (const t of cola) await t();
    expect(motores).toHaveBeenCalledTimes(1);
  });

  it('401 con firma mala, y no guarda nada', async () => {
    const { almacen, deps } = armar();
    const res = await manejarWebhook(
      pedido(ENTRANTE, firmarCuerpo('{}', SECRETO)),
      deps
    );
    expect(res.status).toBe(401);
    expect(almacen.mensajes).toHaveLength(0);
    expect(almacen.contactos).toHaveLength(0);
  });

  it('401 sin firma', async () => {
    const { deps } = armar();
    expect((await manejarWebhook(pedido(ENTRANTE, null), deps)).status).toBe(
      401
    );
  });

  it('503 (no 401) si el servidor no tiene secreto, aunque la firma sea la del secreto vacío', async () => {
    const { deps } = armar();
    deps.proveedor = () => new ProveedorSimulado([]);
    const crudo = JSON.stringify(ENTRANTE);
    const res = await manejarWebhook(
      pedido(ENTRANTE, firmarCuerpo(crudo, '')),
      deps
    );
    expect(res.status).toBe(503);
  });

  it('500 si falta WHATSAPP_PROVEEDOR (que el proveedor reintente)', async () => {
    const { deps } = armar();
    deps.proveedor = () => {
      throw new ErrorConfiguracion('Falta WHATSAPP_PROVEEDOR');
    };
    expect((await manejarWebhook(pedido(ENTRANTE), deps)).status).toBe(500);
  });

  it('500 si la base falla, SIN marcar el evento; el reintento lo guarda una vez', async () => {
    const { almacen, deps } = armar();
    almacen.fallarSiguienteInsert = true;
    const r1 = await manejarWebhook(pedido(ENTRANTE), deps);
    expect(r1.status).toBe(500);
    expect(almacen.procesado('evt-1')).toBe(false);
    // Un reintento dentro de los 2 min: 503 (otro lo tiene), nunca 200 que lo perdería.
    expect((await manejarWebhook(pedido(ENTRANTE), deps)).status).toBe(503);
    expect(almacen.mensajes).toHaveLength(0);

    almacen.vencerEventosEnCurso(); // el reintento llega pasados los 2 min de la 0115
    const r2 = await manejarWebhook(pedido(ENTRANTE), deps);
    expect(r2.status).toBe(200);
    expect(almacen.mensajes).toHaveLength(1);
  });

  it('el repetido responde 200 sin volver a despertar al bot', async () => {
    const { cola, motores, deps } = armar();
    await manejarWebhook(pedido(ENTRANTE), deps);
    const res = await manejarWebhook(pedido(ENTRANTE), deps);
    expect(await res.json()).toMatchObject({ repetidos: 1 });
    for (const t of cola) await t();
    expect(motores).toHaveBeenCalledTimes(1);
  });

  it('400 con firma buena pero JSON roto', async () => {
    const { deps } = armar();
    const crudo = '{no es json';
    const req = new Request('http://local/x', {
      method: 'POST',
      body: crudo,
      headers: { 'x-zernio-signature': firmarCuerpo(crudo, SECRETO) },
    });
    expect((await manejarWebhook(req, deps)).status).toBe(400);
  });

  it('cuenta desconectada: 200 y queda anotada', async () => {
    const { almacen, deps } = armar();
    const res = await manejarWebhook(pedido(cuentaDesconectada('evt-d')), deps);
    expect(res.status).toBe(200);
    expect(almacen.cuentaDesconectada).toBe(true);
  });

  it('desde el celular: 200, calla al bot y no despierta motores', async () => {
    const { almacen, cola, motores, deps } = armar();
    await manejarWebhook(
      pedido(
        mensajeEnviado({ id: 'cel', wamid: 'wc', participante: '573001112233' })
      ),
      deps
    );
    for (const t of cola) await t();
    expect(almacen.conversaciones[0].ai_autoreply_disabled).toBe(true);
    expect(motores).not.toHaveBeenCalled();
  });

  it('un adjunto se baja en after() y queda en el bucket con URL interna', async () => {
    const { almacen, cola, deps } = armar();
    const cuerpo = mensajeRecibido({
      id: 'img',
      wamid: 'wamid.img',
      telefono: '+573001112233',
      texto: null,
      adjuntos: [
        { type: 'image', url: 'simulado://foto.png', mimeType: 'image/png' },
      ],
    });
    await manejarWebhook(pedido(cuerpo), deps);
    expect(almacen.mensajes[0].media_url).toBeNull();
    for (const t of cola) await t();
    const [ruta] = [...almacen.archivos.keys()];
    expect(ruta).toBe('account-cuenta-1/inbound/wamid.img-0.png');
    expect(almacen.mensajes[0]).toMatchObject({
      media_url:
        '/api/whatsapp/adjunto/account-cuenta-1/inbound/wamid.img-0.png',
      content_text: null,
    });
  });

  it('un adjunto que no se puede bajar queda «recibido, sin descargar»', async () => {
    const { almacen, cola, deps } = armar();
    const cuerpo = mensajeRecibido({
      id: 'doc',
      wamid: 'wamid.doc',
      telefono: '+573001112233',
      texto: null,
      adjuntos: [
        {
          type: 'file',
          url: 'https://zernio.com/api/v1/whatsapp/media/9',
          mimeType: 'application/pdf',
        },
      ],
    });
    await manejarWebhook(pedido(cuerpo), deps);
    for (const t of cola) await t();
    expect(almacen.archivos.size).toBe(0);
    expect(almacen.mensajes[0]).toMatchObject({
      media_url: null,
      content_text: 'Adjunto recibido, sin descargar',
    });
  });
});
