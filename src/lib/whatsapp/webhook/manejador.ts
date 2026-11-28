// ============================================================
// El webhook de WhatsApp, sin saber qué proveedor hay detrás (plan.md §3):
//
//   1. lee el cuerpo crudo UNA vez y verifica la firma → si no, 401 y nada se guarda;
//   2. normaliza los eventos con el proveedor;
//   3. deduplica (id del evento y wamid) y guarda con la clave de servicio;
//   4. responde 200 enseguida (Zernio pide < 5 s);
//   5. en `after()`: baja los adjuntos y despierta a los motores y al bot.
//
// Si guardar falla, responde 500 sin marcar el evento: Zernio reintenta (hasta
// 7 veces en unas 51 h) y el wamid impide guardar dos veces lo que sí entró.
// Está aparte de `route.ts` para poder probarlo con un almacén en memoria.
// ============================================================

import { readCappedBody } from '../webhook-body';
import {
  LimiteDeVelocidad,
  type LectorContactos,
} from '../proveedor/historial';
import { ErrorConfiguracion, type ProveedorWhatsApp } from '../proveedor/tipos';
import { EventoEnCurso, type AlmacenWhatsApp } from './almacen';
import { guardarAdjuntoEntrante } from './adjuntos';
import {
  Procesador,
  type ResultadoProcesar,
  type TrabajoMotores,
  type TrabajoPosterior,
} from './procesar';

/** Zernio pide < 5 s: lo de antes de responder tiene 3,5 s en total. */
export const PRESUPUESTO_MS = 3500;
/** Lo que se le pide a Zernio que espere al responder 503. */
export const REINTENTAR_EN_S = 30;

export interface DependenciasWebhook {
  /** Puede lanzar `ErrorConfiguracion` (falta WHATSAPP_PROVEEDOR). */
  proveedor: () => ProveedorWhatsApp;
  almacen: () => AlmacenWhatsApp;
  /** `after()` de Next en la ruta; en las pruebas, una cola. */
  despues: (tarea: () => Promise<void>) => void;
  motores: (
    trabajo: TrabajoMotores,
    proveedor: ProveedorWhatsApp['nombre']
  ) => Promise<void>;
  /**
   * Para `contact.updated`: cómo leer un contacto del proveedor (solo GET) y la
   * cuenta del número. `null` o ausente: el evento se reconoce y no se aplica.
   */
  contactos?: () => { lector: LectorContactos; cuentaId: string | null } | null;
  /** Tiempo total antes de responder 503 (por defecto PRESUPUESTO_MS). */
  presupuestoMs?: number;
}

function json(
  cuerpo: unknown,
  status: number,
  extra: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}

/** 503 + Retry-After: Zernio reintenta antes y no lo cuenta como definitivo. */
function vuelvaLuego(error: string): Response {
  return json({ error }, 503, { 'Retry-After': String(REINTENTAR_EN_S) });
}

function correrTrabajos(
  trabajos: TrabajoPosterior[],
  proveedor: ProveedorWhatsApp,
  almacen: AlmacenWhatsApp,
  deps: DependenciasWebhook
) {
  return async () => {
    for (const trabajo of trabajos) {
      try {
        if (trabajo.clase === 'adjunto')
          await guardarAdjuntoEntrante(proveedor, almacen, trabajo);
        else await deps.motores(trabajo, proveedor.nombre);
      } catch (err) {
        console.error(
          `[webhook] falló el trabajo posterior (${trabajo.clase}):`,
          err
        );
      }
    }
  };
}

const AGOTADO = Symbol('agotado');

export async function manejarWebhook(
  request: Request,
  deps: DependenciasWebhook
): Promise<Response> {
  const cuerpo = await readCappedBody(request);
  if (cuerpo === null) return json({ error: 'Cuerpo demasiado grande' }, 413);

  let proveedor: ProveedorWhatsApp;
  try {
    proveedor = deps.proveedor();
  } catch (err) {
    // Configuración del servidor: 500 para que el proveedor reintente cuando se arregle.
    const motivo =
      err instanceof ErrorConfiguracion ? err.message : String(err);
    console.error('[webhook] sin proveedor:', motivo);
    return json({ error: 'WhatsApp no está configurado en el servidor' }, 500);
  }

  // Sin secreto configurado no hay cómo verificar: 503, que Zernio reintenta.
  // Un 4xx es definitivo para Zernio y se perderían todos los eventos.
  if (!proveedor.firmaConfigurada()) {
    console.error(
      '[webhook] sin secreto de firma configurado: se pide reintentar más tarde'
    );
    return vuelvaLuego(
      'El secreto de firma no está configurado en el servidor'
    );
  }

  if (!proveedor.verificarFirma(cuerpo, request.headers)) {
    console.warn(
      '[webhook] firma inválida o sin secreto configurado: rechazado'
    );
    return json({ error: 'Firma inválida' }, 401);
  }

  let datos: unknown;
  try {
    datos = JSON.parse(cuerpo);
  } catch {
    return json({ error: 'JSON inválido' }, 400);
  }

  const eventos = proveedor.leerWebhook(datos);
  const almacen = deps.almacen();
  const contactos = deps.contactos?.() ?? null;
  const promesa = new Procesador(almacen, {
    contactos: contactos?.lector ?? null,
    cuentaId: contactos?.cuentaId ?? null,
  }).procesar(eventos);
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  const agotado = new Promise<typeof AGOTADO>((r) => {
    temporizador = setTimeout(
      () => r(AGOTADO),
      deps.presupuestoMs ?? PRESUPUESTO_MS
    );
  });
  let resultado: ResultadoProcesar;
  try {
    const r = await Promise.race([promesa, agotado]);
    if (r === AGOTADO) {
      // Lo que ya va sigue corriendo; si termina bien, cierra el evento y sus
      // trabajos corren igual, y el reintento de Zernio lo verá «procesado».
      deps.despues(async () => {
        const tarde = await promesa.catch(() => null);
        if (tarde)
          await correrTrabajos(tarde.trabajos, proveedor, almacen, deps)();
      });
      console.warn('[webhook] se agotó el tiempo antes de responder: 503');
      return vuelvaLuego('La base tardó demasiado; reintente');
    }
    resultado = r;
  } catch (err) {
    if (err instanceof EventoEnCurso) {
      console.warn('[webhook]', err.message);
      return vuelvaLuego('El evento se está procesando');
    }
    // El proveedor pidió esperar al leer un contacto: que reintente más tarde.
    if (err instanceof LimiteDeVelocidad) {
      console.warn('[webhook] el proveedor pidió esperar; se pide reintentar');
      return vuelvaLuego('Demasiados pedidos; reintente');
    }
    console.error(
      '[webhook] no se pudo procesar; el proveedor reintentará:',
      err instanceof Error ? err.message : err
    );
    return json({ error: 'No se pudo procesar el evento' }, 500);
  } finally {
    clearTimeout(temporizador);
  }

  if (resultado.trabajos.length > 0) {
    deps.despues(correrTrabajos(resultado.trabajos, proveedor, almacen, deps));
  }

  return json(
    {
      recibido: true,
      procesados: resultado.procesados,
      repetidos: resultado.repetidos,
      ignorados: resultado.ignorados,
    },
    200
  );
}
