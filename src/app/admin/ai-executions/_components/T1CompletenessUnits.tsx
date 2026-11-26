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
  provenance: {
    rule: string; sources: string[]; refs: string[]; previous: { status: string; reason: string | null }; stage: string;
    occurrences?: OccurrenceCountsView | null; details?: OccurrenceDetailView[] | null;
  } | null;
  /** Carte #853 : contrôle courant par occurrence (absent : serveur antérieur ou contrôle indisponible). */
  occurrences?: { mode: string; counts: OccurrenceCountsView; details: OccurrenceDetailView[] } | null;
  valueKinds: Record<string, number>; textLength: number;
}
/** Carte #853 (R3) : compteurs d'occurrences (unités ≠ occurrences). */
export interface OccurrenceCountsView {
  total: number; structured: number; preserved: number; notRetained: number; undetermined: number;
  uncertain: number; unresolved: number; failed: number; excluded: number; units?: number;
}
/** Carte #853 (R4) : une occurrence — identité, position, issue, preuve exacte ou motif ; jamais la valeur. */
export interface OccurrenceDetailView {
  id: string; nature: string; at: number; outcome: string;
  proof: { source: string; ref: string } | null; reason: string | null; recallOf?: string;
}
/**
 * Carte #853 (AC15) — totaux par OCCURRENCE (texte pur, testé) : la somme des issues vaut le total ; une valeur
 * inconnue n'est jamais affichée comme zéro.
 */
export function occurrenceCountsText(c: OccurrenceCountsView | null | undefined): string {
  if (!c) return 'Occurrences : contrôle indisponible';
  const parts = [
    `${c.structured} structurée(s)`, `${c.preserved} conservée(s) autrement`, `${c.notRetained} non retenue(s)`,
    `${c.undetermined} indéterminée(s)`, `${c.uncertain} incertaine(s)`, `${c.unresolved} non résolue(s)`, `${c.failed} en échec`,
  ];
  return `${c.total} occurrence(s)${c.units !== undefined ? ` dans ${c.units} unité(s)` : ''} : ${parts.join(' · ')}${c.excluded > 0 ? ` · ${c.excluded} exclue(s) (non informatives)` : ''}`;
}
/** Carte #853 (AC15) — détail des occurrences d'une unité (texte pur, testé). */
export function occurrenceDetailsText(details: readonly OccurrenceDetailView[] | null | undefined): string {
  if (!details || details.length === 0) return '';
  return details.map((x) => `${x.nature}@${x.at} ${x.outcome}${x.proof ? ` ← ${x.proof.ref}` : ''}${x.reason ? ` (${x.reason})` : ''}${x.recallOf ? ` = rappel de ${x.recallOf}` : ''}`).join(' · ');
}
interface Detail {
  fileId: number; qualityState: string;
  totals: { total: number; covered: number; nonInformational: number; uncertain: number; unresolved: number; failed: number; requalified: number };
  /** Carte #853 (R3) : totaux par occurrence du contrôle courant (absent : serveur antérieur). */
  occurrenceTotals?: OccurrenceCountsView | null;
  coverageRepair: {
    passes: number; calls: number; selected: number; attempted: number; resolved: number; factsAdded: number;
    factsConfirmed: number; decisions: number; skipped: string | null;
    /** Lot 115F (#792, écart P2-10) : absents d'un diagnostic écrit avant ce lot — coût alors inconnu. */
    callsFailed?: number; costMicros?: number; costUnknownCalls?: number;
  } | null;
  reconciliation: { requalified: number; byRule: Record<string, number> } | null;
  residualPolicies: Record<string, number>;
  retryAttempts: number; lastRetryResult: string | null;
  units: UnitRow[];
  paging?: { offset: number; limit: number; listed: number; matched: number };
  repairSteps?: {
    coverageRepair: { calls: number; attempted: number; resolved: number; skipped: string | null } | null;
    deferredRepair: {
      calls?: number; attemptedUnits?: number; newFacts?: number;
      decisions?: { received: number; valid: number; invalid: number; persisted: number } & DecisionLedger;
      /** Carte #854 (R4) : reprise SANS IA de réceptions antérieures. */
      decisionsRecovery?: { received: number; valid: number; invalid: number; persisted: number } & DecisionLedger;
      linkage?: { local: number; relinked: number; duplicates: number };
      /** Lot 115F (#792, écart P2-10) : appels, échecs et coût de la famille « reprise différée (texte ciblé) ». */
      textRepair?: { calls: number; callsFailed: number; costMicros: number; costUnknownCalls: number };
      sourceReread?: { calls: number; callsFailed: number };
    } | null;
    sourceReread: { runs: number; failed: number; resolved: number } | null;
    retryAttempts: number; lastRetryResult: string | null;
  };
  schema?: { ready: boolean; missing: string[] };
}
/**
 * Carte #854 (R4) — bilan RÉCONCILIABLE des décisions d'une passe (absent d'un diagnostic écrit avant la carte :
 * rien n'est inventé). Inconnu ≠ 0.
 */
export interface DecisionLedger {
  state?: 'NONE' | 'CONFIRMED' | 'INCOMPLETE'; retryable?: boolean; recovery?: boolean;
  rejected?: number; notEvaluated?: number; alreadyPresent?: number; newlyWritten?: number;
  confirmed?: number; missing?: number; divergent?: number; unconfirmed?: number; unexpected?: number;
  skipped?: Record<string, number>;
  calls?: Array<{ callIndex: number; callRef: string | null; contractState: string; contractVersion: string | null; promptVersion: string | null; promptFingerprint: string | null; received: number | null; failed: boolean; persistenceSuspended?: boolean }>;
  journal?: string;
  balanced?: boolean;
}
const ETAT_DECISIONS: Record<string, string> = {
  NONE: 'aucune décision reçue', CONFIRMED: 'toutes relues conformes', INCOMPLETE: 'INCOMPLÈTE — reprise de la persistance nécessaire',
};
const CONTRAT_LABEL: Record<string, string> = {
  CARRIED: 'contrat porté', MARKER_MISSING: 'contrat absent du prompt', UNSUPPORTED_VERSION: 'version de contrat non supportée',
  EVIDENCE_MISSING: 'contrat non prouvé (preuve de l’appel absente)',
};

/** Carte #854 (R4) — décisions d'une passe en clair : réconciliation, écritures, relecture, contrat par appel (pure). */
export function decisionLedgerText(label: string, d: ({ received: number; valid: number; invalid: number; persisted: number } & DecisionLedger) | undefined): string {
  if (!d || d.state === undefined) return '';
  const n = (v: number | undefined) => (v === undefined ? 'inconnu' : String(v));
  const motifs = Object.entries(d.skipped ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([m, k]) => `${m} ×${k}`).join(', ');
  const appels = (d.calls ?? []).map((c) => `appel ${c.callIndex}${c.failed ? ' en échec (décisions inconnues)' : ''} : ${CONTRAT_LABEL[c.contractState] ?? c.contractState}`
    + `${c.contractVersion ? ` ${c.contractVersion}` : ''}${c.promptVersion ? `, prompt ${c.promptVersion}` : ''}${c.promptFingerprint ? ` (empreinte ${c.promptFingerprint})` : ''}`
    + `${c.received === null ? '' : `, ${c.received} reçue(s)`}${c.persistenceSuspended ? ', persistance suspendue (coupure d’urgence)' : ''}${c.callRef ? `, trace ${c.callRef}` : ''}`).join(' ; ');
  return ` ${label} : ${d.received} reçue(s) = ${d.valid} acceptée(s) + ${d.invalid} rejetée(s) à la validation + ${n(d.rejected)} rejetée(s) avant validation + ${n(d.notEvaluated)} non évaluée(s) (incident)`
    + `${d.balanced === false ? ' — ÉCART DE RÉCONCILIATION' : ''} ; écriture : ${n(d.newlyWritten)} nouvelle(s), ${n(d.alreadyPresent)} déjà présente(s)`
    + ` ; relecture exacte : ${n(d.confirmed)} conforme(s), ${n(d.missing)} manquante(s), ${n(d.divergent)} divergente(s), ${n(d.unconfirmed)} non vérifiable(s)`
    + `${d.unexpected ? `, ${d.unexpected} inattendue(s)` : ''} ; état : ${ETAT_DECISIONS[d.state] ?? d.state}${d.retryable ? ' (reprise sans IA programmée)' : ''}`
    + `${motifs ? ` ; motifs : ${motifs}` : ''}${appels ? ` ; ${appels}` : ''}.`;
}

const PAGE = 100;
const ETATS = ['UNRESOLVED', 'UNCERTAIN', 'FAILED', 'COVERED', 'NON_INFORMATIONAL'] as const;
/** Lot 115F (#792, écart P2-09) : origines d'une preuve de requalification (codes stables de la provenance). */
const PROVENANCES = ['FACT', 'TABLE', 'METADATA', 'CANDIDATE', 'VALUE_DECISION', 'UNIT', 'REPAIR'] as const;
export const PROVENANCE_LABEL: Record<string, string> = {
  FACT: 'fait',
  TABLE: 'ligne de tableau',
  METADATA: 'métadonnée',
  CANDIDATE: 'candidat d’opération métier',
  VALUE_DECISION: 'décision de valeur',
  UNIT: 'autre unité (répétition, chevauchement)',
  REPAIR: 'réparation ciblée',
};
interface Reconcile {
  outcome: string; requalified: Array<{ unitId: string; from: { status: string }; to: { status: string; reason: string | null }; rule: string | null }>;
  before: { qualityState: string | null }; after: { qualityState: string | null };
  /** Lot 114H (#775) : reprises avant / après le recalcul (échéance, attentes levées, motif d'absence de reprise). */
  retry?: { scheduledBefore: boolean; scheduledAfter: boolean; pendingReleased: number; actions: string[]; blocked: string | null; stateChanged: boolean };
}

/** Lot 114H (#775) : effet du recalcul sur les reprises, en une ligne (pure). */
export function retryChangeText(rec: Pick<Reconcile, 'before' | 'after' | 'retry'>): string {
  const r = rec.retry;
  if (!r) return '';
  const parts: string[] = [];
  if (rec.before.qualityState !== rec.after.qualityState) parts.push(`état ${rec.before.qualityState} → ${rec.after.qualityState}`);
  if (r.scheduledBefore && !r.scheduledAfter) parts.push('reprise programmée retirée (plus aucune reprise admissible)');
  if (!r.scheduledBefore && r.scheduledAfter) parts.push('reprise ciblée programmée');
  if (r.pendingReleased > 0) parts.push(`${r.pendingReleased} unité(s) en attente : attente levée`);
  if (r.blocked && REPAIR_SKIP_LABEL[r.blocked]) parts.push(REPAIR_SKIP_LABEL[r.blocked]);
  return parts.length ? `Reprises : ${parts.join(' · ')}` : '';
}

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
  // Lot 114H (#775, P1-A) : unité jamais tentée parce que plus aucune reprise n'est admissible (≠ réparation épuisée).
  RETRIES_DISABLED: 'reprises désactivées (T1_COMPLETENESS_MAX_RETRIES=0)',
  RETRY_CAP_REACHED: 'plafond de reprises du document atteint',
  CONTINUATION_CAP_REACHED: 'plafond de passages de continuation atteint',
  UNIT_CAP_REACHED: 'plafond de tentatives de l’unité atteint',
};

/**
 * Lot 115F (#792, écart P2-08) — motif pour lequel la réparation ciblée ne soumettra JAMAIS l'unité,
 * avec la prochaine action réellement possible (jamais une alerte sans action).
 */
export const REPAIR_NOT_ELIGIBLE_LABEL: Record<string, string> = {
  NO_TEXT: 'aucun texte à relire — conservée en l’état',
  KIND_NOT_REPAIRABLE: 'nature non relisible par le texte — relecture du fichier ou arbitrage T3/T2',
  NOT_SALIENT: 'texte sans valeur saillante à réextraire — conservée, réinterprétable T3/T2',
  FINAL_FAILURE: 'échec définitif de réparation — reprise manuelle seulement',
  VALUE_DECISION_REVIEW: 'valeurs à expliquer — réexamen des décisions de valeur (sans réextraction)',
  NOTHING_TO_REPAIR: 'aucune lacune que la réparation ciblée puisse combler',
};

/** Libellé d'une politique (pure). */
export function policyLabel(code: string | null): string {
  if (!code) return '';
  if (code.startsWith('REPAIR_NOT_RUN:')) return `réparation non exécutée (${REPAIR_SKIP_LABEL[code.slice(15)] ?? code.slice(15)})`;
  if (code.startsWith('REPAIR_NOT_ELIGIBLE:')) {
    const m = code.slice(20);
    return `non réparable par la passe ciblée : ${REPAIR_NOT_ELIGIBLE_LABEL[m] ?? m}`;
  }
  return RESIDUAL_POLICY_LABEL[code] ?? code;
}

/**
 * Lot 115F (Trello #792, écart P2-10) — APPELS, ÉCHECS ET COÛT d'une famille, en clair (pure).
 *
 * Un coût que la passerelle n'a pas rendu n'est JAMAIS affiché comme nul : le
 * nombre d'appels concernés est dit, et le total porte « au moins ». Aucun
 * appel : « aucun appel » (coût nul établi, non inconnu).
 */
export function callCostText(c: { calls: number; callsFailed?: number; costMicros?: number; costUnknownCalls?: number }): string {
  if (c.calls === 0) return 'aucun appel, aucun coût';
  const echecs = c.callsFailed ?? 0;
  const inconnus = c.costUnknownCalls ?? null;
  const parts = [`${c.calls} appel(s)`];
  if (echecs > 0) parts.push(`${echecs} en échec`);
  if (inconnus === null) parts.push('coût non consigné');
  else if (inconnus >= c.calls) parts.push(`coût inconnu (${inconnus} appel(s))`);
  else {
    const euros = ((c.costMicros ?? 0) / 1_000_000).toFixed(4);
    parts.push(inconnus > 0 ? `coût au moins ${euros} (${inconnus} appel(s) au coût inconnu)` : `coût ${euros}`);
  }
  return parts.join(', ');
}

/** Ligne de synthèse de la réparation ciblée de couverture (pure, compteurs seulement). */
export function coverageRepairText(r: Detail['coverageRepair']): string {
  if (!r) return 'Réparation ciblée de couverture : non consignée (analyse antérieure au lot 113AN).';
  if (r.skipped && r.calls === 0) return `Réparation ciblée de couverture : non exécutée — ${REPAIR_SKIP_LABEL[r.skipped] ?? r.skipped} (${r.selected} unité(s) sélectionnée(s)).`;
  return `Réparation ciblée de couverture : ${r.passes} passe(s), ${callCostText(r)}, ${r.selected} unité(s) sélectionnée(s), ${r.attempted} soumise(s), `
    + `${r.resolved} couverte(s) à l’issue · ${r.factsAdded} fait(s) ajouté(s), ${r.factsConfirmed} relecture(s) d’un fait existant, ${r.decisions} décision(s) de valeur.`;
}

/**
 * Lot 114G (#760, P2-10) — reprise différée et relectures, comptées à part de la réparation ciblée de l'analyse
 * et des réparations JSON de la passerelle (pure, compteurs seulement).
 */
export function deferredRepairText(r: Detail['repairSteps']): string {
  if (!r) return '';
  const d = r.deferredRepair;
  // Lot 115F (#792, écart P2-10) : la reprise différée est ventilée par famille d'appels — texte ciblé
  // (avec son coût) et relecture du fichier — au lieu d'un total unique.
  const texteCible = d?.textRepair ? ` Texte ciblé : ${callCostText(d.textRepair)}.` : '';
  const reprise = d
    ? `Dernière reprise différée : ${d.calls ?? 0} appel(s) au total, ${d.attemptedUnits ?? 0} unité(s) soumise(s), ${d.newFacts ?? 0} fait(s) ajouté(s)`
      + (d.decisions ? `, décisions de valeur : ${d.decisions.received} reçue(s), ${d.decisions.valid} valide(s), ${d.decisions.invalid} invalide(s), ${d.decisions.persisted} écrite(s)` : '')
      + (d.linkage ? `, rattachements : ${d.linkage.local} local(aux), ${d.linkage.relinked} recalculé(s), ${d.linkage.duplicates} fait(s) déjà présent(s)` : '') + '.'
    : `Reprise différée : ${r.retryAttempts} tentative(s) consommée(s)${r.lastRetryResult ? `, dernier résultat ${r.lastRetryResult}` : ', aucune reprise exécutée'}.`;
  const relecture = r.sourceReread && r.sourceReread.runs > 0
    ? ` Relectures du fichier : ${r.sourceReread.runs} (${r.sourceReread.resolved} unité(s) levée(s), ${r.sourceReread.failed} en échec).` : ' Relectures du fichier : aucune.';
  // Carte #854 (R4) : bilan réconciliable des décisions et de leur reprise sans IA (diagnostics postérieurs à la carte).
  const decisions = decisionLedgerText('Décisions de valeur (journal)', d?.decisions) + decisionLedgerText('Reprise sans IA des décisions', d?.decisionsRecovery);
  return reprise + texteCible + relecture + decisions;
}

/** Lot 114G (#760, P2-09) — « 101–200 sur 1 240 (1 240 dans la liste) » (pure). */
export function pagingText(p: Detail['paging'], shown: number): string {
  if (!p) return `${shown} unité(s) affichée(s)`;
  if (p.matched === 0) return `aucune unité ne correspond (${p.listed} dans la liste)`;
  return `${p.offset + 1}–${p.offset + shown} sur ${p.matched}${p.matched !== p.listed ? ` (${p.listed} dans la liste)` : ''}`;
}

export function T1CompletenessUnits({ fileId }: { fileId: number }) {
  // Lot 114G (#760, P2-09) : filtres et pagination côté serveur — plus de liste coupée à 300 sans le dire.
  // Lot 115F (#792, écart P2-09) : la provenance d'une requalification est aussi un filtre.
  const [filtre, setFiltre] = useState({ all: false, status: '', unit: '', page: '', provenance: '', offset: 0 });
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
    if (filtre.provenance) q.set('provenance', filtre.provenance);
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
      {d.occurrenceTotals !== undefined && (
        <p className="text-xs text-[color:var(--text-secondary)] break-words" data-testid="t1-occurrence-totals">{occurrenceCountsText(d.occurrenceTotals)}</p>
      )}
      <p className="text-xs text-[color:var(--text-muted)] break-words">{coverageRepairText(d.coverageRepair)}</p>
      {d.repairSteps && <p className="text-xs text-[color:var(--text-muted)] break-words">{deferredRepairText(d.repairSteps)}</p>}
      {d.schema && !d.schema.ready && (
        <p className="text-xs text-[color:var(--text-primary)] break-words" role="alert">
          Migrations de la couverture T1 incomplètes (colonnes absentes : {d.schema.missing.join(', ')}) : la couche de couverture n’est plus écrite sans sa provenance ni sa politique. Appliquer les migrations 0329 et 1665, puis relancer la reprise.
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
      {rec && retryChangeText(rec) && <p className="text-xs text-[color:var(--text-muted)] break-words" data-testid="t1-retry-change">{retryChangeText(rec)}</p>}
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
        <label className="flex items-center gap-1">
          Provenance
          <select value={filtre.provenance} onChange={(e) => setFiltre({ ...filtre, provenance: e.target.value, offset: 0 })} className="rounded border border-[color:var(--border-subtle)] bg-transparent px-1 py-0.5">
            <option value="">toutes</option>
            {PROVENANCES.map((x) => <option key={x} value={x}>{PROVENANCE_LABEL[x]}</option>)}
          </select>
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
              <th className="pr-2">Réparation</th><th className="pr-2">Politique / provenance</th><th className="pr-2">Valeurs</th><th>Occurrences</th>
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
                <td className="pr-2">{Object.entries(u.valueKinds).map(([k, n]) => `${k}×${n}`).join(' ') || '–'}</td>
                <td className="break-words">
                  {u.occurrences ? (
                    <>
                      <span className="block">{occurrenceCountsText(u.occurrences.counts)}</span>
                      <span className="block text-[color:var(--text-muted)] font-mono">{occurrenceDetailsText(u.occurrences.details)}</span>
                    </>
                  ) : '–'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
