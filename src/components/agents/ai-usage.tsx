'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useLocale, useTranslations } from 'next-intl';
import { BarChart3, Bot, PencilLine } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/dashboard/skeleton';
import { BarChart } from '@/components/tremor/bar-chart';
import { formatCompactNumber } from '@/lib/currency';
import { parseISO } from 'date-fns';

interface UsageResponse {
  window_days: number;
  truncated: boolean;
  totals: {
    calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  by_mode: {
    auto_reply: { calls: number; tokens: number };
    draft: { calls: number; tokens: number };
  };
  by_model: {
    model: string;
    provider: string;
    calls: number;
    tokens: number;
  }[];
  daily: { date: string; tokens: number; calls: number; usd?: number }[];
  /** ECOVIT · RF-M03.11: el gasto en USD de las mismas filas. */
  gasto?: {
    total_usd: number | null;
    sin_costo: number;
    /** `cliente`: nombre o teléfono del contacto; null si no se pudo leer. */
    por_chat: { conversation_id: string; usd: number; llamadas: number; cliente?: string | null }[];
    tope_usd_mes: number | null;
    /** El mes de Bogotá (AAAA-MM) y su gasto: lo único que se compara con el tope. */
    mes?: string;
    gasto_mes_usd?: number | null;
  };
}

const usd = (v: number) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(v);

const WINDOWS = [7, 30, 90] as const;

/**
 * Token-spend dashboard for the account's BYO key. Admin-only (spend is
 * billing-class), mirroring the `ai_usage_log` SELECT policy and the
 * `GET /api/ai/usage` route. Renders nothing for non-admins.
 */
export function AiUsageCard() {
  const t = useTranslations('Agents.usage');
  const locale = useLocale();
  const { accountId, accountRole, profileLoading } = useAuth();
  const canView = accountRole ? canEditSettings(accountRole) : false;

  const [days, setDays] = useState<number>(30);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<UsageResponse | null>(null);
  const loadedRef = useRef<string | null>(null);

  const fetchUsage = useCallback(async (windowDays: number) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        days: String(windowDays),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      const res = await fetch(`/api/ai/usage?${params}`, {
        cache: 'no-store',
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(json?.error ?? t('loadFailed'));
        setData(null);
        return;
      }
      setData(json as UsageResponse);
    } catch {
      toast.error(t('loadFailed'));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!canView || !accountId) return;
    // Refetch on account switch or window change.
    const key = `${accountId}:${days}`;
    if (loadedRef.current === key) return;
    loadedRef.current = key;
    void fetchUsage(days);
  }, [canView, accountId, days, fetchUsage]);

  if (profileLoading || !canView) return null;

  // The category label doubles as the data key so the chart tooltip
  // shows the translated series name.
  const tokensLabel = t('tokens');
  const chartData =
    data?.daily.map((d) => ({
      day: parseISO(d.date).toLocaleDateString(locale, { month: 'short', day: 'numeric' }),
      [tokensLabel]: d.tokens,
    })) ?? [];
  const hasSpend = (data?.totals.total_tokens ?? 0) > 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <BarChart3 className="h-4 w-4 text-primary" /> {t('title')}
            </CardTitle>
            <CardDescription>
              {t('description')}
            </CardDescription>
          </div>
          <Select
            value={String(days)}
            onValueChange={(v) => setDays(Number(v))}
          >
            <SelectTrigger className="w-auto min-w-36 flex-shrink-0 whitespace-nowrap">
              {/* Sin función, base-ui muestra el valor crudo («30»). */}
              <SelectValue>{(v: string) => t('window', { days: Number(v) })}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {WINDOWS.map((w) => (
                <SelectItem key={w} value={String(w)}>
                  {t('window', { days: w })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading || !data ? (
          <Skeleton className="h-[220px] w-full" />
        ) : !hasSpend ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <BarChart3 className="h-8 w-8 opacity-40" />
            <p>{t('empty', { days: data.window_days })}</p>
            <p className="text-xs">
              {t('emptyHint')}
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label={t('totalTokens')} value={formatCompactNumber(data.totals.total_tokens)} />
              <Stat label={t('llmCalls')} value={String(data.totals.calls)} />
              <Stat
                label={t('autoReply')}
                value={formatCompactNumber(data.by_mode.auto_reply.tokens)}
                icon={Bot}
              />
              <Stat
                label={t('drafts')}
                value={formatCompactNumber(data.by_mode.draft.tokens)}
                icon={PencilLine}
              />
            </div>

            {data.gasto && <GastoClaude gasto={data.gasto} dias={data.window_days} />}

            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                {t('tokensPerDay')}
              </p>
              <BarChart
                data={chartData}
                index="day"
                categories={[tokensLabel]}
                colors={['violet']}
                valueFormatter={(v) => formatCompactNumber(v)}
                showLegend={false}
                // «100.0k» no cabía en 48 px y salía «00.0k».
                yAxisWidth={64}
                className="h-[200px]"
              />
            </div>

            {data.by_model.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  {t('byModel')}
                </p>
                <ul className="divide-y divide-border rounded-md border border-border">
                  {data.by_model.map((m) => (
                    <li
                      key={`${m.provider}:${m.model}`}
                      className="flex items-center justify-between px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 truncate">
                        <span className="text-foreground">{m.model}</span>{' '}
                        <span className="text-xs text-muted-foreground">
                          ({m.provider})
                        </span>
                      </span>
                      <span className="flex-shrink-0 tabular-nums text-muted-foreground">
                        {t('modelCalls', {
                          tokens: formatCompactNumber(m.tokens),
                          count: m.calls,
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {data.truncated && (
              <p className="text-xs text-muted-foreground">
                {t('partialWindow')}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon?: typeof Bot;
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
        {value}
      </p>
    </div>
  );
}

/**
 * ECOVIT · RF-M03.11: el gasto del MES de Bogotá contra el tope mensual (la
 * misma regla con que la base lo hace cumplir), y aparte, sin tope, el de la
 * ventana elegida con los chats que más gastaron.
 */
function GastoClaude({
  gasto,
  dias,
}: {
  gasto: NonNullable<UsageResponse['gasto']>;
  dias: number;
}) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3">
        <Stat
          label={`Este mes (${gasto.mes ?? 'Bogotá'}) contra el tope`}
          value={
            gasto.gasto_mes_usd === null || gasto.gasto_mes_usd === undefined
              ? 'Sin dato'
              : `${usd(gasto.gasto_mes_usd)} de ${
                  gasto.tope_usd_mes === null ? 'tope sin definir' : usd(gasto.tope_usd_mes)
                }`
          }
        />
        <Stat
          label={`En los últimos ${dias} días`}
          value={gasto.total_usd === null ? 'Sin dato' : usd(gasto.total_usd)}
        />
      </div>
      {gasto.sin_costo > 0 && (
        <p className="text-xs text-muted-foreground">
          {gasto.sin_costo} llamadas sin costo anotado (anteriores al bot de ECOVIT): no suman.
        </p>
      )}
      {gasto.por_chat.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">Chats que más gastaron</p>
          <ul className="divide-y divide-border rounded-md border border-border">
            {gasto.por_chat.map((c) => (
              <li key={c.conversation_id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <a href={`/inbox?c=${c.conversation_id}`} className="min-w-0 truncate text-primary hover:underline">
                  {c.cliente ? `Chat con ${c.cliente}` : 'Ver chat'}
                </a>
                <span className="flex-shrink-0 tabular-nums text-muted-foreground">
                  {usd(c.usd)} · {c.llamadas} {c.llamadas === 1 ? 'llamada' : 'llamadas'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
