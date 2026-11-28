// ============================================================
// Medición de la fase «contactos» del historial contra la agenda REAL del
// proveedor, solo lectura: únicamente GET, y el almacén EN MEMORIA (nada de
// Supabase). Siembra el almacén con los contactos que tienen chat, tal como los
// dejaría la fase de chats (el nombre del chat o, si no hay, el teléfono), y
// corre solo la fase de contactos. Imprime tiempos y conteos, nunca nombres ni
// teléfonos.
//
//   NODE_USE_ENV_PROXY=1 ZERNIO_API_KEY=proxy-injected \
//   node --experimental-transform-types scripts/medir-contactos.mts <accountId>
// ============================================================

import { register } from 'node:module';

// Las fuentes de `src/` importan sin extensión y con `@/`: un resolvedor chico.
const resolvedor = `
const SRC = ${JSON.stringify(new URL('../src/', import.meta.url).href)};
export async function resolve(esp, ctx, sig) {
  if (esp.startsWith('@/')) esp = SRC + esp.slice(2);
  try { return await sig(esp, ctx); } catch (e) {
    if (!(esp.startsWith('.') || esp.startsWith('file:'))) throw e;
    for (const ext of ['.ts', '/index.ts']) {
      try { return await sig(esp + ext, ctx); } catch {}
    }
    throw e;
  }
}`;
register('data:text/javascript,' + encodeURIComponent(resolvedor));

const cuentaId = process.argv[2];
if (!cuentaId) {
  console.error('Uso: medir-contactos.mts <accountId>');
  process.exit(2);
}
const apiKey = process.env.ZERNIO_API_KEY ?? '';
if (!apiKey) {
  console.error('Falta ZERNIO_API_KEY (en la nube: proxy-injected).');
  process.exit(2);
}

const rutaHistorial = '../src/lib/whatsapp/proveedor/historial.ts';
const rutaMemoria = '../src/lib/whatsapp/webhook/almacen-memoria.ts';
const rutaRegla = '../src/lib/whatsapp/webhook/contactos-supabase.ts';
const h: typeof import('../src/lib/whatsapp/proveedor/historial') =
  await import(rutaHistorial);
const {
  AlmacenMemoria,
}: typeof import('../src/lib/whatsapp/webhook/almacen-memoria') = await import(
  rutaMemoria
);
const {
  nombreUtil,
}: typeof import('../src/lib/whatsapp/webhook/contactos-supabase') =
  await import(rutaRegla);

const cuenta = { pedidos: 0, noGet: 0, respuestas429: 0 };
const fetchSoloLectura: typeof fetch = async (entrada, init) => {
  const metodo = (init?.method ?? 'GET').toUpperCase();
  if (metodo !== 'GET') {
    cuenta.noGet++;
    throw new Error(`Bloqueado: ${metodo}. Esta medición solo hace GET.`);
  }
  cuenta.pedidos++;
  const r = await fetch(entrada, init);
  if (r.status === 429) cuenta.respuestas429++;
  return r;
};
const fuente = new h.FuenteHistorialZernio({ apiKey, fetch: fetchSoloLectura });
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1. Los que tienen chat (siembra; no cuenta en el tiempo de la fase).
const almacen = new AlmacenMemoria({
  accountId: 'medicion',
  usuarioId: 'medicion',
  conectadoDesde: new Date().toISOString(),
});
let pagina: string | null = null;
for (;;) {
  let p;
  try {
    p = await fuente.conversaciones(cuentaId, pagina, 100);
  } catch (e) {
    if (e instanceof h.LimiteDeVelocidad) {
      await dormir(e.esperaMs);
      continue;
    }
    throw e;
  }
  for (const c of p.items) {
    const tel = (c.participanteId ?? '').replace(/\D/g, '');
    if (!/^\d{6,15}$/.test(tel)) continue;
    if (almacen.contactos.some((x) => x.telefono === tel)) continue;
    almacen.contactos.push({
      id: `m-${almacen.contactos.length}`,
      telefono: tel,
      waUserId: c.bsuid,
      nombre: (c.participanteNombre ?? '').trim() || tel,
    });
  }
  if (!p.siguiente) break;
  pagina = p.siguiente;
}
const sembrados = almacen.contactos.length;
const conNombreAntes = almacen.contactos.filter((c) =>
  nombreUtil(c.nombre)
).length;
const pedidosSiembra = cuenta.pedidos;

// 2. Solo la fase de contactos, por tramos como el botón.
let cursor: string | null = h.codificarCursor({
  ...h.leerCursor(null),
  fase: 'contactos',
});
const inicio = performance.now();
const tramos: Array<{ ms: number; leidos: number; nombres: number }> = [];
let leidos = 0;
let nombres = 0;
for (;;) {
  const t0 = performance.now();
  const r = await h.importarHistorial({
    almacen,
    fuente,
    cuentaId,
    cursor,
  });
  leidos += r.contactosLeidos;
  nombres += r.nombres;
  tramos.push({
    ms: Math.round(performance.now() - t0),
    leidos: r.contactosLeidos,
    nombres: r.nombres,
  });
  if (r.terminado) break;
  if (r.esperarMs) await dormir(r.esperarMs);
  cursor = r.cursor;
}
const totalMs = Math.round(performance.now() - inicio);
const conNombreDespues = almacen.contactos.filter((c) =>
  nombreUtil(c.nombre)
).length;

console.log('\n== Medición de la fase de contactos (solo GET, en memoria) ==');
console.log(
  `Contactos con chat sembrados: ${sembrados} (con nombre de letras: ${conNombreAntes}) · GET de siembra: ${pedidosSiembra}`
);
console.log(
  `Fase de contactos: ${(totalMs / 1000).toFixed(1)} s en ${tramos.length} tramo(s)`
);
console.log('Tramos:', JSON.stringify(tramos));
console.log(
  `Contactos de la agenda leídos: ${leidos} · nombres que se completarían: ${nombres}`
);
console.log(
  `Con nombre de letras después: ${conNombreDespues} de ${almacen.contactos.length} (no se creó ninguno: ${almacen.contactos.length === sembrados})`
);
console.log(
  `Pedidos GET en total: ${cuenta.pedidos} · 429: ${cuenta.respuestas429} · intentos no GET: ${cuenta.noGet}`
);
