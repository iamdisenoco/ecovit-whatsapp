"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Building2,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  UserPlus,
} from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { canEditSettings } from "@/lib/auth/roles";
import { modoMuestra } from "@/lib/muestra/modo";
import { cn } from "@/lib/utils";
import {
  leerClienteDeConversacion,
  pesos,
  rutasEcovit,
  textoEtapa,
  vistaPanel,
  type LecturaPanel,
  type RutasEcovit,
  type VistaPanel,
} from "@/lib/ecovit/panel-cliente";
import type { Contact } from "@/types";

/**
 * ECOVIT · Bloque 3. El cliente de ECOVIT detrás del número del chat: su
 * nombre, su vendedor, el contacto y sus oportunidades abiertas, con enlaces
 * a ECOVIT. Lo que no se puede leer no tumba el chat: sale un aviso pequeño
 * con el error real.
 */
export function PanelEcovit({
  conversationId,
  contact,
}: {
  conversationId: string | null;
  contact: Pick<Contact, "id" | "enlace_estado" | "enlace_detalle">;
}) {
  const [lectura, setLectura] = useState<LecturaPanel | null>(null);
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    if (!conversationId) return;
    let cancelado = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLectura(null);
    leerClienteDeConversacion(createClient(), conversationId).then((l) => {
      if (!cancelado) setLectura(l);
    });
    return () => {
      cancelado = true;
    };
    // `contact.enlace_estado` va en las dependencias: si el webhook o ECOVIT
    // re-enlazan el número y la fila llega nueva, se vuelve a leer.
  }, [conversationId, contact.id, contact.enlace_estado, intento]);

  const reintentar = useCallback(() => setIntento((n) => n + 1), []);

  // Que falten los enlaces a ECOVIT es un tema de instalación: solo lo ve la
  // dirección, y nunca en la demostración (sus clientes no existen allá).
  const { accountRole } = useAuth();
  const avisoSinEnlaces = !modoMuestra() && !!accountRole && canEditSettings(accountRole);

  // Sin conversación no hay qué leer: no se queda «buscando» para siempre.
  if (!conversationId) {
    return (
      <VistaPanelEcovit
        vista={{ tipo: "sin_conversacion" }}
        aviso={null}
        rutas={rutasEcovit()}
        avisoSinEnlaces={avisoSinEnlaces}
      />
    );
  }

  return (
    <VistaPanelEcovit
      vista={vistaPanel(contact.enlace_estado, contact.enlace_detalle, lectura)}
      aviso={lectura && !lectura.ok ? lectura.error : null}
      rutas={rutasEcovit()}
      avisoSinEnlaces={avisoSinEnlaces}
      onReintentar={reintentar}
    />
  );
}

const enlace =
  "inline-flex items-center gap-1 rounded-md text-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const botonSecundario =
  "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Abre ECOVIT en otra pestaña: el chat se queda donde estaba. */
function A({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}

/** La vista pura: se prueba sola y se usa en la muestra de desarrollo. */
export function VistaPanelEcovit({
  vista,
  aviso,
  rutas,
  avisoSinEnlaces = false,
  onReintentar,
}: {
  vista: VistaPanel;
  /** El error real de la lectura, o null. */
  aviso: string | null;
  /** null si falta `NEXT_PUBLIC_ECOVIT_URL`: se muestra todo, sin enlaces. */
  rutas: RutasEcovit | null;
  /** Si sin `rutas` se le dice a quien mira que faltan los enlaces (solo la dirección). */
  avisoSinEnlaces?: boolean;
  onReintentar?: () => void;
}) {
  return (
    <section aria-labelledby="panel-ecovit-titulo" data-vista={vista.tipo}>
      <div className="flex items-center justify-between gap-2">
        <h4
          id="panel-ecovit-titulo"
          className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground"
        >
          <Building2 className="h-3 w-3" aria-hidden />
          Cliente en ECOVIT
        </h4>
        {onReintentar && vista.tipo !== "cargando" && (
          <button
            type="button"
            onClick={onReintentar}
            aria-label="Volver a leer el cliente de ECOVIT"
            title="Volver a leer"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>

      <div className="mt-2">
        <Cuerpo vista={vista} rutas={rutas} />
      </div>

      {aviso && (
        <p
          role="status"
          className="mt-2 flex items-start gap-1.5 rounded-md bg-muted px-2 py-1.5 text-[11px] leading-snug text-muted-foreground"
        >
          <AlertTriangle className="mt-px h-3 w-3 shrink-0 text-amber-500" aria-hidden />
          <span className="min-w-0">
            No se pudo leer el cliente de ECOVIT: <span className="[overflow-wrap:anywhere]">{aviso}</span>
          </span>
        </p>
      )}

      {!rutas && avisoSinEnlaces && (
        <p className="mt-2 px-1 text-[11px] text-muted-foreground">
          Los botones para abrir este cliente en ECOVIT todavía no están activos en esta
          instalación. Los activa quien la administra.
        </p>
      )}
    </section>
  );
}

function Cuerpo({ vista, rutas }: { vista: VistaPanel; rutas: RutasEcovit | null }) {
  switch (vista.tipo) {
    case "cargando":
      return (
        <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          Buscando el cliente…
        </p>
      );

    case "cliente": {
      const { cliente, contacto, oportunidades } = vista.datos;
      const nombreContacto = contacto
        ? [contacto.nombre, contacto.apellido].filter(Boolean).join(" ")
        : "";
      return (
        <div className="space-y-3">
          <div className="rounded-lg border border-border px-3 py-2.5">
            <p className="text-sm font-semibold text-foreground">{cliente.nombre}</p>
            <dl className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {nombreContacto && (
                <div className="flex gap-1">
                  <dt>Contacto:</dt>
                  <dd className="text-foreground">{nombreContacto}</dd>
                </div>
              )}
              <div className="flex gap-1">
                <dt>Vendedor:</dt>
                <dd className="text-foreground">{cliente.vendedor_nombre ?? "sin vendedor"}</dd>
              </div>
            </dl>
            {rutas && (
              <A href={rutas.cliente(cliente.id)} className={cn(enlace, "mt-2")}>
                Ver cliente
                <ExternalLink className="h-3 w-3" aria-hidden />
              </A>
            )}
          </div>

          <div>
            <p className="px-1 text-xs font-medium text-muted-foreground">
              Oportunidades abiertas{oportunidades.length > 0 ? ` (${oportunidades.length})` : ""}
            </p>
            {oportunidades.length === 0 ? (
              <p className="mt-1 px-1 text-xs text-muted-foreground">Ninguna abierta.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {oportunidades.map((o) => {
                  const fila = (
                    <>
                      <span className="block truncate text-xs font-medium text-foreground">{o.nombre}</span>
                      <span className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                        <span className="truncate">{textoEtapa(o.etapa)}</span>
                        <span className="shrink-0 tabular-nums text-foreground">
                          {o.valor_proyectado != null ? pesos(o.valor_proyectado) : "—"}
                        </span>
                      </span>
                    </>
                  );
                  return (
                    <li key={o.id}>
                      {rutas ? (
                        <A
                          href={rutas.oportunidades(cliente.id)}
                          className="block rounded-md px-2 py-1.5 transition-colors hover:bg-muted"
                        >
                          {fila}
                        </A>
                      ) : (
                        <div className="px-2 py-1.5">{fila}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {rutas && (
              <A href={rutas.crearOportunidad(cliente.id)} className={cn(botonSecundario, "mt-2 w-full")}>
                <Plus className="h-3.5 w-3.5" aria-hidden />
                Crear oportunidad
              </A>
            )}
          </div>
        </div>
      );
    }

    case "sin_conversacion":
      return (
        <p className="px-1 text-xs text-muted-foreground">Abre una conversación para ver su cliente.</p>
      );

    case "cliente_ajeno":
      return (
        <p className="px-1 text-xs text-muted-foreground">
          Este número es de un cliente de ECOVIT que no está en tu cartera.
        </p>
      );

    case "enlazado_sin_leer":
      return (
        <p className="px-1 text-xs text-muted-foreground">
          Este número está en Clientes, pero no se pudo traer el cliente.
        </p>
      );

    case "sin_contacto":
      return (
        <div className="space-y-2">
          <p className="px-1 text-xs text-foreground">Este número no está en Clientes.</p>
          <p className="px-1 text-[11px] text-muted-foreground">
            Créalo en ECOVIT con este teléfono: como cliente nuevo, o como contacto en la ficha de su cliente.
          </p>
          {rutas && (
            <A href={rutas.crearContacto()} className={cn(botonSecundario, "w-full")}>
              <UserPlus className="h-3.5 w-3.5" aria-hidden />
              Crear contacto
            </A>
          )}
        </div>
      );

    case "varios":
      return (
        <div className="space-y-1.5">
          <p className="px-1 text-xs text-foreground">Este número está en varios clientes.</p>
          <p className="px-1 text-[11px] text-muted-foreground">
            No se elige ninguno. La dirección lo resuelve en ECOVIT dejando el teléfono en un solo contacto.
          </p>
          {vista.detalle && <p className="px-1 text-[11px] text-muted-foreground">{vista.detalle}</p>}
          {rutas && (
            <A href={rutas.clientes()} className={cn(enlace, "px-1")}>
              Ir a Clientes
              <ExternalLink className="h-3 w-3" aria-hidden />
            </A>
          )}
        </div>
      );

    case "telefono_invalido":
      return (
        <div className="space-y-1.5">
          <p className="px-1 text-xs text-foreground">Este número no se puede buscar en Clientes.</p>
          {vista.detalle && <p className="px-1 text-[11px] text-muted-foreground">{vista.detalle}</p>}
        </div>
      );

    case "error_enlace":
      return (
        <div className="space-y-1.5">
          <p className="px-1 text-xs text-foreground">No se pudo enlazar este número con Clientes.</p>
          <p className="px-1 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
            {vista.detalle ?? "La base no dejó el detalle del error."}
          </p>
        </div>
      );
  }
}
