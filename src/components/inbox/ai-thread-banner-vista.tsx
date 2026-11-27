// La parte que se ve del aviso del chat, sin lecturas ni efectos: así se
// prueba pintándola (ai-thread-banner-vista.test.tsx).
import { Sparkles, Hand, Undo2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { textoCelular, type AvisoChat } from "@/lib/inbox/celular";

type Traductor = (clave: string, valores?: Record<string, string>) => string;

export interface VistaAiBannerProps {
  aviso: AvisoChat;
  t: Traductor;
  porCelular: boolean;
  handoffSummary?: string | null;
  ultimoEcoCelular?: string | null;
  assignedAgentId?: string | null;
  ahora: number;
  busy: boolean;
  onToggle: (pausar: boolean) => void;
}

export function VistaAiBanner({
  aviso,
  t,
  porCelular,
  handoffSummary,
  ultimoEcoCelular,
  assignedAgentId,
  ahora,
  busy,
  onToggle,
}: VistaAiBannerProps) {
  if (aviso === "nada") return null;

  // Sin bot que retomar (o con el chat asignado): solo quién lo atiende.
  if (aviso === "celular") {
    return (
      <Banner tone="muted">
        <p className="min-w-0 flex-1 font-medium text-foreground">{t("celular")}</p>
      </Banner>
    );
  }

  // Paused here (a human took over, or the model handed off).
  if (aviso === "pausado") {
    return (
      <Banner tone="muted">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">{t("pausedTitle")}</p>
          {porCelular ? (
            <p className="text-muted-foreground">
              {textoCelular(t, ultimoEcoCelular, assignedAgentId, ahora)}
            </p>
          ) : (
            handoffSummary && (
              <p className="truncate text-muted-foreground" title={handoffSummary}>
                {handoffSummary}
              </p>
            )
          )}
        </div>
        <BannerButton onClick={() => onToggle(false)} busy={busy} icon={Undo2}>
          {t("resume")}
        </BannerButton>
      </Banner>
    );
  }

  // Active on this thread.
  return (
    <Banner tone="primary">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
        <span className="truncate font-medium text-foreground">
          {t("activeText")}
        </span>
      </div>
      <BannerButton onClick={() => onToggle(true)} busy={busy} icon={Hand}>
        {t("takeOver")}
      </BannerButton>
    </Banner>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "primary" | "muted";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b px-3 py-2 text-xs sm:px-4",
        tone === "primary"
          ? "border-primary/20 bg-primary/5"
          : "border-border bg-muted/40",
      )}
    >
      {children}
    </div>
  );
}

function BannerButton({
  onClick,
  busy,
  icon: Icon,
  children,
}: {
  onClick: () => void;
  busy: boolean;
  icon: typeof Hand;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Icon className="h-3 w-3" />
      )}
      {children}
    </button>
  );
}
