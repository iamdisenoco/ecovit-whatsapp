// Qué proveedor manda, según `WHATSAPP_PROVEEDOR`. Sin dependencias pesadas:
// lo puede importar cualquier ruta (también la de Meta, que se apaga sin él).

import { ErrorConfiguracion, type Entorno, type NombreProveedor } from './tipos'

export const PROVEEDORES: readonly NombreProveedor[] = ['zernio', 'simulado', 'meta']

export function nombreProveedor(env: Entorno = process.env): NombreProveedor {
  const valor = (env.WHATSAPP_PROVEEDOR ?? '').trim().toLowerCase()
  if ((PROVEEDORES as readonly string[]).includes(valor)) return valor as NombreProveedor
  throw new ErrorConfiguracion(
    valor
      ? `WHATSAPP_PROVEEDOR="${valor}" no es válido: usa zernio, simulado o meta.`
      : 'Falta WHATSAPP_PROVEEDOR (zernio, simulado o meta) en el entorno del servidor.',
  )
}

/** Mismo valor que `nombreProveedor`, pero `null` en vez de lanzar. Para pantallas. */
export function nombreProveedorOnull(env: Entorno = process.env): NombreProveedor | null {
  try {
    return nombreProveedor(env)
  } catch {
    return null
  }
}
