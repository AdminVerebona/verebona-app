"use client";

/**
 * Configuration IA — INTERVENTIONS MANUELLES et ÉTAT DE ROUTAGE — lot 86B
 * (CDC Pilotage IA V2 P6 : ACT-03, DEC-03, OPT-03, VER-08, R51, R55).
 *
 *   · Exclusions de modèles (tous les traitements ou un seul) et gels de
 *     configuration (global ou un traitement) : prioritaires jusqu'à leur
 *     levée ou au prochain import complet ; motif obligatoire ; historisés.
 *   · Routage par opération : chaîne configurée → chaîne exécutée (après
 *     exclusions et promotion), preuve du dernier import par modèle,
 *     promotion manuelle d'un modèle de la chaîne en tête (justification),
 *     annulation (retour à l'ordre configuré).
 *
 * Desktop et mobile : listes en colonne sous `sm`, formulaires en
 * `flex-wrap`, aucune table à défilement horizontal.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, Ban, Snowflake, ArrowUpToLine, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';

interface Intervention { id: number; kind: 'EXCLUSION' | 'FREEZE'; model: string | null; treatment: string | null; reason: string; createdByEmail: string | null; createdAt: string; liftedAt: string | null; liftReason: string | null }
interface Promotion { id: number; operationCode: string; model: string; origin: 'admin' | 'system'; justification: string; createdByEmail: string | null; createdAt: string; evidence: { qualified?: boolean }; revertedAt: string | null; revertReason: string | null }
interface OperationView { operationCode: string; treatment: string; configured: string[]; effective: string[]; excluded: string[]; exclusionIgnored: boolean; promotion: Promotion | null; importedEvidence: Record<string, string | null> }

const TREATMENTS = ['T1', 'T2', 'T3', 'T4', 'T6'] as const;
const selectClass = 'h-9 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-input)] px-2 text-sm text-[color:var(--text-primary)]';
const EVIDENCE: Record<string, string> = {
  admissible: 'qualifié', technical_only: 'technique seulement (ancien fichier)', never_tested: 'sans preuve', refused: 'refusé',
  inconclusive: 'non concluant', obsolete: 'preuve obsolète', in_test: 'en test',
};
const dateHeure = (d: string | null | undefined) => (d ? new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const portee = (t: string | null) => t ?? 'tous les traitements';

export function ProductionRouting({ refreshKey, onChanged }: { refreshKey: number; onChanged?: () => void }) {
  const [interventions, setInterventions] = useState<{ active: Intervention[]; history: Intervention[] } | null>(null);
  const [routing, setRouting] = useState<{ operations: OperationView[]; lastImportId: number | null; history: Promotion[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [exclusion, setExclusion] = useState({ model: '', treatment: '', reason: '' });
  const [gel, setGel] = useState({ treatment: '', reason: '' });
  const [promo, setPromo] = useState<{ operationCode: string; model: string; justification: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [i, r] = await Promise.all([
        apiClient.get<{ active: Intervention[]; history: Intervention[] }>('/api/admin/ai/config-interventions'),
        apiClient.get<{ operations: OperationView[]; lastImportId: number | null; history: Promotion[] }>('/api/admin/ai/routing'),
      ]);
      setInterventions(i); setRouting(r);
    } catch { setInterventions(null); setRouting(null); }
  }, []);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const modeles = useMemo(() => [...new Set((routing?.operations ?? []).flatMap((o) => o.configured))].sort(), [routing]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast.success(ok); await load(); onChanged?.(); } catch (e) { toast.error((e as Error).message || 'Opération impossible : rien n’a été modifié.', { duration: 12_000 }); } finally { setBusy(false); }
  };

  if (!interventions || !routing) {
    return (
      <section className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4">
        <h2 className="vb-app-section">Interventions manuelles et routage</h2>
        <p className="text-xs text-[color:var(--text-muted)]">Chargement… (ou indisponible)</p>
      </section>
    );
  }

  return (
    <section data-testid="production-routing" className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-4">
      <div className="space-y-1">
        <h2 className="vb-app-section">Interventions manuelles et routage</h2>
        <p className="text-xs text-[color:var(--text-muted)]">
          Une exclusion retire un modèle de l’exécution ; un gel interdit tout changement automatique. Elles priment jusqu’à leur levée ou au
          prochain import complet (qui les lève, après avertissement). Le routage n’ordonne que les modèles de la configuration active ;
          chaque promotion est réversible et remise à zéro par un import.
        </p>
      </div>

      {/* Interventions actives */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">En cours ({interventions.active.length})</h3>
        {interventions.active.length === 0 && <p className="text-xs text-[color:var(--text-muted)]">Aucune exclusion ni aucun gel.</p>}
        <ul className="space-y-1.5" data-testid="interventions-actives">
          {interventions.active.map((x) => (
            <li key={x.id} className="flex flex-col sm:flex-row sm:items-center gap-2 text-xs text-[color:var(--text-secondary)]">
              <span className="flex-1 min-w-0 break-words">
                {x.kind === 'EXCLUSION' ? <Ban className="inline w-3.5 h-3.5 mr-1 text-[color:var(--text-danger)]" /> : <Snowflake className="inline w-3.5 h-3.5 mr-1" />}
                {x.kind === 'EXCLUSION' ? `« ${x.model} » exclu (${portee(x.treatment)})` : `Gel (${portee(x.treatment)})`} — {x.reason}
                <span className="text-[color:var(--text-muted)]"> · {dateHeure(x.createdAt)}{x.createdByEmail ? ` · ${x.createdByEmail}` : ''}</span>
              </span>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => apiClient.post(`/api/admin/ai/config-interventions/${x.id}/lift`, {}), 'Intervention levée')}>Lever</Button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-end gap-2">
          <select className={selectClass} aria-label="Modèle à exclure" value={exclusion.model} onChange={(e) => setExclusion({ ...exclusion, model: e.target.value })}>
            <option value="">Modèle…</option>
            {modeles.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select className={selectClass} aria-label="Traitement de l’exclusion" value={exclusion.treatment} onChange={(e) => setExclusion({ ...exclusion, treatment: e.target.value })}>
            <option value="">Tous les traitements</option>
            {TREATMENTS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <Input className="h-9 w-full sm:w-64" placeholder="Motif (obligatoire)" value={exclusion.reason} onChange={(e) => setExclusion({ ...exclusion, reason: e.target.value })} />
          <Button size="sm" disabled={busy || !exclusion.model || !exclusion.reason.trim()}
            onClick={() => void act(async () => { await apiClient.post('/api/admin/ai/config-interventions', { kind: 'EXCLUSION', model: exclusion.model, treatment: exclusion.treatment || null, reason: exclusion.reason }); setExclusion({ model: '', treatment: '', reason: '' }); }, 'Modèle exclu')}>
            <Ban className="w-3.5 h-3.5 mr-1.5" /> Exclure
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <select className={selectClass} aria-label="Traitement du gel" value={gel.treatment} onChange={(e) => setGel({ ...gel, treatment: e.target.value })}>
            <option value="">Toute la configuration</option>
            {TREATMENTS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <Input className="h-9 w-full sm:w-64" placeholder="Motif (obligatoire)" value={gel.reason} onChange={(e) => setGel({ ...gel, reason: e.target.value })} />
          <Button size="sm" variant="outline" disabled={busy || !gel.reason.trim()}
            onClick={() => void act(async () => { await apiClient.post('/api/admin/ai/config-interventions', { kind: 'FREEZE', treatment: gel.treatment || null, reason: gel.reason }); setGel({ treatment: '', reason: '' }); }, 'Configuration gelée')}>
            <Snowflake className="w-3.5 h-3.5 mr-1.5" /> Geler
          </Button>
        </div>
      </div>

      {/* Routage par opération */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Routage par opération</h3>
        {routing.lastImportId === null && <p className="text-xs text-[color:var(--text-muted)]">Aucun import dans cet environnement : aucune promotion automatique possible (preuves du fichier importé requises).</p>}
        <ul className="divide-y divide-[color:var(--border-subtle)]" data-testid="routage-operations">
          {routing.operations.map((o) => (
            <li key={o.operationCode} className="py-2 space-y-1">
              <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3">
                <span className="text-xs font-mono text-[color:var(--text-primary)] sm:w-56 shrink-0 break-all">{o.treatment} · {o.operationCode}</span>
                <span className="flex-1 min-w-0 text-xs text-[color:var(--text-secondary)] break-words">
                  {o.effective.map((m, i) => (
                    <span key={m}>{i > 0 ? ' → ' : ''}{m}
                      {o.importedEvidence[m] ? <span className="text-[color:var(--text-muted)]"> ({EVIDENCE[o.importedEvidence[m]!] ?? o.importedEvidence[m]})</span> : null}
                    </span>
                  ))}
                  {o.excluded.length > 0 && <span className="text-[color:var(--text-danger)]"> · exclu : {o.excluded.join(', ')}</span>}
                  {o.exclusionIgnored && <span className="text-[color:var(--text-warning-soft)]"> · exclusion inopérante (aucun autre modèle)</span>}
                </span>
                <div className="flex flex-wrap gap-2">
                  {o.promotion && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => apiClient.post(`/api/admin/ai/routing/promotions/${o.promotion!.id}/revert`, {}), 'Promotion annulée : ordre configuré rétabli')}>
                      <Undo2 className="w-3.5 h-3.5 mr-1.5" /> Annuler la promotion
                    </Button>
                  )}
                  {o.effective.length > 1 && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => setPromo({ operationCode: o.operationCode, model: o.effective[1], justification: '' })}>
                      <ArrowUpToLine className="w-3.5 h-3.5 mr-1.5" /> Promouvoir
                    </Button>
                  )}
                </div>
              </div>
              {o.promotion && (
                <p className="text-xs text-[color:var(--text-muted)] break-words">
                  Promotion {o.promotion.origin === 'system' ? 'automatique' : 'manuelle'} de « {o.promotion.model} » le {dateHeure(o.promotion.createdAt)}
                  {o.promotion.createdByEmail ? ` par ${o.promotion.createdByEmail}` : ''} — {o.promotion.justification}
                  {o.promotion.evidence?.qualified ? '' : ' · couple non qualifié (geste manuel)'} · ordre configuré : {o.configured.join(' → ')}
                </p>
              )}
              {promo?.operationCode === o.operationCode && (
                <div className="flex flex-wrap items-end gap-2">
                  <select className={selectClass} aria-label="Modèle à promouvoir" value={promo.model} onChange={(e) => setPromo({ ...promo, model: e.target.value })}>
                    {o.effective.slice(1).map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <Input className="h-9 w-full sm:w-72" placeholder="Justification (obligatoire)" value={promo.justification} onChange={(e) => setPromo({ ...promo, justification: e.target.value })} />
                  <Button size="sm" disabled={busy || !promo.justification.trim()}
                    onClick={() => void act(async () => { await apiClient.post('/api/admin/ai/routing', promo); setPromo(null); }, 'Modèle promu en tête pour cette opération')}>
                    {busy && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />} Promouvoir en tête
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPromo(null)}>Annuler</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      {(interventions.history.length > 0 || routing.history.length > 0) && (
        <details>
          <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)]">Historique des interventions et promotions</summary>
          <ul className="mt-2 space-y-1 text-xs text-[color:var(--text-secondary)]">
            {interventions.history.map((x) => (
              <li key={`i${x.id}`} className="break-words">
                {dateHeure(x.createdAt)} · {x.kind === 'EXCLUSION' ? `exclusion « ${x.model} »` : 'gel'} ({portee(x.treatment)}) — {x.reason}
                {x.liftedAt ? ` · levé le ${dateHeure(x.liftedAt)}${x.liftReason === 'import' ? ' (import complet)' : ''}` : ' · en cours'}
              </li>
            ))}
            {routing.history.map((p) => (
              <li key={`p${p.id}`} className="break-words">
                {dateHeure(p.createdAt)} · promotion {p.operationCode} → « {p.model} » ({p.origin === 'system' ? 'automatique' : 'manuelle'})
                {p.revertedAt ? ` · annulée le ${dateHeure(p.revertedAt)} (${p.revertReason === 'import' ? 'import complet' : p.revertReason === 'superseded' ? 'remplacée' : p.revertReason === 'rollback' ? 'retour arrière' : 'administrateur'})` : ' · active'}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
