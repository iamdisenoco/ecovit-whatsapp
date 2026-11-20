// Pruebas de la revisión del bloque 5 (NO LISTO). Cada una se escribió antes del
// arreglo y falló con el código de entonces.
import { describe, expect, it, vi } from 'vitest';
import { firmarCuerpo } from '../proveedor/firma';
import {
  CONVERSACION_EJEMPLO,
  mensajeEnviado,
  mensajeRecibido,
} from '../proveedor/ejemplos-zernio';
import { ProveedorSimulado } from '../proveedor/simulado';
import { leerWebhookZernio } from '../proveedor/zernio';
import { AlmacenMemoria, type MensajeMemoria } from './almacen-memoria';
import { manejarWebhook, type DependenciasWebhook } from './manejador';
import { Procesador } from './procesar';

const TEL = '+573001112233';
const CONEXION = {
  accountId: 'cuenta-1',
  usuarioId: 'usuario-1',
  conectadoDesde: '2026-01-01T00:00:00Z',
};

async function procesar(a: AlmacenMemoria, ...cuerpos: unknown[]) {
  return new Procesador(a).procesar(
    cuerpos.flatMap((c) => leerWebhookZernio(c))
  );
}

/** Una fila de la bandeja que quedó en `sending` sin wamid (envío dudoso). */
function pendiente(
  a: AlmacenMemoria,
  id: string,
  texto: string
): MensajeMemoria {
  const fila = {
    id,
    conversation_id: a.conversaciones[0].id,
    sender_type: 'agent' as const,
    sender_id: 'u',
    content_type: 'text' as const,
    content_text: texto,
    media_url: null,
    media_type: null,
    message_id: null as unknown as string,
    status: 'sending' as const,
    created_at: new Date().toISOString(),
    reply_to_message_id: null,
    desde_celular: false,
    error_code: null,
    error_title: null,
  };
  a.mensajes.push(fila);
  return fila;
}

async function conChat(a = new AlmacenMemoria(CONEXION)) {
  await procesar(
    a,
    mensajeRecibido({ id: 'in', wamid: 'w-in', telefono: TEL })
  );
  return a;
}

describe('🔴1 la conciliación no adivina', () => {
  it('dos «Hola» dudosos: el message.sent no se pega a ninguno ni crea otra fila', async () => {
    const a = await conChat();
    const p1 = pendiente(a, 'p1', 'Hola');
    const p2 = pendiente(a, 'p2', 'Hola');
    await procesar(
      a,
      mensajeEnviado({
        id: 's1',
        wamid: 'wamid.H',
        participante: '573001112233',
        texto: 'Hola',
        source: 'cloud_api',
      })
    );
    expect(p1.message_id).toBeNull();
    expect(p2.message_id).toBeNull();
    expect(a.mensajes.filter((m) => m.message_id === 'wamid.H')).toHaveLength(
      0
    );
  });

  it('wamid que ya existe: no concilia el pendiente con él (chocaría con el índice único)', async () => {
    const a = await conChat();
    await procesar(
      a,
      mensajeEnviado({
        id: 's0',
        wamid: 'wamid.X',
        participante: '573001112233',
        texto: 'Hola',
        source: 'cloud_api',
      })
    );
    const p = pendiente(a, 'p1', 'Hola');
    await procesar(
      a,
      mensajeEnviado({
        id: 's0-otra',
        wamid: 'wamid.X',
        participante: '573001112233',
        texto: 'Hola',
        source: 'cloud_api',
      })
    );
    expect(p.message_id).toBeNull();
    expect(a.mensajes.filter((m) => m.message_id === 'wamid.X')).toHaveLength(
      1
    );
  });

  it('testigo: un solo pendiente con ese texto sí se concilia (también si ya está incierto)', async () => {
    const a = await conChat();
    const p = pendiente(a, 'p1', 'Hola');
    (p as { status: string }).status = 'incierto';
    await procesar(
      a,
      mensajeEnviado({
        id: 's1',
        wamid: 'wamid.H',
        participante: '573001112233',
        texto: 'Hola',
        source: 'cloud_api',
      })
    );
    expect(p).toMatchObject({ message_id: 'wamid.H', status: 'sent' });
  });
});

describe('🔴2 el evento llega antes que la respuesta de Zernio', () => {
  it('la fila que la bandeja guardó ANTES de enviar la adopta el webhook, sin duplicar', async () => {
    const a = await conChat();
    const p = pendiente(a, 'id-de-idempotencia', 'Ya le cotizo');
    await procesar(
      a,
      mensajeEnviado({
        id: 's',
        wamid: 'wamid.Y',
        participante: '573001112233',
        texto: 'Ya le cotizo',
        source: 'cloud_api',
      })
    );
    expect(p.message_id).toBe('wamid.Y');
    expect(a.mensajes.filter((m) => m.sender_type === 'agent')).toHaveLength(1);
  });
});

describe('🟡5 sin fecha de conexión, todo es historia (falla cerrado)', () => {
  it('un entrante no despierta a los motores si no se sabe desde cuándo está conectado', async () => {
    const a = new AlmacenMemoria({
      accountId: 'c',
      usuarioId: 'u',
      conectadoDesde: null,
    });
    const r = await procesar(
      a,
      mensajeRecibido({ id: 'n', wamid: 'w', telefono: TEL })
    );
    expect(a.mensajes).toHaveLength(1);
    expect(r.trabajos.filter((t) => t.clase === 'motores')).toHaveLength(0);
  });
});

describe('🟡10 el eco del celular con BSUID va al mismo chat', () => {
  it('contacto guardado por teléfono, eco con BSUID y la misma conversación de Zernio: un solo chat', async () => {
    const a = new AlmacenMemoria(CONEXION);
    await procesar(
      a,
      mensajeRecibido({ id: 'in', wamid: 'w-in', telefono: TEL })
    );
    await procesar(
      a,
      mensajeEnviado({
        id: 'cel',
        wamid: 'w-cel',
        participante: 'CO.13491208655302741918',
        conversationId: CONVERSACION_EJEMPLO,
      })
    );
    expect(a.conversaciones).toHaveLength(1);
    expect(a.contactos).toHaveLength(1);
    expect(a.mensajes.find((m) => m.message_id === 'w-cel')).toMatchObject({
      desde_celular: true,
    });
  });
});

const SECRETO = 's';
function deps(
  almacen: AlmacenMemoria,
  extra: Partial<DependenciasWebhook> = {}
) {
  const cola: Array<() => Promise<void>> = [];
  const motores = vi.fn(async () => {});
  const d: DependenciasWebhook = {
    proveedor: () => new ProveedorSimulado([SECRETO]),
    almacen: () => almacen,
    despues: (t) => cola.push(t),
    motores,
    ...extra,
  };
  return { d, cola, motores };
}
function pedido(cuerpo: unknown, secreto = SECRETO) {
  const crudo = JSON.stringify(cuerpo);
  return new Request('http://local/api/whatsapp/webhook', {
    method: 'POST',
    body: crudo,
    headers: { 'x-zernio-signature': firmarCuerpo(crudo, secreto) },
  });
}

describe('🟡3 sin secreto configurado: 503, no 401', () => {
  it('el proveedor reintenta un 503; un 4xx sería perder el evento', async () => {
    const { d } = deps(new AlmacenMemoria(CONEXION), {
      proveedor: () => new ProveedorSimulado([]),
    });
    const res = await manejarWebhook(
      pedido(mensajeRecibido({ id: 'e', wamid: 'w', telefono: TEL }), ''),
      d
    );
    expect(res.status).toBe(503);
  });

  it('testigo: con secreto, la firma mala sigue en 401', async () => {
    const { d } = deps(new AlmacenMemoria(CONEXION));
    const res = await manejarWebhook(
      pedido(mensajeRecibido({ id: 'e', wamid: 'w', telefono: TEL }), 'otro'),
      d
    );
    expect(res.status).toBe(401);
  });
});

describe('🟡4 tiempo máximo y reintento que sigue', () => {
  it('si la base no contesta dentro del presupuesto: 503 con Retry-After: 30', async () => {
    const a = new AlmacenMemoria(CONEXION);
    a.resolverInquilino = () =>
      new Promise((r) => setTimeout(() => r(CONEXION), 300));
    const { d } = deps(a, { presupuestoMs: 50 });
    const res = await manejarWebhook(
      pedido(mensajeRecibido({ id: 'e', wamid: 'w', telefono: TEL })),
      d
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
  });

  it('la fila entró pero lo que seguía falló: el reintento despierta a los motores', async () => {
    const a = new AlmacenMemoria(CONEXION);
    const original = a.registrarEntrante.bind(a);
    let fallar = true;
    a.registrarEntrante = async (...args) => {
      if (fallar) {
        fallar = false;
        throw new Error('base caída a mitad');
      }
      return original(...args);
    };
    const { d, cola, motores } = deps(a);
    const evento = mensajeRecibido({
      id: 'e-mitad',
      wamid: 'w-mitad',
      telefono: TEL,
    });
    expect((await manejarWebhook(pedido(evento), d)).status).toBe(500);
    expect(a.mensajes).toHaveLength(1);
    a.vencerEventosEnCurso(); // pasaron los 2 minutos de la 0115
    expect((await manejarWebhook(pedido(evento), d)).status).toBe(200);
    for (const t of cola) await t();
    expect(motores).toHaveBeenCalledTimes(1);
  });

  it('testigo: un evento ya procesado no vuelve a despertar a nadie', async () => {
    const a = new AlmacenMemoria(CONEXION);
    const { d, cola, motores } = deps(a);
    const evento = mensajeRecibido({ id: 'e1', wamid: 'w1', telefono: TEL });
    await manejarWebhook(pedido(evento), d);
    await manejarWebhook(pedido(evento), d);
    for (const t of cola) await t();
    expect(motores).toHaveBeenCalledTimes(1);
  });
});
