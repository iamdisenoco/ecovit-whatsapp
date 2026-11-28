// `contact.updated`: la agenda del celular agregó o renombró un contacto. Se
// prueba por la ruta del webhook (firma, idempotencia) con el almacén en
// memoria y un lector de contactos doble (en producción, GET /v1/contacts/{id}).
import { describe, expect, it, vi } from 'vitest';
import { firmarCuerpo } from '../proveedor/firma';
import {
  CUENTA_EJEMPLO,
  contactoActualizado,
} from '../proveedor/ejemplos-zernio';
import {
  LimiteDeVelocidad,
  type ContactoRemoto,
  type LectorContactos,
} from '../proveedor/historial';
import { ProveedorSimulado } from '../proveedor/simulado';
import { leerWebhookZernio } from '../proveedor/zernio-webhook';
import { AlmacenMemoria } from './almacen-memoria';
import { manejarWebhook, type DependenciasWebhook } from './manejador';

const SECRETO = 'secreto-de-prueba';
const TEL = '573001112233';

function armar(
  remoto: ContactoRemoto | null | (() => never),
  contactos: Array<{
    telefono: string;
    nombre: string;
    nombreOrigen?: 'agenda' | 'persona' | null;
  }> = []
) {
  const almacen = new AlmacenMemoria();
  contactos.forEach((c, i) =>
    almacen.contactos.push({ id: `app-${i}`, waUserId: null, ...c })
  );
  const contacto = vi.fn(async () =>
    typeof remoto === 'function' ? remoto() : remoto
  );
  const lector: LectorContactos = { contacto };
  const deps: DependenciasWebhook = {
    proveedor: () => new ProveedorSimulado([SECRETO]),
    almacen: () => almacen,
    despues: () => {},
    motores: async () => {},
    contactos: () => ({ lector, cuentaId: CUENTA_EJEMPLO }),
  };
  return { almacen, contacto, deps };
}

function pedido(cuerpo: unknown, firmar = true) {
  const crudo = JSON.stringify(cuerpo);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (firmar) headers['x-zernio-signature'] = firmarCuerpo(crudo, SECRETO);
  return new Request('http://local/api/whatsapp/webhook', {
    method: 'POST',
    body: crudo,
    headers,
  });
}

const ANA: ContactoRemoto = { id: 'k1', nombre: 'Ana Ruiz', telefono: TEL };

describe('contact.updated: lectura del evento', () => {
  it('solo el de WhatsApp y no los borrados', () => {
    expect(leerWebhookZernio(contactoActualizado('e1', 'k1'))[0]).toMatchObject(
      {
        tipo: 'contacto_actualizado',
        contactoId: 'k1',
        cuentaId: CUENTA_EJEMPLO,
      }
    );
    expect(
      leerWebhookZernio(
        contactoActualizado('e2', 'k1', { changeType: 'deleted' })
      )[0].tipo
    ).toBe('ignorado');
    expect(
      leerWebhookZernio(
        contactoActualizado('e3', 'k1', { platform: 'google' })
      )[0].tipo
    ).toBe('ignorado');
  });
});

describe('contact.updated por el webhook', () => {
  it('firma mala: 401, sin leer el contacto ni tocar nada', async () => {
    const { almacen, contacto, deps } = armar(ANA, [
      { telefono: TEL, nombre: '' },
    ]);
    const res = await manejarWebhook(
      pedido(contactoActualizado('e1', 'k1'), false),
      deps
    );
    expect(res.status).toBe(401);
    expect(contacto).not.toHaveBeenCalled();
    expect(almacen.contactos[0].nombre).toBe('');
  });

  it('pone el nombre si la app tenía el relleno, y el repetido no vuelve a leer', async () => {
    const { almacen, contacto, deps } = armar(ANA, [
      { telefono: TEL, nombre: '+57 300 111 2233' },
    ]);
    const r1 = await manejarWebhook(
      pedido(contactoActualizado('e1', 'k1')),
      deps
    );
    expect(r1.status).toBe(200);
    expect(contacto).toHaveBeenCalledWith('k1', CUENTA_EJEMPLO);
    expect(almacen.contactos[0].nombre).toBe('Ana Ruiz');
    expect(almacen.procesado('e1')).toBe(true);

    const r2 = await manejarWebhook(
      pedido(contactoActualizado('e1', 'k1')),
      deps
    );
    expect(await r2.json()).toMatchObject({ repetidos: 1 });
    expect(contacto).toHaveBeenCalledTimes(1);
  });

  it('no pisa un nombre puesto a mano', async () => {
    const { almacen, deps } = armar(ANA, [
      { telefono: TEL, nombre: 'Marta (obra 4)', nombreOrigen: 'persona' },
    ]);
    const r = await manejarWebhook(
      pedido(contactoActualizado('e1', 'k1')),
      deps
    );
    expect(r.status).toBe(200);
    expect(almacen.contactos[0].nombre).toBe('Marta (obra 4)');
  });

  it('no usa un nombre que es teléfono ni crea contactos', async () => {
    const { almacen, deps } = armar({ ...ANA, nombre: `+${TEL}` }, [
      { telefono: TEL, nombre: '' },
    ]);
    await manejarWebhook(pedido(contactoActualizado('e1', 'k1')), deps);
    expect(almacen.contactos[0].nombre).toBe('');

    const otro = armar(ANA, []);
    const r = await manejarWebhook(
      pedido(contactoActualizado('e2', 'k1')),
      otro.deps
    );
    expect(r.status).toBe(200);
    expect(otro.almacen.contactos).toHaveLength(0);
  });

  it('el aviso de otra cuenta no se lee ni se aplica', async () => {
    const { almacen, contacto, deps } = armar(ANA, [
      { telefono: TEL, nombre: '' },
    ]);
    const cuerpo = contactoActualizado('e1', 'k1');
    cuerpo.account.accountId = 'otra-cuenta';
    const r = await manejarWebhook(pedido(cuerpo), deps);
    expect(await r.json()).toMatchObject({ ignorados: 1 });
    expect(contacto).not.toHaveBeenCalled();
    expect(almacen.contactos[0].nombre).toBe('');
  });

  it('un 429 al leer: 503, el evento queda abierto y el reintento lo aplica', async () => {
    let limitar = true;
    const { almacen, deps } = armar(
      (() => {
        throw new LimiteDeVelocidad(5_000);
      }) as () => never,
      [{ telefono: TEL, nombre: '' }]
    );
    const lector: LectorContactos = {
      contacto: async () => {
        if (limitar) throw new LimiteDeVelocidad(5_000);
        return ANA;
      },
    };
    deps.contactos = () => ({ lector, cuentaId: CUENTA_EJEMPLO });
    const r1 = await manejarWebhook(
      pedido(contactoActualizado('e1', 'k1')),
      deps
    );
    expect(r1.status).toBe(503);
    expect(r1.headers.get('retry-after')).toBeTruthy();
    expect(almacen.procesado('e1')).toBe(false);

    limitar = false;
    almacen.vencerEventosEnCurso();
    const r2 = await manejarWebhook(
      pedido(contactoActualizado('e1', 'k1')),
      deps
    );
    expect(r2.status).toBe(200);
    expect(almacen.contactos[0].nombre).toBe('Ana Ruiz');
  });

  it('sin lector (otro proveedor): 200 y se ignora', async () => {
    const { almacen, deps } = armar(ANA, [{ telefono: TEL, nombre: '' }]);
    deps.contactos = () => null;
    const r = await manejarWebhook(
      pedido(contactoActualizado('e1', 'k1')),
      deps
    );
    expect(await r.json()).toMatchObject({ ignorados: 1 });
    expect(almacen.contactos[0].nombre).toBe('');
  });

  describe('el origen del nombre (Jon, 28-nov)', () => {
    it('renombre en la agenda: si lo puso la agenda, se actualiza', async () => {
      const { almacen, deps } = armar(ANA, [
        { telefono: TEL, nombre: 'Ana vieja', nombreOrigen: 'agenda' },
      ]);
      const r = await manejarWebhook(
        pedido(contactoActualizado('e1', 'k1')),
        deps
      );
      expect(r.status).toBe(200);
      expect(almacen.contactos[0]).toMatchObject({
        nombre: 'Ana Ruiz',
        nombreOrigen: 'agenda',
      });
    });

    it('si lo escribió una persona, no se toca aunque la agenda cambie', async () => {
      const { almacen, deps } = armar(ANA, [
        { telefono: TEL, nombre: 'Ana vieja', nombreOrigen: 'persona' },
      ]);
      await manejarWebhook(pedido(contactoActualizado('e1', 'k1')), deps);
      expect(almacen.contactos[0]).toMatchObject({
        nombre: 'Ana vieja',
        nombreOrigen: 'persona',
      });
    });

    it('el nombre de perfil (origen nulo) lo reemplaza el del celular', async () => {
      const { almacen, deps } = armar(ANA, [
        { telefono: TEL, nombre: 'Juan Perfil', nombreOrigen: null },
      ]);
      await manejarWebhook(pedido(contactoActualizado('e1', 'k1')), deps);
      expect(almacen.contactos[0]).toMatchObject({
        nombre: 'Ana Ruiz',
        nombreOrigen: 'agenda',
      });
    });

    it('el relleno se completa y queda de la agenda', async () => {
      const { almacen, deps } = armar(ANA, [{ telefono: TEL, nombre: TEL }]);
      await manejarWebhook(pedido(contactoActualizado('e1', 'k1')), deps);
      expect(almacen.contactos[0]).toMatchObject({
        nombre: 'Ana Ruiz',
        nombreOrigen: 'agenda',
      });
    });
  });
});
