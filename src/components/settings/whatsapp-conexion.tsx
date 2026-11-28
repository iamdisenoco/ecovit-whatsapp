'use client';

// ECOVIT · bloque 5. La pantalla del número con Zernio: solo mira. Las llaves
// (ZERNIO_API_KEY, ZERNIO_WEBHOOK_SECRET) y la cuenta (ZERNIO_ACCOUNT_ID) viven
// en las variables de entorno del servidor; aquí no se muestran ni se editan.
// Con WHATSAPP_PROVEEDOR=meta se muestra, debajo, la configuración de Meta que
// traía wacrm.

import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import { WhatsAppConfig } from './whatsapp-config';
import { ImportarHistorial } from './importar-historial';

interface Conexion {
  proveedor: 'zernio' | 'simulado' | 'meta' | null;
  conectado: boolean;
  detalle?: string;
  numero?: string | null;
  nombre?: string | null;
  calidad?: string | null;
  cuentaId?: string | null;
  ultimoWebhook?: string | null;
  ultimoWebhookNota?: string | null;
  /** Solo viene (en `true`) cuando quien mira es la dirección. */
  esDireccion?: boolean;
}

const NOMBRES: Record<string, string> = {
  zernio: 'WhatsApp Business',
  simulado: 'Simulado (pruebas, nada sale a WhatsApp)',
  meta: 'Meta directo',
};

function fecha(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('es-CO', {
    timeZone: 'America/Bogota',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function Fila({
  etiqueta,
  valor,
}: {
  etiqueta: string;
  valor: React.ReactNode;
}) {
  return (
    <div className="border-border flex flex-col gap-0.5 border-b py-3 last:border-b-0 sm:flex-row sm:gap-4">
      <dt className="text-muted-foreground w-48 shrink-0 text-sm">
        {etiqueta}
      </dt>
      <dd className="text-foreground min-w-0 text-sm break-words">{valor}</dd>
    </div>
  );
}

export function WhatsAppConexion() {
  const [conexion, setConexion] = useState<Conexion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const r = await fetch('/api/whatsapp/conexion', { cache: 'no-store' });
      const json = await r.json();
      if (!r.ok) throw new Error(json?.error ?? `Error ${r.status}`);
      setConexion(json as Conexion);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  return (
    <div>
      <SettingsPanelHead
        title="Número de WhatsApp"
        description="El estado de la conexión. Las llaves viven en las variables de entorno del servidor: no se ven ni se cambian desde aquí."
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void cargar()}
            disabled={cargando}
          >
            {cargando ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Volver a revisar
          </Button>
        }
      />
      <Card>
        <CardContent>
          {error ? (
            <p className="text-destructive py-3 text-sm">
              No se pudo leer el estado: {error}
            </p>
          ) : !conexion ? (
            <p className="text-muted-foreground py-3 text-sm">Revisando…</p>
          ) : (
            <dl>
              <Fila
                etiqueta="Proveedor"
                valor={
                  conexion.proveedor
                    ? NOMBRES[conexion.proveedor]
                    : 'Sin configurar'
                }
              />
              <Fila
                etiqueta="Conexión"
                valor={
                  <span
                    className={
                      conexion.conectado
                        ? 'text-foreground'
                        : 'text-destructive'
                    }
                  >
                    {conexion.conectado ? 'Conectado' : 'Sin conexión'}
                    {conexion.detalle ? (
                      <span className="text-muted-foreground block">
                        {conexion.detalle}
                      </span>
                    ) : null}
                  </span>
                }
              />
              {conexion.numero || conexion.nombre ? (
                <Fila
                  etiqueta="Número"
                  valor={[conexion.numero, conexion.nombre]
                    .filter(Boolean)
                    .join(' · ')}
                />
              ) : null}
              {conexion.calidad ? (
                <Fila etiqueta="Calidad (Meta)" valor={conexion.calidad} />
              ) : null}
              {conexion.proveedor === 'zernio' ? (
                <Fila
                  etiqueta="Cuenta del número"
                  valor={conexion.cuentaId ?? 'Sin configurar'}
                />
              ) : null}
              {conexion.ultimoWebhook !== undefined ? (
                <Fila
                  etiqueta="Último webhook"
                  valor={
                    fecha(conexion.ultimoWebhook) ??
                    conexion.ultimoWebhookNota ??
                    'Sin dato'
                  }
                />
              ) : null}
            </dl>
          )}
          {conexion?.esDireccion && conexion.proveedor === 'zernio' ? (
            <ImportarHistorial />
          ) : null}
        </CardContent>
      </Card>
      {conexion?.proveedor === 'meta' ? (
        <div className="mt-8">
          <WhatsAppConfig />
        </div>
      ) : null}
    </div>
  );
}
