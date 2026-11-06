'use client';

/**
 * Lot 113I — Amélioration automatique : budget, traitements, file et politique
 * administrée (CDC V2 BO-02, BO-04, BO-05, BO-07, UI-003, MAN-02, RLS-004).
 *
 * Sous-partie de la section EXISTANTE « Promotion automatique » (Configuration
 * IA) — aucun second back-office. Données lues par la route existante
 * `/api/admin/ai/promotion` (vue `improvement`), politique enregistrée par la
 * route existante `/api/admin/ai/cost-settings` (révision attendue + motif,
 * conflit = 409). Aucune action sur simple affichage (BO-09). Cartes empilées
 * (desktop et mobile), boutons ≥ 44 px en mobile, charte Sérénité (tokens).
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { formatDateTime } from '@/lib/admin/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

export interface ImprovementView {
  budget: {
    month: string; policyVersion: number; envelope: { totalEur: number; experimentEur: number; monitorEur: number }; alerts: { infoEur: number; vigilanceEur: number };
    phases: Record<'EXPERIMENT' | 'MONITOR', { settledEur: number; reservedEur: number; unreconciledEur: number; remainingEur: number }>;
    totalCommittedEur: number; unreconciled: number; underestimated: number; fx: { usdToEur: number | null; source: string | null; date: string | null; marginRatio: number | null }; blocked: string | null; available: boolean;
  };
  policy: {
    version: number; updatedAt: string | null; budget: { monthlyEur: number; experimentEur: number; monitorEur: number; infoAlertEur: number; vigilanceAlertEur: number };
    fx: { usdToEur: number | null; source: string | null; date: string | null; marginRatio: number | null }; costBound: { safetyMultiplier: number | null; attachmentMaxTokens: number | null };
    variants: { maxPerObjective: number }; economics: Record<string, { maxExtraCostMicrosPerCall: number | null; maxP95Ms: number | null } | undefined>; usage: { minCallsValidated: number };
    verifiedStableModels: Array<{ model: string; version: string | null; source: string; verifiedAt: string }>; suggestions: { fxMarginRatio: number; safetyMultiplier: number };
  };
  queue: Array<{ id: number; treatment: string; kind: string; status: string; priority: string; variantCount: number; nextEligibleMonth: string | null; createdAt: string; reason: string | null }>;
  treatments: Array<{
    treatment: string; effectiveVersionId: number | null; fingerprint: string | null; qualification: string; qualificationLabel: string;
    watch: { candidateVersionId: number; status: string | null; label: string; activatedAt: string | null; sevenDayReviewAt: string | null; lastObservedAt: string | null } | null;
    headObjective: { id: number; kind: string; status: string; priority: string; createdAt: string; reason: string | null } | null;
    capability: { state: string; cause: string | null };
  }>;
}

const OBJECTIVE_LABELS: Record<string, string> = {
  QUEUED: 'en file', WAITING_BUDGET: 'en attente du budget (pas un échec)', WAITING_PREREQUISITE: 'en attente d’un prérequis', EXPERIMENTING: 'en expérimentation',
  QUALIFYING: 'en qualification', BLOCKED: 'bloqué', COMPLETED_WITH_PROMOTION: 'promu (non encore validé en usage)', COMPLETED_NO_GAIN: 'sans gain',
  INCONCLUSIVE: 'non concluant', ABANDONED: 'abandonné / suspendu', SUPERSEDED: 'dépassé', DETECTED: 'détecté', SCREENING: 'en présélection', ELIGIBLE: 'éligible',
};
const CAPABILITY_LABELS: Record<string, string> = {
  OBSERVATION_ONLY: 'observation seulement', QUALIFICATION_AVAILABLE: 'qualification possible, promotion bloquée', AUTONOMOUS_PROMOTION_READY: 'promotion autonome possible',
  AUTONOMOUS_ACTIVE: 'promotion autonome active (surveillée)', BLOCKED: 'bloqué',
};

const eur = (n: number) => `${n.toFixed(2)} €`;
const num = (v: string): number | null => (v.trim() === '' ? null : Number(v.replace(',', '.')));

export function ImprovementPanel({ view, onSaved }: { view: ImprovementView; onSaved: () => void }) {
  const b = view.budget;
  const p = view.policy;
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState(() => ({
    monthlyEur: String(p.budget.monthlyEur), experimentEur: String(p.budget.experimentEur), monitorEur: String(p.budget.monitorEur),
    infoAlertEur: String(p.budget.infoAlertEur), vigilanceAlertEur: String(p.budget.vigilanceAlertEur),
    usdToEur: p.fx.usdToEur == null ? '' : String(p.fx.usdToEur), fxSource: p.fx.source ?? '', fxDate: p.fx.date ?? '', marginRatio: p.fx.marginRatio == null ? '' : String(p.fx.marginRatio),
    safetyMultiplier: p.costBound.safetyMultiplier == null ? '' : String(p.costBound.safetyMultiplier), attachmentMaxTokens: p.costBound.attachmentMaxTokens == null ? '' : String(p.costBound.attachmentMaxTokens),
    maxPerObjective: String(p.variants.maxPerObjective), minCallsValidated: String(p.usage.minCallsValidated),
    economics: Object.fromEntries(view.treatments.map((t) => [t.treatment, { extra: p.economics[t.treatment]?.maxExtraCostMicrosPerCall == null ? '' : String(p.economics[t.treatment]!.maxExtraCostMicrosPerCall), p95: p.economics[t.treatment]?.maxP95Ms == null ? '' : String(p.economics[t.treatment]!.maxP95Ms) }])) as Record<string, { extra: string; p95: string }>,
    stable: p.verifiedStableModels.map((m) => `${m.model} | ${m.source}${m.version ? ` | ${m.version}` : ''}`).join('\n'),
    reason: '',
  }));
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const economics = Object.fromEntries(Object.entries(f.economics).filter(([, v]) => v.extra.trim() || v.p95.trim()).map(([t, v]) => [t, { maxExtraCostMicrosPerCall: num(v.extra), maxP95Ms: num(v.p95) }]));
      const verifiedStableModels = f.stable.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [model, source, version] = l.split('|').map((x) => x.trim()); return { model, source, version: version || null }; });
      const r = await apiClient.put<{ saved: boolean; impacts: string[] }>('/api/admin/ai/cost-settings', {
        expectedVersion: p.version, reason: f.reason,
        improvementPolicy: {
          budget: { monthlyEur: num(f.monthlyEur), experimentEur: num(f.experimentEur), monitorEur: num(f.monitorEur), infoAlertEur: num(f.infoAlertEur), vigilanceAlertEur: num(f.vigilanceAlertEur) },
          fx: { usdToEur: num(f.usdToEur), source: f.fxSource, date: f.fxDate, marginRatio: num(f.marginRatio) },
          costBound: { safetyMultiplier: num(f.safetyMultiplier), attachmentMaxTokens: num(f.attachmentMaxTokens) },
          variants: { maxPerObjective: num(f.maxPerObjective) }, usage: { minCallsValidated: num(f.minCallsValidated) }, economics, verifiedStableModels,
        },
      });
      toast.success(r.saved ? `Politique enregistrée. ${r.impacts.join(' ')}` : 'Aucun changement.');
      setEdit(false);
      onSaved();
    } catch (e) {
      toast.error((e as Error).message || 'Enregistrement refusé.');
    } finally {
      setSaving(false);
    }
  };
  const field = (label: string, key: keyof typeof f, hint?: string) => (
    <label className="block text-xs text-[color:var(--text-secondary)] space-y-0.5">
      <span>{label}{hint ? <span className="text-[color:var(--text-muted)]"> — {hint}</span> : null}</span>
      <Input className="w-full min-h-[44px] sm:min-h-0" value={f[key] as string} onChange={(e) => setF({ ...f, [key]: e.target.value })} />
    </label>
  );

  return (
    <section className="space-y-2" aria-label="Amélioration automatique" data-testid="improvement-panel">
      <h3 className="text-sm font-medium text-[color:var(--text-primary)]">(f) Amélioration automatique — budget, traitements, file</h3>

      <div className="rounded-lg border border-[color:var(--border-subtle)] p-2 text-xs space-y-1 break-words" data-testid="improvement-budget">
        <p className="font-medium text-[color:var(--text-primary)]">Budget d’amélioration {b.month} (mois UTC) : {eur(b.totalCommittedEur)} engagés sur {eur(b.envelope.totalEur)}</p>
        <p className="text-[color:var(--text-secondary)]">
          Expérimentations : {eur(b.phases.EXPERIMENT.settledEur)} consommés · {eur(b.phases.EXPERIMENT.reservedEur)} réservés · {eur(b.phases.EXPERIMENT.unreconciledEur)} à rapprocher · {eur(b.phases.EXPERIMENT.remainingEur)} disponibles (enveloppe {eur(b.envelope.experimentEur)})
        </p>
        <p className="text-[color:var(--text-secondary)]">
          Surveillance : {eur(b.phases.MONITOR.settledEur)} consommés · {eur(b.phases.MONITOR.reservedEur)} réservés · {eur(b.phases.MONITOR.unreconciledEur)} à rapprocher · {eur(b.phases.MONITOR.remainingEur)} disponibles (enveloppe {eur(b.envelope.monitorEur)})
        </p>
        <p className="text-[color:var(--text-muted)]">
          Alertes administrateur à {eur(b.alerts.infoEur)} et {eur(b.alerts.vigilanceEur)} · taux USD → EUR : {b.fx.usdToEur == null ? 'À DÉFINIR' : `${b.fx.usdToEur} (${b.fx.source}, ${b.fx.date}, marge ${Math.round((b.fx.marginRatio ?? 0) * 100)} %)`}
          {b.unreconciled ? ` · ${b.unreconciled} coût(s) inconnu(s)` : ''}{b.underestimated ? ` · ${b.underestimated} sous-estimation(s)` : ''}.
          Ce budget ne suspend JAMAIS le service IA des utilisateurs.
        </p>
        {b.blocked && <p className="text-[color:var(--text-warning)]">Aucun appel payant d’amélioration : {b.blocked}</p>}
      </div>

      <ul className="space-y-1 text-xs text-[color:var(--text-secondary)]" data-testid="improvement-treatments">
        {view.treatments.map((t) => (
          <li key={t.treatment} className="rounded-lg border border-[color:var(--border-subtle)] p-2 break-words">
            <span className="font-medium text-[color:var(--text-primary)]">{t.treatment}</span> · {t.qualificationLabel} · capacité : {CAPABILITY_LABELS[t.capability.state] ?? t.capability.state}
            {t.capability.cause ? <span className="block text-[color:var(--text-muted)]">{t.capability.cause}</span> : null}
            {t.watch && (
              <span className="block">
                Surveillance (candidate {t.watch.candidateVersionId}) : {t.watch.label}
                {t.watch.activatedAt ? ` · activée le ${formatDateTime(t.watch.activatedAt)}` : ''}{t.watch.sevenDayReviewAt ? ` · bilan J+7 le ${formatDateTime(t.watch.sevenDayReviewAt)}` : ''}
                {t.watch.lastObservedAt ? ` · dernier usage observé ${formatDateTime(t.watch.lastObservedAt)}` : ' · aucun usage observé'}
              </span>
            )}
            {t.headObjective && <span className="block text-[color:var(--text-muted)]">Objectif en tête de file : n° {t.headObjective.id} ({t.headObjective.kind}{t.headObjective.priority === 'RETIREMENT' ? ', retrait officiel : prioritaire' : ''}) — {OBJECTIVE_LABELS[t.headObjective.status] ?? t.headObjective.status}{t.headObjective.reason ? ` : ${t.headObjective.reason}` : ''}</span>}
          </li>
        ))}
      </ul>

      {view.queue.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)]">File des objectifs ({view.queue.length}, ordre FIFO, retrait officiel en tête)</summary>
          <ul className="mt-1 text-xs text-[color:var(--text-secondary)] space-y-0.5">
            {view.queue.map((o) => <li key={o.id} className="break-words">n° {o.id} · {o.treatment} · {o.kind} · {OBJECTIVE_LABELS[o.status] ?? o.status} · variantes {o.variantCount}{o.nextEligibleMonth ? ` · reprise ${o.nextEligibleMonth}` : ''} · créé le {formatDateTime(o.createdAt)}</li>)}
          </ul>
        </details>
      )}

      <details open={edit} onToggle={(e) => setEdit((e.target as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)]">Politique d’amélioration (révision {p.version}{p.updatedAt ? `, ${formatDateTime(p.updatedAt)}` : ', valeurs de départ'}) — modifiable par un administrateur</summary>
        <div className="mt-2 space-y-2">
          <div className="grid gap-2 sm:grid-cols-3">
            {field('Budget mensuel (€)', 'monthlyEur')}{field('Expérimentations (€)', 'experimentEur')}{field('Surveillance (€)', 'monitorEur')}
            {field('Alerte information (€)', 'infoAlertEur')}{field('Alerte vigilance (€)', 'vigilanceAlertEur')}{field('Variantes par objectif (1 à 3)', 'maxPerObjective')}
            {field('Taux USD → EUR', 'usdToEur', 'À DÉFINIR')}{field('Source du taux', 'fxSource')}{field('Date du taux (AAAA-MM-JJ)', 'fxDate')}
            {field('Marge de prudence du taux (0 à 1)', 'marginRatio', `suggestion ${p.suggestions.fxMarginRatio}`)}{field('Marge de sécurité de la borne de coût (×)', 'safetyMultiplier', `suggestion ${p.suggestions.safetyMultiplier}`)}{field('Jetons maximum par pièce jointe', 'attachmentMaxTokens', 'À DÉFINIR')}
            {field('Appels minimum « validée en usage »', 'minCallsValidated')}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {view.treatments.map((t) => (
              <div key={t.treatment} className="grid grid-cols-2 gap-2">
                <label className="block text-xs text-[color:var(--text-secondary)] space-y-0.5"><span>{t.treatment} · hausse de coût admissible (micro-$ / appel)</span>
                  <Input className="w-full min-h-[44px] sm:min-h-0" value={f.economics[t.treatment]?.extra ?? ''} onChange={(e) => setF({ ...f, economics: { ...f.economics, [t.treatment]: { ...f.economics[t.treatment], extra: e.target.value } } })} /></label>
                <label className="block text-xs text-[color:var(--text-secondary)] space-y-0.5"><span>{t.treatment} · plafond P95 (ms)</span>
                  <Input className="w-full min-h-[44px] sm:min-h-0" value={f.economics[t.treatment]?.p95 ?? ''} onChange={(e) => setF({ ...f, economics: { ...f.economics, [t.treatment]: { ...f.economics[t.treatment], p95: e.target.value } } })} /></label>
              </div>
            ))}
          </div>
          <label className="block text-xs text-[color:var(--text-secondary)] space-y-0.5">
            <span>Modèles stables attestés (une ligne : modèle | source officielle | version facultative) — jamais déduit du nom</span>
            <Textarea className="w-full min-h-[88px]" value={f.stable} onChange={(e) => setF({ ...f, stable: e.target.value })} />
          </label>
          {field('Motif de la modification (obligatoire)', 'reason')}
          <p className="text-xs text-[color:var(--text-muted)]">Les juges sémantiques et le seuil de gain de qualité ne sont pas encore livrés : ils ne sont pas réglables ici (aucune promotion « gain de qualité » tant qu’ils ne sont pas configurés).</p>
          <Button size="sm" className="min-h-[44px] sm:min-h-0" disabled={saving || f.reason.trim().length < 3} onClick={() => void save()}>Enregistrer la politique</Button>
        </div>
      </details>
    </section>
  );
}
