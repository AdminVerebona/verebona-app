'use client';
/**
 * Lot 113AN (Trello #741) — rapport de complétude T1 d'UN document, unité par
 * unité (BO › Exécutions IA › Complétude T1 › « Unités »).
 *
 * Totaux (couvertes, non informatives, incertaines, non résolues, échouées,
 * requalifiées), réparation ciblée de couverture (appels « extrait ciblé »,
 * distincts des réparations JSON de la passerelle), politique de chaque
 * unité restante, provenance des requalifications. Actions : réconcilier
 * sans IA (simulation puis application), reprise ciblée bornée. AUCUN
 * contenu de document : identifiants, états, motifs, références.
 */
import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '@/lib/api-client';

interface UnitRow {
  unitId: string; kind: string; page: number | null; status: string; reason: string | null; factCount: number;
  repairState: string | null; repairAttempts: number; residualPolicy: string | null;
  provenance: { rule: string; sources: string[]; refs: string[]; previous: { status: string; reason: string | null }; stage: string } | null;
  valueKinds: Record<string, number>; textLength: number;
}
interface Detail {
  fileId: number; qualityState: string;
  totals: { total: number; covered: number; nonInformational: number; uncertain: number; unresolved: number; failed: number; requalified: number };
  coverageRepair: { passes: number; calls: number; selected: number; attempted: number; resolved: number; factsAdded: number; factsConfirmed: number; decisions: number; skipped: string | null } | null;
  reconciliation: { requalified: number; byRule: Record<string, number> } | null;
  residualPolicies: Record<string, number>;
  retryAttempts: number; lastRetryResult: string | null;
  units: UnitRow[];
  paging?: { offset: number; limit: number; listed: number; matched: number };
  repairSteps?: {
    coverageRepair: { calls: number; attempted: number; resolved: number; skipped: string | null } | null;
    deferredRepair: { calls?: number; attemptedUnits?: number; newFacts?: number; decisions?: { received: number; valid: number; invalid: number; persisted: number }; linkage?: { local: number; relinked: number; duplicates: number } } | null;
    sourceReread: { runs: number; failed: number; resolved: number } | null;
    retryAttempts: number; lastRetryResult: string | null;
  };
  schema?: { ready: boolean; missing: string[] };
}
const PAGE = 100;
const ETATS = ['UNRESOLVED', 'UNCERTAIN', 'FAILED', 'COVERED', 'NON_INFORMATIONAL'] as const;
interface Reconcile { outcome: string; requalified: Array<{ unitId: string; from: { status: string }; to: { status: string; reason: string | null }; rule: string | null }>; before: { qualityState: string | null }; after: { qualityState: string | null } }

/** Politique d'une unité restante — libellés BO (codes stables de `residualPolicyOf`). */
export const RESIDUAL_POLICY_LABEL: Record<string, string> = {
  REPAIR_PENDING: 'réparation programmée',
  REPAIR_RETRY_SCHEDULED: 'échec transitoire — reprise programmée',
  REPAIR_ATTEMPTED_NO_RESULT: 'réparation ciblée tentée sans résultat — conservée, réinterprétable T3/T2',
  REPAIR_NOT_ATTEMPTED: 'aucune réparation tentée — reprise ciblée possible',
  REPAIR_EXHAUSTED: 'réparation épuisée (plafond atteint)',
  NEEDS_SOURCE: 'relecture du fichier nécessaire',
  T3_REINTERPRETATION: 'interprétation incertaine — arbitrage T3/T2',
  PRESERVED_UNSTRUCTURED: 'texte sans valeur structurable — conservé',
  TECHNICAL_FAILURE_FINAL: 'échec technique définitif',
};
/** Motif d'absence de réparation à l'analyse. */
export const REPAIR_SKIP_LABEL: Record<string, string> = {
  DISABLED: 'réparation désactivée (T1_MAX_REPAIR_PASSES=0)',
  BELOW_MIN_UNITS: 'sous le seuil T1_REPAIR_MIN_UNITS',
  NO_TARGET: 'aucune unité à réparer',
};

/** Libellé d'une politique (pure). */
export function policyLabel(code: string | null): string {
  if (!code) return '';
  if (code.startsWith('REPAIR_NOT_RUN:')) return `réparation non exécutée (${REPAIR_SKIP_LABEL[code.slice(15)] ?? code.slice(15)})`;
  return RESIDUAL_POLICY_LABEL[code] ?? code;
}

/** Ligne de synthèse de la réparation ciblée de couverture (pure, compteurs seulement). */
export function coverageRepairText(r: Detail['coverageRepair']): string {
  if (!r) return 'Réparation ciblée de couverture : non consignée (analyse antérieure au lot 113AN).';
  if (r.skipped && r.calls === 0) return `Réparation ciblée de couverture : non exécutée — ${REPAIR_SKIP_LABEL[r.skipped] ?? r.skipped} (${r.selected} unité(s) sélectionnée(s)).`;
  return `Réparation ciblée de couverture : ${r.passes} passe(s), ${r.calls} appel(s), ${r.selected} unité(s) sélectionnée(s), ${r.attempted} soumise(s), `
    + `${r.resolved} couverte(s) à l’issue · ${r.factsAdded} fait(s) ajouté(s), ${r.factsConfirmed} relecture(s) d’un fait existant, ${r.decisions} décision(s) de valeur.`;
}

/**
 * Lot 114G (#760, P2-10) — reprise différée et relectures, comptées à part de la réparation ciblée de l'analyse
 * et des réparations JSON de la passerelle (pure, compteurs seulement).
 */
export function deferredRepairText(r: Detail['repairSteps']): string {
  if (!r) return '';
  const d = r.deferredRepair;
  const reprise = d
    ? `Dernière reprise différée : ${d.calls ?? 0} appel(s), ${d.attemptedUnits ?? 0} unité(s) soumise(s), ${d.newFacts ?? 0} fait(s) ajouté(s)`
      + (d.decisions ? `, décisions de valeur : ${d.decisions.received} reçue(s), ${d.decisions.valid} valide(s), ${d.decisions.invalid} invalide(s), ${d.decisions.persisted} écrite(s)` : '')
      + (d.linkage ? `, rattachements : ${d.linkage.local} local(aux), ${d.linkage.relinked} recalculé(s), ${d.linkage.duplicates} fait(s) déjà présent(s)` : '') + '.'
    : `Reprise différée : ${r.retryAttempts} tentative(s) consommée(s)${r.lastRetryResult ? `, dernier résultat ${r.lastRetryResult}` : ', aucune reprise exécutée'}.`;
  const relecture = r.sourceReread && r.sourceReread.runs > 0
    ? ` Relectures du fichier : ${r.sourceReread.runs} (${r.sourceReread.resolved} unité(s) levée(s), ${r.sourceReread.failed} en échec).` : ' Relectures du fichier : aucune.';
  return reprise + relecture;
}

/** Lot 114G (#760, P2-09) — « 101–200 sur 1 240 (1 240 dans la liste) » (pure). */
export function pagingText(p: Detail['paging'], shown: number): string {
  if (!p) return `${shown} unité(s) affichée(s)`;
  if (p.matched === 0) return `aucune unité ne correspond (${p.listed} dans la liste)`;
  return `${p.offset + 1}–${p.offset + shown} sur ${p.matched}${p.matched !== p.listed ? ` (${p.listed} dans la liste)` : ''}`;
}

export function T1CompletenessUnits({ fileId }: { fileId: number }) {
  // Lot 114G (#760, P2-09) : filtres et pagination côté serveur — plus de liste coupée à 300 sans le dire.
  const [filtre, setFiltre] = useState({ all: false, status: '', unit: '', page: '', offset: 0 });
  const [d, setD] = useState<Detail | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [rec, setRec] = useState<Reconcile | null>(null);
  const [action, setAction] = useState<string | null>(null);

  const charger = useCallback(() => {
    const q = new URLSearchParams({ limit: String(PAGE), offset: String(filtre.offset) });
    if (filtre.all) q.set('all', '1');
    if (filtre.status) q.set('status', filtre.status);
    if (filtre.unit.trim()) q.set('unit', filtre.unit.trim());
    if (/^\d+$/.test(filtre.page.trim())) q.set('page', filtre.page.trim());
    apiClient.get<Detail>(`/api/admin/ai/t1-completeness/${fileId}?${q.toString()}`)
      .then((r) => { setD(r); setErreur(null); })
      .catch(() => setErreur('Détail indisponible.'));
  }, [fileId, filtre]);
  useEffect(() => { charger(); }, [charger]);

  const reconcilier = (apply: boolean) => {
    setAction(apply ? 'application…' : 'simulation…');
    apiClient.post<Reconcile>(`/api/admin/ai/t1-completeness/${fileId}/reconcile`, { apply })
      .then((r) => { setRec(r); setAction(apply ? `appliquée (${r.requalified.length})` : `simulée (${r.requalified.length})`); if (apply) charger(); })
      .catch(() => setAction('échec'));
  };
  const reparer = () => {
    setAction('reprise ciblée…');
    apiClient.post<{ outcome: string; calls: number; attempted: number; newFacts: number; result: string }>(`/api/admin/ai/t1-completeness/${fileId}/repair`, {})
      .then((r) => { setAction(`reprise : ${r.result} (${r.calls} appel(s), ${r.attempted} unité(s), ${r.newFacts} fait(s))`); charger(); })
      .catch(() => setAction('échec de la reprise'));
  };

  if (erreur) return <p className="text-xs text-[color:var(--text-muted)]">{erreur}</p>;
  if (!d) return <p className="text-xs text-[color:var(--text-muted)]">Chargement…</p>;
  const t = d.totals;
  return (
    <div className="mt-1 rounded border border-[color:var(--border-subtle)] p-2 space-y-1" data-testid="t1-completeness-units">
      <p className="text-xs text-[color:var(--text-secondary)]">
        {t.total} unité(s) · {t.covered} couverte(s) · {t.nonInformational} non informative(s) · {t.uncertain} incertaine(s) ·{' '}
        {t.unresolved} non résolue(s) · {t.failed} en échec · {t.requalified} requalifiée(s) sur preuve
      </p>
      <p className="text-xs text-[color:var(--text-muted)] break-words">{coverageRepairText(d.coverageRepair)}</p>
      {d.repairSteps && <p className="text-xs text-[color:var(--text-muted)] break-words">{deferredRepairText(d.repairSteps)}</p>}
      {d.schema && !d.schema.ready && (
        <p className="text-xs text-[color:var(--text-primary)] break-words" role="alert">
          Migration 1665 non appliquée (colonnes absentes : {d.schema.missing.join(', ')}) : la couche de couverture n’est plus écrite sans sa provenance. Appliquer la migration, puis relancer la reprise.
        </p>
      )}
      {Object.keys(d.residualPolicies).length > 0 && (
        <p className="text-xs text-[color:var(--text-muted)] break-words">
          Unités restantes : {Object.entries(d.residualPolicies).map(([k, n]) => `${n} ${policyLabel(k)}`).join(' · ')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => reconcilier(false)} className="text-xs rounded border border-[color:var(--border-subtle)] px-2 py-0.5 text-[color:var(--text-secondary)]">
          Réconcilier (sans IA) — simuler
        </button>
        {rec && rec.outcome === 'SIMULATED' && (
          <button type="button" onClick={() => reconcilier(true)} className="text-xs rounded border border-[color:var(--border-warning)] px-2 py-0.5 text-[color:var(--text-primary)]">
            Appliquer la réconciliation
          </button>
        )}
        <button type="button" onClick={reparer} className="text-xs rounded border border-[color:var(--border-subtle)] px-2 py-0.5 text-[color:var(--text-secondary)]">
          Reprise ciblée des unités non couvertes
        </button>
        {action && <span className="text-xs text-[color:var(--text-muted)]">{action}</span>}
      </div>
      {rec && rec.requalified.length > 0 && (
        <p className="text-xs text-[color:var(--text-muted)] break-words">
          {rec.before.qualityState} → {rec.after.qualityState} : {rec.requalified.slice(0, 30).map((q) => `${q.unitId} ${q.from.status}→${q.to.status} (${q.rule ?? q.to.reason})`).join(' · ')}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs text-[color:var(--text-secondary)]">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={filtre.all} onChange={(e) => setFiltre({ ...filtre, all: e.target.checked, offset: 0 })} />
          toutes les unités
        </label>
        <label className="flex items-center gap-1">
          État
          <select value={filtre.status} onChange={(e) => setFiltre({ ...filtre, status: e.target.value, offset: 0 })} className="rounded border border-[color:var(--border-subtle)] bg-transparent px-1 py-0.5">
            <option value="">tous</option>
            {ETATS.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          Unité
          <input value={filtre.unit} onChange={(e) => setFiltre({ ...filtre, unit: e.target.value, offset: 0 })} placeholder="page:1:field:2" className="w-36 rounded border border-[color:var(--border-subtle)] bg-transparent px-1 py-0.5 font-mono" />
        </label>
        <label className="flex items-center gap-1">
          Page
          <input value={filtre.page} onChange={(e) => setFiltre({ ...filtre, page: e.target.value, offset: 0 })} inputMode="numeric" className="w-12 rounded border border-[color:var(--border-subtle)] bg-transparent px-1 py-0.5" />
        </label>
        <span className="text-[color:var(--text-muted)]" data-testid="t1-completeness-paging">{pagingText(d.paging, d.units.length)}</span>
        <button type="button" disabled={filtre.offset === 0} onClick={() => setFiltre({ ...filtre, offset: Math.max(0, filtre.offset - PAGE) })} className="rounded border border-[color:var(--border-subtle)] px-2 py-0.5 disabled:opacity-40">
          Précédentes
        </button>
        <button type="button" disabled={!d.paging || d.paging.offset + d.units.length >= d.paging.matched} onClick={() => setFiltre({ ...filtre, offset: filtre.offset + PAGE })} className="rounded border border-[color:var(--border-subtle)] px-2 py-0.5 disabled:opacity-40">
          Suivantes
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[color:var(--text-muted)]">
              <th className="pr-2">Unité</th><th className="pr-2">Nature</th><th className="pr-2">État</th><th className="pr-2">Motif</th>
              <th className="pr-2">Réparation</th><th className="pr-2">Politique / provenance</th><th>Valeurs</th>
            </tr>
          </thead>
          <tbody>
            {d.units.map((u) => (
              <tr key={u.unitId} className="align-top text-[color:var(--text-secondary)]">
                <td className="pr-2 font-mono break-all">{u.unitId}</td>
                <td className="pr-2">{u.kind}</td>
                <td className="pr-2">{u.status}</td>
                <td className="pr-2">{u.reason ?? '–'}</td>
                <td className="pr-2">{u.repairState ? `${u.repairState} (${u.repairAttempts})` : u.repairAttempts > 0 ? String(u.repairAttempts) : '–'}</td>
                <td className="pr-2 break-words">
                  {u.residualPolicy ? policyLabel(u.residualPolicy) : ''}
                  {u.provenance && (
                    <span className="block text-[color:var(--text-muted)]">
                      {u.provenance.previous.status}/{u.provenance.previous.reason ?? '–'} → {u.provenance.rule} ({u.provenance.sources.join(', ')}) {u.provenance.refs.slice(0, 4).join(' ')}
                    </span>
                  )}
                </td>
                <td>{Object.entries(u.valueKinds).map(([k, n]) => `${k}×${n}`).join(' ') || '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
