"use client";

import { Component, useState, type ReactNode } from "react";
import { AlertTriangle, Building2 } from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { PanelEcovit } from "@/components/inbox/panel-ecovit";
import type { Contact } from "@/types";

type ContactoPanel = Pick<Contact, "id" | "enlace_estado" | "enlace_detalle">;

/**
 * Lo que adorna no tumba lo que sirve: si `cliente_de_conversacion` llega con
 * otra forma y el panel revienta al pintarla, cae solo el panel —con el error
 * real— y no la barra lateral ni el chat.
 */
export class LimiteErrorPanel extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[panel-ecovit] el panel del cliente falló al pintarse:", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <p
        role="status"
        className="flex items-start gap-1.5 rounded-md bg-muted px-2 py-1.5 text-[11px] leading-snug text-muted-foreground"
      >
        <AlertTriangle className="mt-px h-3 w-3 shrink-0 text-amber-500" aria-hidden />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          No se pudo mostrar el cliente de ECOVIT: {this.state.error.message}
        </span>
      </p>
    );
  }
}

/** El panel con su límite de error. La `key` lo reinicia al cambiar de chat. */
export function PanelEcovitSeguro({
  conversationId,
  contact,
}: {
  conversationId: string | null;
  contact: ContactoPanel;
}) {
  return (
    <LimiteErrorPanel key={`${conversationId ?? ""}:${contact.id}`}>
      <PanelEcovit conversationId={conversationId} contact={contact} />
    </LimiteErrorPanel>
  );
}

/**
 * Debajo de `lg` la barra lateral no existe: este botón de la cabecera del
 * chat abre una hoja desde abajo con el cliente de ECOVIT. El panel se monta
 * al abrir y se desmonta al cerrar (no lee nada mientras está cerrada).
 */
export function BotonClienteMovil({
  conversationId,
  contact,
}: {
  conversationId: string | null;
  contact: ContactoPanel | null;
}) {
  const [abierta, setAbierta] = useState(false);
  if (!contact) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setAbierta(true)}
        aria-haspopup="dialog"
        className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
      >
        <Building2 className="h-4 w-4" aria-hidden />
        Cliente
      </button>
      <Sheet open={abierta} onOpenChange={setAbierta}>
        <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto rounded-t-2xl">
          <SheetHeader className="pb-0">
            <SheetTitle>Cliente</SheetTitle>
            <SheetDescription className="sr-only">
              El cliente de ECOVIT de este número y sus oportunidades abiertas.
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">
            {abierta && <PanelEcovitSeguro conversationId={conversationId} contact={contact} />}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
