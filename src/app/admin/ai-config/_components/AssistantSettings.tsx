'use client';

/**
 * Assistant — seuils et interrupteurs administrés (CDC Assistant §6.6,
 * §32.6, §32.7, CA-30 ; décision PO D-J1, lot 21).
 *
 * Section repliée de Configuration IA, avec les composants existants
 * (Switch, Input, Button) : débits, plafond mensuel, seuils d'alerte,
 * interrupteurs §39, historique. Chaque réglage montre sa valeur effective
 * et sa provenance (BO, environnement, défaut). Un réglage sensible (modèle
 * preview en production) passe par une demande, accordée par un second
 * administrateur. Historique des modifications et journal des consultations
 * sensibles en bas de section.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { apiClient } from '@/lib/api-client';
import { formatDateTime } from '@/lib/admin/format';

type Value = number | boolean;

interface Setting {
  key: string; env: string; group: string; label: string; description: string;
  type: 'int' | 'ratio' | 'usd' | 'usd_micros' | 'bool';
  value: Value; default: Value; min?: number; max?: number;
  source: 'bo' | 'env' | 'defaut'; updatedAt: string | null; doubleValidation: boolean;
}
interface Request {
  id: number; key: string; value: Value; requestedBy: number | null; requestedAt: string;
  decidedBy: number | null; decidedAt: string | null; status: string;
}
interface Data {
  adminUserId: number;
  groups: Record<string, string>;
  settings: Setting[];
  requests: Request[];
  history: Array<{ at: string; admin: string; action: string; result: string; before: unknown; after: unknown }>;
  contentReads: Array<{ at: string; adminEmail: string | null; adminUserId: number; requestId: string; result: string; reason: string }>;
  rateLimiter: { mode: string; degraded: boolean; degradedSince: string | null; lastError: string | null };
}

const SOURCE: Record<Setting['source'], string> = { bo: 'BO', env: 'environnement', defaut: 'défaut' };
const ACTION: Record<string, string> = {
  ASSISTANT_SETTING_UPDATE: 'Modification',
  ASSISTANT_SETTING_REQUEST: 'Demande (double validation)',
  ASSISTANT_SETTING_APPROVE: 'Accord',
  ASSISTANT_SETTING_REJECT: 'Refus',
  ASSISTANT_SETTING_CANCEL: 'Annulation',
};

function affiche(s: Pick<Setting, 'type'>, v: unknown): string {
  if (typeof v === 'boolean') return v ? 'activé' : 'désactivé';
  if (typeof v !== 'number') return '—';
  if (s.type === 'ratio') return `${Math.round(v * 100)} %`;
  if (s.type === 'usd_micros') return `${(v / 1_000_000).toFixed(2)} $`;
  if (s.type === 'usd') return `${v} $`;
  return v.toLocaleString('fr-FR');
}

/** Valeur d'une ligne d'historique : `{ key, value }`. */
function valeurHistorique(settings: Setting[], x: unknown): string {
  const o = x as { key?: string; value?: unknown } | null;
  if (!o || typeof o.key !== 'string') return '—';
  const def = settings.find((s) => s.key === o.key);
  return `${def?.label ?? o.key} : ${def ? affiche(def, o.value) : String(o.value)}`;
}

export function AssistantSettings() {
  const [data, setData] = useState<Data | null>(null);
  const [brouillons, setBrouillons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiClient.get<Data>('/api/admin/ai/assistant-settings'));
    } catch {
      toast.error('Réglages de l’assistant indisponibles.');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const enregistrer = async (s: Setting, value: Value) => {
    setBusy(s.key);
    try {
      const r = await apiClient.put<{ status: string }>('/api/admin/ai/assistant-settings', { key: s.key, value });
      toast.success(r.status === 'PENDING_APPROVAL'
        ? 'Demande enregistrée : un second administrateur doit la valider.'
        : `${s.label} : ${affiche(s, value)}.`);
      setBrouillons((b) => { const n = { ...b }; delete n[s.key]; return n; });
      await load();
    } catch (e) {
      toast.error((e as { message?: string }).message ?? 'Modification refusée.');
    } finally {
      setBusy(null);
    }
  };

  const decider = async (r: Request, decision: 'approve' | 'reject' | 'cancel') => {
    setBusy(`req-${r.id}`);
    try {
      await apiClient.post(`/api/admin/ai/assistant-settings/requests/${r.id}`, { decision });
      toast.success(decision === 'approve' ? 'Réglage appliqué.' : decision === 'reject' ? 'Demande refusée.' : 'Demande annulée.');
      await load();
    } catch (e) {
      toast.error((e as { message?: string }).message ?? 'Décision refusée.');
    } finally {
      setBusy(null);
    }
  };

  const groupes = data ? [...new Set(data.settings.map((s) => s.group))] : [];
  const enAttente = data?.requests.filter((r) => r.status === 'PENDING') ?? [];

  return (
    <details className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]" data-testid="assistant-settings">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-[color:var(--text-primary)]">
        Assistant · seuils et interrupteurs
        {enAttente.length > 0 && <span className="ml-2 text-xs text-amber-500">• {enAttente.length} demande(s) à valider</span>}
        {data?.rateLimiter.degraded && <span className="ml-2 text-xs text-red-400">• limiteur de débit en repli mémoire</span>}
      </summary>
      {!data ? (
        <p className="px-4 pb-4 text-sm text-[color:var(--text-muted)]">Chargement…</p>
      ) : (
        <div className="px-4 pb-4 space-y-5">
          <p className="text-xs text-[color:var(--text-muted)]">
            Pris en compte sans redémarrage, sur toutes les instances (au plus 5 s). Sans valeur enregistrée ici,
            la variable d’environnement s’applique, sinon le défaut. Chaque modification est journalisée.
          </p>

          {enAttente.length > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
              <p className="text-sm font-medium text-amber-500">Double validation en attente</p>
              {enAttente.map((r) => {
                const s = data.settings.find((x) => x.key === r.key);
                const moi = r.requestedBy === data.adminUserId;
                return (
                  <div key={r.id} className="flex flex-wrap items-center gap-2 text-sm text-[color:var(--text-secondary)]">
                    <span className="flex-1">
                      {s?.label ?? r.key} → {s ? affiche(s, r.value) : String(r.value)}
                      <span className="text-xs text-[color:var(--text-muted)]"> · demandé le {formatDateTime(r.requestedAt)}</span>
                    </span>
                    {moi ? (
                      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => decider(r, 'cancel')}>Annuler</Button>
                    ) : (
                      <>
                        <Button size="sm" disabled={busy !== null} onClick={() => decider(r, 'approve')}>Valider</Button>
                        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => decider(r, 'reject')}>Refuser</Button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {groupes.map((g) => (
            <section key={g} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">{data.groups[g] ?? g}</h3>
              {data.settings.filter((s) => s.group === g).map((s) => (
                <div key={s.key} className="flex flex-wrap items-center gap-3 border-t border-[color:var(--border-subtle)] pt-2">
                  <div className="flex-1 min-w-[220px]">
                    <p className="text-sm text-[color:var(--text-primary)]">
                      {s.label}
                      {s.doubleValidation && <span className="ml-2 text-[10px] rounded border border-amber-500/40 px-1.5 py-0.5 text-amber-500">double validation</span>}
                    </p>
                    <p className="text-xs text-[color:var(--text-muted)]">
                      {s.description} · {SOURCE[s.source]}{s.updatedAt ? ` (${formatDateTime(s.updatedAt)})` : ''} · <span className="font-mono">{s.env}</span>
                    </p>
                  </div>
                  {s.type === 'bool' ? (
                    <Switch
                      checked={s.value === true}
                      disabled={busy !== null}
                      aria-label={s.label}
                      onCheckedChange={(v) => enregistrer(s, v)}
                    />
                  ) : (
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        className="w-32"
                        aria-label={s.label}
                        min={s.min}
                        max={s.max}
                        step={s.type === 'ratio' || s.type === 'usd' ? 0.001 : 1}
                        value={brouillons[s.key] ?? String(s.value)}
                        onChange={(e) => setBrouillons((b) => ({ ...b, [s.key]: e.target.value }))}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null || brouillons[s.key] === undefined || brouillons[s.key] === String(s.value)}
                        onClick={() => enregistrer(s, Number(brouillons[s.key]))}
                      >
                        Enregistrer
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </section>
          ))}

          <section className="space-y-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Historique des modifications</h3>
            {data.history.length === 0 ? (
              <p className="text-xs text-[color:var(--text-muted)]">Aucune modification enregistrée.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[color:var(--text-muted)]">
                      <th className="py-1 pr-3 font-medium">Date</th><th className="py-1 pr-3 font-medium">Administrateur</th>
                      <th className="py-1 pr-3 font-medium">Action</th><th className="py-1 pr-3 font-medium">Avant</th>
                      <th className="py-1 pr-3 font-medium">Après</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.history.map((h, i) => (
                      <tr key={i} className="border-t border-[color:var(--border-subtle)] text-[color:var(--text-primary)]">
                        <td className="py-1 pr-3">{formatDateTime(h.at)}</td>
                        <td className="py-1 pr-3">{h.admin}</td>
                        <td className="py-1 pr-3">{ACTION[h.action] ?? h.action}{h.result !== 'SUCCESS' ? ` (${h.result})` : ''}</td>
                        <td className="py-1 pr-3">{valeurHistorique(data.settings, h.before)}</td>
                        <td className="py-1 pr-3">{valeurHistorique(data.settings, h.after)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Consultations sensibles (contenu des conversations)</h3>
            {data.contentReads.length === 0 ? (
              <p className="text-xs text-[color:var(--text-muted)]">Aucune consultation.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[color:var(--text-muted)]">
                      <th className="py-1 pr-3 font-medium">Date</th><th className="py-1 pr-3 font-medium">Administrateur</th>
                      <th className="py-1 pr-3 font-medium">Demande</th><th className="py-1 pr-3 font-medium">Résultat</th>
                      <th className="py-1 pr-3 font-medium">Justification</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.contentReads.map((c, i) => (
                      <tr key={i} className="border-t border-[color:var(--border-subtle)] text-[color:var(--text-primary)]">
                        <td className="py-1 pr-3">{formatDateTime(c.at)}</td>
                        <td className="py-1 pr-3">{c.adminEmail ?? `#${c.adminUserId}`}</td>
                        <td className="py-1 pr-3 font-mono">{c.requestId.slice(0, 8)}</td>
                        <td className="py-1 pr-3">{c.result}</td>
                        <td className="py-1 pr-3">{c.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </details>
  );
}
