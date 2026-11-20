import type { Metadata } from 'next'
import { PantallaAviso } from '@/components/ecovit/pantalla-aviso'
import { urlIngresoEcovit } from '@/lib/ecovit/ingreso'

export const metadata: Metadata = { title: 'Entra con ECOVIT' }

/**
 * Llega acá solo si falta `NEXT_PUBLIC_ECOVIT_URL`: con la variable puesta,
 * el middleware manda directo al ingreso de ECOVIT.
 */
export default function SinSesionPage() {
  const ingreso = urlIngresoEcovit()
  return (
    <PantallaAviso
      titulo="Entra con tu usuario de ECOVIT"
      accion={ingreso ? { texto: 'Ir a ECOVIT', href: ingreso } : undefined}
    >
      <p>
        Conversaciones no tiene usuarios propios: se entra con la misma cuenta del
        módulo comercial de ECOVIT.
      </p>
      {!ingreso && (
        <p>
          Esta instalación no sabe dónde está ECOVIT. Falta la variable de entorno{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-foreground">NEXT_PUBLIC_ECOVIT_URL</code>.
        </p>
      )}
    </PantallaAviso>
  )
}
