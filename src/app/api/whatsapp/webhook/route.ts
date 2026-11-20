import { after } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { crearProveedor } from '@/lib/whatsapp/proveedor';
import { AlmacenSupabase } from '@/lib/whatsapp/webhook/almacen-supabase';
import { clienteServicioWebhook } from '@/lib/whatsapp/webhook/cliente-servicio';
import { manejarWebhook } from '@/lib/whatsapp/webhook/manejador';
import { despacharMotores } from '@/lib/whatsapp/webhook/motores';

// El webhook de WhatsApp (Zernio, el simulado o Meta: lo decide WHATSAPP_PROVEEDOR).
// Lo que se hace dentro de `after()` corre dentro de este tiempo máximo.
// El webhook COMPLETO de Meta que traía wacrm vive en /api/whatsapp/meta/webhook.
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return manejarWebhook(request, {
    proveedor: () => crearProveedor(),
    // Antes de responder, cada llamada a la base corta a los 1,5 s; los
    // adjuntos (en after(), hasta 16 MB) van con el cliente sin ese tope.
    almacen: () =>
      new AlmacenSupabase(clienteServicioWebhook(), process.env, supabaseAdmin()),
    despues: (tarea) => after(tarea),
    motores: despacharMotores,
  });
}
