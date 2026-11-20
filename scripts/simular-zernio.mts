// ============================================================
// Simulador de Zernio: manda al webhook local eventos FIRMADOS como los firma
// Zernio (X-Zernio-Signature = HMAC-SHA256 hex del cuerpo crudo). No llama a
// zernio.com ni usa llaves reales.
//
//   ZERNIO_WEBHOOK_SECRET=secreto-local \
//   node --experimental-strip-types scripts/simular-zernio.mts [url]
//
// La app tiene que correr con WHATSAPP_PROVEEDOR=simulado (o zernio) y el MISMO
// secreto. Cada caso dice el código que espera y el que recibió.
// ============================================================

import { createHmac, randomUUID } from 'node:crypto';

const url = process.argv[2] ?? 'http://localhost:3000/api/whatsapp/webhook';
const secreto = (process.env.ZERNIO_WEBHOOK_SECRET ?? '').split(',')[0]?.trim();
if (!secreto) {
  console.error('Falta ZERNIO_WEBHOOK_SECRET (el mismo que tiene la app).');
  process.exit(2);
}

// Los cuerpos salen de los mismos ejemplos que usan las pruebas.
const rutaEjemplos = new URL(
  '../src/lib/whatsapp/proveedor/ejemplos-zernio.ts',
  import.meta.url
).href;
const ej = await import(rutaEjemplos);

const firmar = (crudo: string, s: string) =>
  createHmac('sha256', s).update(crudo, 'utf8').digest('hex');

async function mandar(
  nombre: string,
  cuerpo: unknown,
  esperado: number,
  firma?: string
) {
  const crudo = JSON.stringify(cuerpo);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Zernio-Webhooks/1.0 (simulado)',
      'x-zernio-event': (cuerpo as { event?: string }).event ?? '',
      'x-zernio-event-id': (cuerpo as { id?: string }).id ?? '',
      'x-zernio-signature': firma ?? firmar(crudo, secreto),
    },
    body: crudo,
  }).catch((e: unknown) => ({ status: 0, text: async () => String(e) }));
  const texto = await res.text();
  const ok = res.status === esperado;
  console.log(
    `${ok ? 'OK ' : 'MAL'} ${nombre.padEnd(34)} esperado ${esperado}, recibido ${res.status} ${texto.slice(0, 120)}`
  );
  return ok;
}

const sufijo = randomUUID().slice(0, 8);
const tel = '+573001112233';
const wamidEntrante = `wamid.sim-in-${sufijo}`;
const wamidCelular = `wamid.sim-cel-${sufijo}`;
const entrante = ej.mensajeRecibido({
  id: `evt-in-${sufijo}`,
  wamid: wamidEntrante,
  telefono: tel,
});

const resultados = [
  await mandar('entrante', entrante, 200),
  await mandar('repetido (mismo evento)', entrante, 200),
  await mandar(
    'firma mala',
    ej.mensajeRecibido({
      id: `evt-mala-${sufijo}`,
      wamid: `wamid.mala-${sufijo}`,
      telefono: tel,
    }),
    401,
    firmar('{}', secreto)
  ),
  await mandar(
    'sin firma válida (otro secreto)',
    entrante,
    401,
    firmar(JSON.stringify(entrante), `${secreto}-otro`)
  ),
  await mandar(
    'enviado desde el celular',
    ej.mensajeEnviado({
      id: `evt-cel-${sufijo}`,
      wamid: wamidCelular,
      participante: tel.replace('+', ''),
    }),
    200
  ),
  await mandar(
    'entregado',
    ej.estadoMensaje('message.delivered', {
      id: `evt-d-${sufijo}`,
      wamid: wamidCelular,
    }),
    200
  ),
  await mandar(
    'leído',
    ej.estadoMensaje('message.read', {
      id: `evt-r-${sufijo}`,
      wamid: wamidCelular,
    }),
    200
  ),
  await mandar(
    'fallido',
    ej.estadoMensaje('message.failed', {
      id: `evt-f-${sufijo}`,
      wamid: `wamid.sim-x-${sufijo}`,
      error: {
        code: '131026',
        title: 'Message undeliverable',
        message: 'Unable to deliver',
      },
    }),
    200
  ),
  await mandar(
    'cuenta desconectada',
    ej.cuentaDesconectada(`evt-disc-${sufijo}`),
    200
  ),
  await mandar(
    'evento de prueba (webhook.test)',
    { ...ej.EJEMPLO_WEBHOOK_TEST, id: `evt-test-${sufijo}` },
    200
  ),
];

const malos = resultados.filter((r) => !r).length;
console.log(
  malos === 0
    ? '\nTodos los casos dieron el código esperado.'
    : `\n${malos} caso(s) con otro código.`
);
process.exit(malos === 0 ? 0 : 1);
