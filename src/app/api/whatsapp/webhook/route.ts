import { after } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { crearProveedor } from '@/lib/whatsapp/proveedor';
import { FuenteHistorialZernio } from '@/lib/whatsapp/proveedor/historial';
import { nombreProveedorOnull } from '@/lib/whatsapp/proveedor/nombre';
import { configZernioDesdeEntorno } from '@/lib/whatsapp/proveedor/zernio';
import { AlmacenSupabase } from '@/lib/whatsapp/webhook/almacen-supabase';
import { clienteServicioWebhook } from '@/lib/whatsapp/webhook/cliente-servicio';
import { manejarWebhook } from '@/lib/whatsapp/webhook/manejador';
import { despacharMotores } from '@/lib/whatsapp/webhook/motores';

// El webhook de WhatsApp (Zernio, el simulado o Meta: lo decide WHATSAPP_PROVEEDOR).
// Lo que se hace dentro de `after()` corre dentro de este tiempo máximo.
// El webhook COMPLETO de Meta que traía wacrm vive en /api/whatsapp/meta/webhook.
export const maxDuration = 60;

/** Leer un contacto entra en los 3,5 s antes de responder: corta a los 2 s. */
const LEER_CONTACTO_MS = 2_000;

/** Para `contact.updated`: solo con Zernio, que es quien tiene la agenda. */
function lectorContactos() {
  if (nombreProveedorOnull() !== 'zernio') return null;
  const config = configZernioDesdeEntorno();
  if (!config.apiKey) return null;
  return {
    lector: new FuenteHistorialZernio({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      timeoutMs: LEER_CONTACTO_MS,
    }),
    cuentaId: config.cuentaId || null,
  };
}

export async function POST(request: Request): Promise<Response> {
  return manejarWebhook(request, {
    proveedor: () => crearProveedor(),
    // Antes de responder, cada llamada a la base corta a los 1,5 s; los
    // adjuntos (en after(), hasta 16 MB) van con el cliente sin ese tope.
    almacen: () =>
      new AlmacenSupabase(clienteServicioWebhook(), process.env, supabaseAdmin()),
    despues: (tarea) => after(tarea),
    motores: despacharMotores,
    contactos: lectorContactos,
  });
}
