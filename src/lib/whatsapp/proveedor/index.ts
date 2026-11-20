// ============================================================
// La fábrica del proveedor (RF-M03.8). Lee `WHATSAPP_PROVEEDOR`:
//   zernio   → el de producción (guía docs/guias/whatsapp-zernio.md);
//   simulado → mismo formato que Zernio, sin red (pruebas y demostración);
//   meta     → Meta directo, lo que traía wacrm.
// Sin la variable o con otro valor, lanza: es mejor que el webhook responda 500
// (y Zernio reintente) que procesar con el proveedor equivocado.
// ============================================================

import { leerCredencialesMeta } from '../config-servidor'
import { ProveedorMeta } from './meta'
import { ProveedorSimulado } from './simulado'
import { ProveedorZernio, configZernioDesdeEntorno } from './zernio'
import { nombreProveedor } from './nombre'
import type { Entorno, ProveedorWhatsApp } from './tipos'

export * from './tipos'
export { PROVEEDORES, nombreProveedor, nombreProveedorOnull } from './nombre'

let simuladoCompartido: ProveedorSimulado | null = null

/**
 * El proveedor del servidor. `accountId` solo lo usa Meta, que guarda su token
 * cifrado en `whatsapp_config`; Zernio y el simulado leen el entorno.
 */
export function crearProveedor(
  opciones: { accountId?: string | null; env?: Entorno } = {},
): ProveedorWhatsApp {
  const env = opciones.env ?? process.env
  const nombre = nombreProveedor(env)
  if (nombre === 'zernio') return new ProveedorZernio(configZernioDesdeEntorno(env))
  if (nombre === 'simulado') {
    // Uno por proceso: así los envíos simulados se pueden mirar después.
    simuladoCompartido ??= ProveedorSimulado.desdeEntorno(env)
    return simuladoCompartido
  }
  const accountId = opciones.accountId ?? null
  return new ProveedorMeta(async () => {
    if (!accountId) return null
    const c = await leerCredencialesMeta(accountId)
    return c ? { phoneNumberId: c.phoneNumberId, accessToken: c.accessToken } : null
  })
}
