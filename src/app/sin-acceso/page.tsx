import type { Metadata } from 'next'
import { PantallaAviso } from '@/components/ecovit/pantalla-aviso'
import { ecovitUrl } from '@/lib/ecovit/ingreso'

export const metadata: Metadata = { title: 'Sin acceso' }

/** Para quien tiene sesión en ECOVIT con un rol que no atiende chats. */
export default function SinAccesoPage() {
  const ecovit = ecovitUrl()
  return (
    <PantallaAviso
      titulo="Tu rol no tiene acceso a Conversaciones"
      accion={ecovit ? { texto: 'Volver a ECOVIT', href: ecovit } : undefined}
    >
      <p>
        Las conversaciones de WhatsApp las atienden los vendedores y la dirección. Si
        necesitas verlas, pídele acceso a la dirección.
      </p>
    </PantallaAviso>
  )
}
