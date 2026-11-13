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
}
interface Reconcile { outcome: string; requalified: Array<{ unitId: string; from: { status: string }; to: { status: string; reason: string | null }; rule: string | null }>; before: { qualityState: string | null }; after: { qualityState: string | null } }

/** Politique d'une unité restante — libellés BO (codes stables de `residualPolicyOf`). */
export const RESIDUAL_POLICY_LABEL: Record<string, string> = {
  REPAIR_PENDING: 'réparation programmée',
  REPAIR_RETRY_SCHEDULED: 'échec transitoire — reprise programmée',
  REPAIR_ATTEMPTED_NO_RESULT: 'réparation ciblée tentée sans résultat — conservée, réinterprétable T3/T2',
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

export function T1CompletenessUnits({ fileId }: { fileId: number }) {
  const [d, setD] = useState<Detail | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [rec, setRec] = useState<Reconcile | null>(null);
  const [action, setAction] = useState<string | null>(null);

  const charger = useCallback(() => {
    apiClient.get<Detail>(`/api/admin/ai/t1-completeness/${fileId}`)
      .then((r) => { setD(r); setErreur(null); })
      .catch(() => setErreur('Détail indisponible.'));
  }, [fileId]);
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
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[color:var(--text-muted)]">
              <th className="pr-2">Unité</th><th className="pr-2">Nature</th><th className="pr-2">État</th><th className="pr-2">Motif</th>
              <th className="pr-2">Réparation</th><th className="pr-2">Politique / provenance</th><th>Valeurs</th>
            </tr>
          </thead>
          <tbody>
            {d.units.slice(0, 300).map((u) => (
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
