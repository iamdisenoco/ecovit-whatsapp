// ============================================================
// Medición del importador del historial contra la bandeja REAL del proveedor,
// solo lectura: únicamente GET, y lo que se guarda va al almacén EN MEMORIA
// (nada de Supabase). Imprime tiempos y conteos, nunca textos ni teléfonos
// completos (se enmascaran como «••• últimos 4»).
//
//   NODE_USE_ENV_PROXY=1 ZERNIO_API_KEY=proxy-injected \
//   node --experimental-transform-types scripts/medir-historial.mts <accountId> [chats] [conectadoDesde ISO]
//
// En la nube el proxy pone la llave verdadera; sin `NODE_USE_ENV_PROXY=1` el
// `fetch` de Node no pasa por el proxy y responde 403.
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
const maxChats = Number(process.argv[3] ?? '10');
if (!cuentaId) {
  console.error('Uso: medir-historial.mts <accountId> [chats]');
  process.exit(2);
}
const apiKey = process.env.ZERNIO_API_KEY ?? '';
if (!apiKey) {
  console.error('Falta ZERNIO_API_KEY (en la nube: proxy-injected).');
  process.exit(2);
}

// Las rutas van en variables: así `tsc` no exige `allowImportingTsExtensions`.
const rutaHistorial = '../src/lib/whatsapp/proveedor/historial.ts';
const rutaMemoria = '../src/lib/whatsapp/webhook/almacen-memoria.ts';
const h: typeof import('../src/lib/whatsapp/proveedor/historial') =
  await import(rutaHistorial);
const {
  AlmacenMemoria,
}: typeof import('../src/lib/whatsapp/webhook/almacen-memoria') = await import(
  rutaMemoria
);

const mascara = (s: string | null | undefined) =>
  s ? `••• ${s.replace(/\D/g, '').slice(-4)}` : '(sin dato)';

// Lo que se ve del formato crudo, para saber si algo no encajó.
const formato = {
  pedidos: 0,
  noGet: 0,
  respuestas429: 0,
  clavesMensaje: new Set<string>(),
  direcciones: new Map<string, number>(),
  estados: new Map<string, number>(),
  tiposAdjunto: new Map<string, number>(),
  clavesAdjunto: new Set<string>(),
  fuentes: new Map<string, number>(),
  sinIdOFecha: 0,
};
const sumar = (m: Map<string, number>, k: unknown) =>
  m.set(String(k), (m.get(String(k)) ?? 0) + 1);

const fetchSoloLectura: typeof fetch = async (entrada, init) => {
  const metodo = (init?.method ?? 'GET').toUpperCase();
  if (metodo !== 'GET') {
    formato.noGet++;
    throw new Error(`Bloqueado: ${metodo}. Esta medición solo hace GET.`);
  }
  formato.pedidos++;
  const r = await fetch(entrada, init);
  if (r.status === 429) formato.respuestas429++;
  const texto = await r.clone().text();
  try {
    const json = JSON.parse(texto);
    for (const m of json.messages ?? []) {
      Object.keys(m).forEach((k) => formato.clavesMensaje.add(k));
      sumar(formato.direcciones, m.direction);
      sumar(formato.estados, m.deliveryStatus);
      sumar(formato.fuentes, m.metadata?.source ?? '(ninguna)');
      if (!m.id || !(m.createdAt || m.sentAt)) formato.sinIdOFecha++;
      for (const a of m.attachments ?? []) {
        Object.keys(a).forEach((k) => formato.clavesAdjunto.add(k));
        sumar(formato.tiposAdjunto, a.type);
      }
    }
  } catch {
    /* no era JSON: lo dirá el importador */
  }
  return r;
};

const almacen = new AlmacenMemoria({
  accountId: 'medicion',
  usuarioId: 'medicion',
  // La fecha de conexión: tercer argumento o, si no viene, ahora (todo lo
  // anterior es historia).
  conectadoDesde: process.argv[4] ?? new Date().toISOString(),
});
const fuente = new h.FuenteHistorialZernio({ apiKey, fetch: fetchSoloLectura });

const inicio = performance.now();
const tramos: Array<{ ms: number; procesadas: number; mensajes: number }> = [];
let cursor: string | null = null;
let ultimo: Awaited<ReturnType<typeof h.importarHistorial>> | undefined;
for (;;) {
  const t0 = performance.now();
  ultimo = await h.importarHistorial({
    almacen,
    fuente,
    cuentaId,
    cursor,
    maxConversaciones: maxChats - (ultimo?.listas ?? 0),
  });
  tramos.push({
    ms: Math.round(performance.now() - t0),
    procesadas: ultimo.procesadas,
    mensajes: ultimo.mensajes,
  });
  if (ultimo.terminado || ultimo.listas >= maxChats) break;
  const espera = ultimo.esperarMs;
  if (espera) await new Promise((r) => setTimeout(r, espera));
  cursor = ultimo.cursor;
}
const totalMs = Math.round(performance.now() - inicio);

const porChat = almacen.conversaciones.map((c) => {
  const contacto = almacen.contactos.find((x) => x.id === c.contact_id);
  const filas = almacen.mensajes.filter((m) => m.conversation_id === c.id);
  const fechas = filas.map((m) => m.created_at).sort();
  return {
    chat: mascara(contacto?.telefono),
    mensajes: filas.length,
    entrantes: filas.filter((m) => m.sender_type === 'customer').length,
    salientes: filas.filter((m) => m.sender_type === 'agent').length,
    adjuntos: filas.filter((m) => m.content_type !== 'text').length,
    desde: fechas[0]?.slice(0, 10) ?? '-',
    hasta: fechas.at(-1)?.slice(0, 10) ?? '-',
  };
});

console.log('\n== Medición del historial (solo GET, almacén en memoria) ==');
console.log(
  `Tiempo total: ${(totalMs / 1000).toFixed(1)} s en ${tramos.length} tramo(s)`
);
console.log('Tramos:', JSON.stringify(tramos));
console.log(
  `Chats: ${ultimo.listas} · mensajes guardados: ${almacen.mensajes.length} · saltados: ${ultimo.saltados}`
);
console.log(
  `Contactos: ${almacen.contactos.length} · conversaciones: ${almacen.conversaciones.length}`
);
console.log(
  `Pedidos GET: ${formato.pedidos} · 429: ${formato.respuestas429} · intentos no GET: ${formato.noGet}`
);
console.table(porChat);
console.log('Formato visto:');
console.log(
  '  claves de mensaje:',
  [...formato.clavesMensaje].sort().join(', ')
);
console.log('  direction:', Object.fromEntries(formato.direcciones));
console.log('  deliveryStatus:', Object.fromEntries(formato.estados));
console.log('  metadata.source:', Object.fromEntries(formato.fuentes));
console.log('  adjuntos (type):', Object.fromEntries(formato.tiposAdjunto));
console.log(
  '  claves de adjunto:',
  [...formato.clavesAdjunto].sort().join(', ') || '(ninguno)'
);
console.log('  mensajes sin id o fecha:', formato.sinIdOFecha);
