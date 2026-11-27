"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useAuth } from "@/hooks/use-auth";
import { fetchAiAccountStatus } from "@/lib/ai/account-status-cache";
import { MOTIVO_CELULAR } from "@/lib/whatsapp/webhook/coexistencia";
import { avisoDelChat } from "@/lib/inbox/celular";
import { VistaAiBanner } from "./ai-thread-banner-vista";

interface AiThreadBannerProps {
  conversationId: string;
  /** `conversations.ai_autoreply_disabled` — bot paused on this thread. */
  disabled: boolean;
  /** `conversations.ai_handoff_summary` — note the bot left on handoff. */
  handoffSummary?: string | null;
  /** ECOVIT · coexistencia: `created_at` del último eco del celular del chat. */
  ultimoEcoCelular?: string | null;
  /** Current assignee; when a human owns the thread the bot won't run,
   *  so the "AI active" banner is suppressed. */
  assignedAgentId?: string | null;
  /** `conversations.actualizado_en` de la MISMA lectura que el asignado: la
   *  condición de versión de tomar y retomar (mínimo 4). */
  actualizadoEn?: string | null;
  /** The acting agent. ECOVIT: ya no se usa (tomar va por la función en el servidor). */
  currentUserId?: string | null;
  /** Called after a successful toggle so the parent can patch its local
   *  conversation state (the realtime UPDATE also arrives, but this keeps
   *  the banner instant). */
  onChange?: (patch: {
    ai_autoreply_disabled: boolean;
    assigned_agent_id?: string | null;
    actualizado_en?: string;
  }) => void;
}

/**
 * Inbox banner that surfaces + controls the AI auto-reply bot per
 * conversation:
 *   - bot active here → "AI is replying automatically" + [Take over]
 *   - bot paused here → the handoff note (if any) + [Resume AI]
 * Qué aviso va lo decide `avisoDelChat`: el chat que calló el celular lo
 * muestra aunque la cuenta no tenga el bot configurado o el chat esté
 * asignado; sin celular, sin bot no hay aviso.
 */
export function AiThreadBanner({
  conversationId,
  disabled,
  handoffSummary,
  ultimoEcoCelular,
  assignedAgentId,
  actualizadoEn,
  onChange,
}: AiThreadBannerProps) {
  const t = useTranslations("Inbox.aiBanner");
  const { accountId } = useAuth();
  const [autoReplyOn, setAutoReplyOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  // Optimistic local mirror of the pause flag so the banner flips
  // instantly on click; re-seeds whenever the thread (or its server
  // state via realtime) changes.
  const [paused, setPaused] = useState(disabled);
  useEffect(() => setPaused(disabled), [conversationId, disabled]);

  // Callado por el celular: la nota es la marca, no un texto para mostrar.
  const porCelular = handoffSummary === MOTIVO_CELULAR;
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    if (!porCelular) return;
    const id = window.setInterval(() => setAhora(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [porCelular]);

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    fetchAiAccountStatus(accountId).then((s) => alive && setAutoReplyOn(s.autoReplyOn));
    return () => {
      alive = false;
    };
  }, [accountId]);

  const toggle = useCallback(
    async (paused: boolean) => {
      if (!actualizadoEn) {
        toast.error("Falta la marca de la conversación. Recarga la página.");
        return;
      }
      setBusy(true);
      try {
        // ECOVIT · bloque 4: «Tomar el control» toma el chat (si no tiene
        // dueño) y pausa la IA; «Retomar IA» suelta el chat y se lo devuelve
        // al bot. Las dos con la marca que se está viendo.
        const res = await fetch(`/api/ai/autoreply/${conversationId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accion: paused ? "tomar" : "retomar",
            visto: actualizadoEn,
            asignado_visto: assignedAgentId ?? null,
          }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          toast.error(j?.error ?? t("updateError"));
          return;
        }
        const j = (await res.json().catch(() => ({}))) as {
          assigned_agent_id?: string | null;
          actualizado_en?: string;
        };
        setPaused(paused);
        // ECOVIT: lo que dice el servidor, no lo que suponemos.
        onChange?.({
          ai_autoreply_disabled: paused,
          ...("assigned_agent_id" in j
            ? { assigned_agent_id: j.assigned_agent_id ?? null, actualizado_en: j.actualizado_en }
            : {}),
        });
        toast.success(paused ? t("tookOver") : t("resumed"));
      } catch {
        toast.error(t("networkError"));
      } finally {
        setBusy(false);
      }
    },
    [conversationId, actualizadoEn, assignedAgentId, onChange, t],
  );

  return (
    <VistaAiBanner
      aviso={avisoDelChat({
        autoReplyOn,
        pausado: paused,
        porCelular,
        asignado: assignedAgentId,
      })}
      t={t}
      porCelular={porCelular}
      handoffSummary={handoffSummary}
      ultimoEcoCelular={ultimoEcoCelular}
      assignedAgentId={assignedAgentId}
      ahora={ahora}
      busy={busy}
      onToggle={toggle}
    />
  );
}
