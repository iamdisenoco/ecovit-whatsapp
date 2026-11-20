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
import { ErrorConfiguracion, type ProveedorWhatsApp } from '../proveedor/tipos';
import type { AlmacenWhatsApp } from './almacen';
import { guardarAdjuntoEntrante } from './adjuntos';
import { Procesador, type TrabajoMotores } from './procesar';

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
}

function json(cuerpo: unknown, status: number): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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
  let resultado;
  try {
    resultado = await new Procesador(almacen).procesar(eventos);
  } catch (err) {
    console.error(
      '[webhook] no se pudo procesar; el proveedor reintentará:',
      err instanceof Error ? err.message : err
    );
    return json({ error: 'No se pudo procesar el evento' }, 500);
  }

  if (resultado.trabajos.length > 0) {
    const trabajos = resultado.trabajos;
    deps.despues(async () => {
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
    });
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
