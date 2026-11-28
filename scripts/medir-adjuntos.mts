// ============================================================
// Medición de los adjuntos del historial contra la bandeja REAL, solo lectura:
// únicamente GET, el almacén EN MEMORIA y un Storage doble que NO sube nada
// (solo anota el tamaño). De los archivos, baja como mucho `tope` (10 por
// omisión), repartidos a lo largo de la historia; al resto no le hace GET.
// Los bytes viven en memoria y se descartan: nada va a disco. No imprime
// textos, teléfonos ni nombres.
//
//   NODE_USE_ENV_PROXY=1 ZERNIO_API_KEY=proxy-injected \
//   node --experimental-transform-types scripts/medir-adjuntos.mts <accountId> [tope]
// ============================================================

import { register } from 'node:module';

const resolvedor = `
const SRC = ${JSON.stringify(new URL('../src/', import.meta.url).href)};
export async function resolve(esp, ctx, sig) {
  // Las traducciones no hacen falta para medir: un módulo vacío.
  if (esp === '@app-messages')
    return { url: 'data:text/javascript,export default {}', shortCircuit: true };
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
const tope = Number(process.argv[3] ?? '10');
const apiKey = process.env.ZERNIO_API_KEY ?? '';
if (!cuentaId || !apiKey) {
  console.error(
    'Uso: ZERNIO_API_KEY=… medir-adjuntos.mts <accountId> [tope de archivos]'
  );
  process.exit(2);
}

const rutaHistorial = '../src/lib/whatsapp/proveedor/historial.ts';
const rutaMemoria = '../src/lib/whatsapp/webhook/almacen-memoria.ts';
const h: typeof import('../src/lib/whatsapp/proveedor/historial') =
  await import(rutaHistorial);
const {
  AlmacenMemoria,
}: typeof import('../src/lib/whatsapp/webhook/almacen-memoria') = await import(
  rutaMemoria
);

const cuenta = {
  pedidos: 0,
  noGet: 0,
  r429: 0,
  adjuntosVistos: 0,
  vacios131051: 0,
  otrosNoSoportados: 0,
  tarjetas: 0,
};
const bajadas: Array<{
  fecha: string;
  tipo: string;
  http: number | string;
  bytes: number;
  ms: number;
}> = [];

const fetchSoloLectura: typeof fetch = async (entrada, init) => {
  const metodo = (init?.method ?? 'GET').toUpperCase();
  if (metodo !== 'GET') {
    cuenta.noGet++;
    throw new Error(`Bloqueado: ${metodo}. Esta medición solo hace GET.`);
  }
  cuenta.pedidos++;
  const r = await fetch(entrada, init);
  if (r.status === 429) cuenta.r429++;
  return r;
};

class AlmacenSinSubir extends AlmacenMemoria {
  subidos: number[] = [];
  /** El Storage doble: anota el tamaño y NO guarda los bytes. */
  override async guardarAdjunto(_ruta: string, bytes: Uint8Array) {
    this.subidos.push(bytes.byteLength);
    return true;
  }
}

const almacen = new AlmacenSinSubir({
  accountId: 'medicion',
  usuarioId: 'medicion',
  conectadoDesde: new Date().toISOString(),
});
const real = new h.FuenteHistorialZernio({ apiKey, fetch: fetchSoloLectura });
const fechaDe = new Map<string, { fecha: string; tipo: string }>();

// 232 adjuntos medidos el 28-nov: uno de cada ~23 da diez repartidos.
const PASO = 23;
const fuente: import('../src/lib/whatsapp/proveedor/historial').FuenteHistorial =
  {
    conversaciones: real.conversaciones.bind(real),
    contactos: real.contactos.bind(real),
    mensajes: async (...x) => {
      const p = await real.mensajes(...x);
      for (const m of p.items) {
        if (m.sinContenido) cuenta.vacios131051++;
        if (m.texto === 'Archivo que no se pudo mostrar') cuenta.otrosNoSoportados++;
        if (m.texto?.startsWith('Contacto')) cuenta.tarjetas++;
        const a = m.adjuntos[0];
        if (a?.url) fechaDe.set(a.url, { fecha: m.creadoEn.slice(0, 10), tipo: a.tipo ?? '?' });
      }
      return p;
    },
    adjunto: async (url, mime) => {
      const i = cuenta.adjuntosVistos++;
      // Sin GET: queda como fallo pasajero (pendiente).
      if (i % PASO !== 0 || bajadas.length >= tope)
        return { estado: 'fallo', http: null };
      const t0 = performance.now();
      const r = await real.adjunto(url, mime);
      const dato = fechaDe.get(url) ?? { fecha: '?', tipo: '?' };
      bajadas.push({
        ...dato,
        http:
          r.estado === 'bajado'
            ? 200
            : r.estado === 'vencido'
              ? r.http
              : r.estado === 'fallo'
                ? (r.http ?? 'red')
                : r.estado,
        bytes: r.estado === 'bajado' ? r.archivo.bytes.byteLength : 0,
        ms: Math.round(performance.now() - t0),
      });
      return r;
    },
  };

const inicio = performance.now();
const tramos: Array<{ ms: number; mensajes: number; bajados: number }> = [];
let cursor: string | null = null;
let ultimo: Awaited<ReturnType<typeof h.importarHistorial>> | undefined;
for (;;) {
  const t0 = performance.now();
  ultimo = await h.importarHistorial({ almacen, fuente, cuentaId, cursor });
  tramos.push({
    ms: Math.round(performance.now() - t0),
    mensajes: ultimo.mensajes,
    bajados: ultimo.adjuntosBajados,
  });
  console.error(
    `tramo ${tramos.length}: ${tramos.at(-1)!.ms} ms · chats ${ultimo.listas} · pedidos ${cuenta.pedidos} · adjuntos vistos ${cuenta.adjuntosVistos} · archivos ${bajadas.length}`
  );
  if (ultimo.terminado) break;
  // La agenda (nombres) no tiene adjuntos: se corta al terminar los chats.
  if (ultimo.cursor && h.leerCursor(ultimo.cursor).fase === 'contactos') break;
  if (ultimo.esperarMs)
    await new Promise((r) => setTimeout(r, ultimo!.esperarMs!));
  cursor = ultimo.cursor;
}
const totalMs = Math.round(performance.now() - inicio);

const ok = bajadas.filter((b) => b.http === 200);
console.log('\n== Medición de adjuntos (solo GET, nada se sube ni se guarda) ==');
console.log(`Tiempo total: ${(totalMs / 1000).toFixed(1)} s en ${tramos.length} tramos`);
console.log(`Tramo más largo: ${Math.max(...tramos.map((t) => t.ms))} ms`);
console.log(
  `Mensajes guardados: ${almacen.mensajes.length} · adjuntos vistos: ${cuenta.adjuntosVistos} · vacíos 131051 saltados: ${cuenta.vacios131051} · otros no soportados: ${cuenta.otrosNoSoportados} · tarjetas: ${cuenta.tarjetas}`
);
console.log(
  `Pedidos GET: ${cuenta.pedidos} · 429: ${cuenta.r429} · intentos no GET: ${cuenta.noGet}`
);
console.log(`Archivos pedidos: ${bajadas.length} · 200: ${ok.length} · otros:`,
  Object.fromEntries(
    Object.entries(
      bajadas.reduce<Record<string, number>>((m, b) => {
        if (b.http !== 200) m[String(b.http)] = (m[String(b.http)] ?? 0) + 1;
        return m;
      }, {})
    )
  )
);
console.table(bajadas);
if (ok.length)
  console.log(
    `Bytes: total ${ok.reduce((n, b) => n + b.bytes, 0)} · máx ${Math.max(...ok.map((b) => b.bytes))} · ms máx ${Math.max(...bajadas.map((b) => b.ms))}`
  );
console.log(`Storage doble: ${almacen.subidos.length} archivos anotados, 0 subidos`);
console.log(
  `Resultado del importador: bajados ${tramos.reduce((n, t) => n + t.bajados, 0)}`
);
