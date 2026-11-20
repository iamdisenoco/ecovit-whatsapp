"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useCan, type CanAction } from "@/hooks/use-can";

/**
 * ECOVIT · Una pantalla que solo abre quien tiene el permiso. Mientras el rol
 * no se sabe, no muestra nada (falla cerrada); sin permiso, lleva a `destino`.
 *
 * Es una comodidad de la interfaz, no la reja: la reja es la API
 * (`requireRole`) y RLS. Por eso basta con redirigir en el cliente.
 */
export function SoloConPermiso({
  accion,
  destino,
  children,
}: {
  accion: CanAction;
  destino: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const { profileLoading } = useAuth();
  // Sin rol (`accountRole` null) `useCan` da false: también se va.
  const puede = useCan(accion);
  const resuelto = !profileLoading;

  useEffect(() => {
    if (resuelto && !puede) router.replace(destino);
  }, [resuelto, puede, destino, router]);

  if (!resuelto || !puede) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Cargando" />
      </div>
    );
  }
  return <>{children}</>;
}
