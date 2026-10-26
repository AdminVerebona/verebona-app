/**
 * COH-DOC-EXTRACT-CHAIN — chaîne « document → extract → T1 → aval »
 * (lot 83B ; arbitrages C-Q7, C-Q1, C-Q2 ; CDC cohérence §3.2, §4.1 ;
 * complément PO du 23/10 : « identifier le premier maillon incohérent,
 * rejouer uniquement le traitement nécessaire »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * INTERROGER L'EXTRACT, PUIS CIBLER LE MAILLON DÉFAILLANT
 *
 * Pour chaque document analysé dont l'extract existe (couche A :
 * `document_source_units`, couverture `document_extraction_coverage`), le
 * contrôle LIT l'extract et repère de façon DÉTERMINISTE les valeurs
 * significatives (montants avec devise, dates, identifiants d'un couple
 * libellé / valeur — `significantValues`, sans aucun jugement de
 * pertinence), puis les confronte à ce que T1 a produit : faits actifs,
 * métadonnées de l'extraction, candidats d'Opération ; les valeurs vues par
 * T1 mais non structurées (`document_unresolved_facts`) ne sont pas des
 * omissions. Diagnostics, dans l'ordre de la chaîne :
 *
 *   (c) EXTRACT  extract incomplet ou suspect DE FAÇON FIABLE (lacune de
 *                pages en échec réessayable, pages manquantes à la
 *                vérification de la source) → NOUVELLE EXTRACTION SOURCE par
 *                le service existant (`requeueDocumentForReread` : file T1,
 *                traitement technique non facturé). Relance ASYNCHRONE :
 *                réparation « en attente », jamais relancée tant que le
 *                diagnostic est le même ; le contrôle suivant en constate le
 *                résultat. Reprise déjà programmée, plafond de reprises
 *                atteint, lacune non réessayable : CONSTAT.
 *   (b) T1       valeur présente dans l'extract, absente de T1 :
 *                  · unité NON couverte et encore réparable → PASSE DE
 *                    RÉPARATION T1 CIBLÉE EXISTANTE (`source-units/repair.ts`
 *                    via `repairDocumentSourceUnits` : mêmes unités, mêmes
 *                    plafonds, consomme une reprise du document) ;
 *                  · unité couverte → CONSTAT tracé : sans le contrat
 *                    `t1-value-decisions-v1` (prompt T1 actif sans le
 *                    marqueur), T1 ne dit pas si l'écart est volontaire
 *                    (sous-total, mention, exemple) ou accidentel
 *                    (`pendingContract: 82B-t1-omissions-extract`) — aucune
 *                    règle de pertinence codée, aucune relance ;
 *                  · unité épuisée (plafond de tentatives) → CONSTAT.
 *                Lot 91D — DÉCISIONS T1 (contrat porté seulement) : chaque
 *                valeur absente est confrontée à la décision ACTIVE de T1
 *                sur CETTE valeur de CETTE unité (`document_value_decisions`,
 *                empreinte de l'unité inchangée) :
 *                  · décision VALIDE motivée (STRUCTURED / COMPONENT_OR_CONTEXT
 *                    avec un fait ou un candidat encore actif, NOT_RETAINED)
 *                    → plus une omission (justifiée, tracée au détail) ;
 *                  · UNDETERMINED ou confiance « conflictual » → CONSTAT
 *                    `FACT_DECISION_UNDETERMINED` (jamais une conformité) ;
 *                  · décision absente, invalide, obsolète ou rattachement
 *                    disparu → toujours une omission ; unité couverte ou
 *                    reprise épuisée → RÉEXAMEN CIBLÉ T1 (une fois par
 *                    diagnostic : `reviewDocumentValueDecisions`, unités en
 *                    constat seulement, budget commun), puis constat qualifié.
 *                Le code ne justifie jamais une valeur lui-même.
 *   (a) aval     faits T1 présents mais jamais projetés sur le bien du
 *                document (aucune preuve écrite alors que la projection en
 *                attend) → réparation AVAL seule, sans T1
 *                (`projectDocumentKnowledgeToAsset` : preuves, T3, liens) ;
 *                l'exploitation des montants, dates et identifiants
 *                retrouvés dans T1 relève des contrôles aval du registre
 *                (TCO, « À traiter », liens), signalés dans le détail —
 *                aucun second moteur.
 *
 * Garde-fous : un seul maillon rejoué par passage (le premier réparable) ;
 * budget de relances IA sur 24 h (`COHERENCE_T1_RELAUNCH_DAILY_MAX`) ;
 * empreinte des ENTRÉES (anti-boucle du moteur) et, pour les relances IA,
 * journal des réparations : une relance par diagnostic, jamais deux ;
 * aucune valeur inventée ; mode à blanc sans aucune écriture ni appel IA ;
 * coût IA mesuré par le moteur. Propagation : après une réparation, les
 * contrôles aval du document sont redemandés (`requestTargetedChecks`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { ChainLink, CheckContext, CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows, type Row } from '../util';
import { OPEN_DOCUMENT_SQL } from './document-links';
import {
  amountToCents, compactIdentifier, significantValues, type SignificantKind, type SignificantValue,
} from '@/services/ai/source-analysis/source-units/text';
import { unitFingerprint, valueKey } from '@/services/ai/source-analysis/value-decisions/validate';
import type { CatchupCandidate } from '../types';

const EXTRACT_CHAIN_CHECK_ID = 'COH-DOC-EXTRACT-CHAIN';
/** Demande de contrat IA dont dépend la disposition des omissions sur unité couverte (sans le contrat t1-value-decisions-v1). */
export const T1_OMISSIONS_CONTRACT = '82B-t1-omissions-extract';
/** Lot 91D : service de réexamen ciblé des décisions T1 (compté dans le budget des relances IA). */
const REVIEW_SERVICE = 'reviewDocumentValueDecisions';
/** Bornes du détail consigné (aucun contenu de document : unités, natures, valeurs normalisées ou empreintes). */
const DETAIL_MAX = 20;
/** Services de relance IA (passe T1 ciblée, nouvelle extraction) — comptés dans le budget. */
const RELANCES_IA = ['repairDocumentSourceUnits', 'requeueDocumentForReread', REVIEW_SERVICE];
const DEFAULT_T1_RELAUNCH_DAILY_MAX = 200;

/**
 * Relances IA T1 restantes sur 24 h glissantes, pour TOUT le contrôle de
 * cohérence (L83-Q3 : un plafond unique). Lot 86E : compté sur tous les
 * contrôles qui relancent T1 par les services existants (ce contrôle et
 * COH-DOC-CLASSIFICATION), plus seulement sur celui-ci.
 */
export async function t1RelaunchBudgetLeft(ctx: Pick<CheckContext, 'sql' | 'now'>): Promise<number> {
  const [{ n: relancees }] = await rows(ctx.sql, `
    SELECT count(*)::int AS n FROM coherence_repairs WHERE service = ANY($1::text[]) AND created_at >= $2`,
  [RELANCES_IA, new Date(ctx.now.getTime() - 86_400_000)]);
  return t1RelaunchDailyMax() - Number(relancees);
}

/**
 * Budget de relances IA du contrôle sur 24 h glissantes, tous comptes
 * (`COHERENCE_T1_RELAUNCH_DAILY_MAX`, 200 par défaut, 0 = aucune relance) —
 * C-Q1 : coût mesuré, jamais de relance massive au premier passage correctif ;
 * au-delà, le diagnostic reste un constat (même empreinte) et sera relancé
 * quand le budget le permettra. Le plafond de coût IA du compte s'applique
 * en plus (passerelle).
 */
export function t1RelaunchDailyMax(env: Record<string, string | undefined> = process.env): number {
  const v = env.COHERENCE_T1_RELAUNCH_DAILY_MAX;
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : DEFAULT_T1_RELAUNCH_DAILY_MAX;
}

// ── Diagnostic PUR ───────────────────────────────────────────────────────────

export interface ExtractUnit {
  unitId: string;
  kind: string;
  ordinal: number;
  text: string | null;
  status: string;
  reason: string | null;
  salient: boolean;
  repairAttempts: number;
  repairState: string | null;
  retryable: boolean | null;
  /** Dernière écriture de l'unité (une nouvelle extraction la réécrit). */
  updatedAt: string | null;
}

/** Ce que T1 a produit pour le document (formes normalisées). */
interface T1Knowledge {
  amounts: Set<number>;
  dates: Set<string>;
  identifiers: Set<string>;
}

export interface ExtractChainInput {
  fileId: number;
  extractionId: number | null;
  coverage: { retryAttempts: number; nextRetryAt: string | null; pagesMissing: number[] };
  units: ExtractUnit[];
  t1: T1Knowledge;
  /** Valeurs rendues par T1 mais non intégrées telles quelles (`document_unresolved_facts`). */
  t1Unstructured: T1Knowledge;
  /** Projection attendue sur le bien du document (null : aucun bien vivant). */
  projection: { assetId: number; expectedKeys: string[]; evidenceCount: number } | null;
  /** Unités encore réparables par la passe ciblée (`selectRepairUnits`, plafond de tentatives). */
  repairableUnitIds: ReadonlySet<string>;
  maxRetries: number;
  /** Empreintes des relances asynchrones en attente / déjà tentées (journal des réparations). */
  pendingHashes: ReadonlySet<string>;
  triedHashes: ReadonlySet<string>;
  /**
   * Lot 91D — décisions ACTIVES de T1 sur les valeurs, par clé
   * (`valueKey(unité, nature, forme normalisée)`). Fournies SEULEMENT quand
   * le prompt T1 effectif porte le contrat : absentes, le diagnostic est
   * exactement celui d'avant (mêmes constats, mêmes empreintes).
   */
  decisions?: ReadonlyMap<string, DecisionView>;
  /** Lot 91D — état du contrat T1 (`CARRIED`, `MARKER_MISSING`, `DISABLED`, `UNREADABLE`), pour le détail. */
  decisionContract?: string;
}

/** Lot 91D — décision active de T1 sur une valeur, telle que le contrôle la juge (forme, jamais pertinence). */
export interface DecisionView {
  id: number;
  decision: string | null;
  validity: 'VALID' | 'INVALID';
  invalidReason: string | null;
  confidence: string | null;
  /** Empreinte du texte de l'unité au moment de la décision. */
  unitFingerprint: string | null;
  /** Un fait ou un candidat rattaché est-il encore ACTIF ? */
  linkActive: boolean;
}

/** Lot 91D — qualification d'une valeur absente des faits T1 au regard de la décision de T1. */
type DecisionState = 'ABSENT' | 'INVALID' | 'STALE' | 'LINK_GONE' | 'UNDETERMINED' | 'JUSTIFIED';

/** Lot 91D — qualification d'un constat pour la Supervision. */
type Qualification = 'UNJUSTIFIED_OMISSION' | 'UNDETERMINED_DECISION' | 'REPAIR_TECHNICAL' | 'EXTRACT_TECHNICAL' | 'DOWNSTREAM';

/** État d'une valeur absente au regard de la décision active (pure). */
export function decisionStateOf(d: DecisionView | undefined, currentFingerprint: string | null): DecisionState {
  if (!d) return 'ABSENT';
  if (!d.unitFingerprint || d.unitFingerprint !== currentFingerprint) return 'STALE';
  if (d.validity !== 'VALID') return 'INVALID';
  if (d.decision === 'UNDETERMINED' || d.confidence === 'conflictual') return 'UNDETERMINED';
  if ((d.decision === 'STRUCTURED' || d.decision === 'COMPONENT_OR_CONTEXT') && !d.linkActive) return 'LINK_GONE';
  return 'JUSTIFIED';
}

type ExtractRepair = 'REEXTRACT' | 'T1_REPAIR' | 'PROJECT' | 'DECISION_REVIEW';

interface Diagnostic {
  link: ChainLink;
  anomaly: string;
  verdict: 'REPAIRABLE' | 'FINDING';
  repair?: ExtractRepair;
  hash: string;
  expected: unknown;
  observed: unknown;
  extra?: Record<string, unknown>;
}

/** Une valeur figure-t-elle dans la connaissance T1 ? (pure) */
function knownByT1(v: SignificantValue, k: T1Knowledge): boolean {
  if (v.kind === 'AMOUNT') return k.amounts.has(Number(v.normalized));
  if (v.kind === 'DATE') return k.dates.has(v.normalized);
  return k.identifiers.has(v.normalized);
}

const UNITES_LUES = new Set(['TEXT_BLOCK', 'LABEL_VALUE', 'FORM_FIELD', 'TABLE_ROW']);
const COUVERTES = new Set(['COVERED', 'NON_INFORMATIONAL']);
/** Contrôles aval qui exploitent chaque nature de valeur déjà présente dans T1 (aucun second moteur). */
const DOWNSTREAM_OWNERS: Readonly<Record<SignificantKind, readonly string[]>> = {
  AMOUNT: ['COH-TCO-EXTRACTED-EXPENSES'],
  DATE: ['COH-TODO-DOCUMENT-FIELDS', 'COH-AGENDA-ORPHANS'],
  IDENTIFIER: ['COH-DOC-LINKS'],
};

const valeurTracee = (v: SignificantValue) => ({ kind: v.kind, value: v.kind === 'IDENTIFIER' ? `#${hashOf(v.normalized).slice(0, 10)}` : v.normalized });

/**
 * Diagnostic de la chaîne d'un document (pure, déterministe) — voir l'en-tête.
 * Rend l'inspection : premier maillon RÉPARABLE dans l'ordre de la chaîne,
 * sinon premier constat, sinon cohérent ; tous les diagnostics au détail.
 */
export function diagnoseExtractChain(x: ExtractChainInput): Inspection {
  const diags: Diagnostic[] = [];

  // (c) EXTRACT : lacunes de pages en échec, pages manquantes à la vérification.
  const lacunes = x.units.filter((u) => u.kind === 'PAGE_GAP' && u.status === 'FAILED');
  if (lacunes.length || x.coverage.pagesMissing.length) {
    const hash = hashOf({ fileId: x.fileId, a: 'EXTRACT_INCOMPLETE', e: x.extractionId, gaps: lacunes.map((g) => [g.unitId, g.updatedAt]), missing: x.coverage.pagesMissing });
    const fiable = lacunes.every((g) => g.retryable === true);
    const observed = { gaps: lacunes.map((g) => g.unitId).slice(0, DETAIL_MAX), pagesMissing: x.coverage.pagesMissing.slice(0, DETAIL_MAX), retryAttempts: x.coverage.retryAttempts };
    const base = { link: 'EXTRACT' as const, hash, expected: 'extract complet (toutes les pages lues)', observed };
    const q = { qualification: 'EXTRACT_TECHNICAL' as Qualification };
    if (x.pendingHashes.has(hash)) diags.push({ ...base, anomaly: 'EXTRACT_INCOMPLETE', verdict: 'REPAIRABLE', repair: 'REEXTRACT', extra: { awaiting: true, ...q } });
    else if (x.triedHashes.has(hash)) diags.push({ ...base, anomaly: 'RELAUNCH_ALREADY_TRIED', verdict: 'FINDING', extra: { relaunch: 'REEXTRACT', ...q } });
    else if (!fiable) diags.push({ ...base, anomaly: 'EXTRACT_INCOMPLETE_UNRECOVERABLE', verdict: 'FINDING', extra: q });
    else if (x.coverage.nextRetryAt) diags.push({ ...base, anomaly: 'EXTRACT_RETRY_SCHEDULED', verdict: 'FINDING', extra: { handledBy: 't1-completeness-retry', nextRetryAt: x.coverage.nextRetryAt, ...q } });
    else if (x.coverage.retryAttempts >= x.maxRetries) diags.push({ ...base, anomaly: 'EXTRACT_INCOMPLETE_FINAL', verdict: 'FINDING', extra: q });
    else diags.push({ ...base, anomaly: 'EXTRACT_INCOMPLETE', verdict: 'REPAIRABLE', repair: 'REEXTRACT', extra: q });
  }

  // (b) T1 : valeurs de l'extract absentes de T1.
  const matched: Record<SignificantKind, number> = { AMOUNT: 0, DATE: 0, IDENTIFIER: 0 };
  let nonStructurees = 0;
  const carried = x.decisions !== undefined;
  type Absente = SignificantValue & { state?: DecisionState; decisionId?: number; code?: string | null };
  const omissions: Array<{ unit: ExtractUnit; values: Absente[] }> = [];
  const indeterminees: Array<{ unit: ExtractUnit; values: Absente[] }> = [];
  const justifiees: Array<{ unit: string; value: Absente; decision: string | null; id: number }> = [];
  const etats: Record<DecisionState, number> = { ABSENT: 0, INVALID: 0, STALE: 0, LINK_GONE: 0, UNDETERMINED: 0, JUSTIFIED: 0 };
  for (const u of x.units) {
    if (!UNITES_LUES.has(u.kind) || !u.text) continue;
    const absentes: Absente[] = [];
    const incertaines: Absente[] = [];
    const empreinte = carried ? unitFingerprint(u.text) : null;
    for (const v of significantValues(u.text, { identifiers: u.kind === 'LABEL_VALUE' })) {
      if (knownByT1(v, x.t1)) { matched[v.kind]++; continue; }
      if (knownByT1(v, x.t1Unstructured)) { nonStructurees++; continue; }
      if (!carried) { absentes.push(v); continue; }
      // Lot 91D : décision de T1 sur CETTE valeur de CETTE unité.
      const d = x.decisions!.get(valueKey(u.unitId, v.kind, v.normalized));
      const state = decisionStateOf(d, empreinte);
      etats[state]++;
      const av: Absente = { ...v, state, ...(d ? { decisionId: d.id, code: d.invalidReason } : {}) };
      if (state === 'JUSTIFIED') justifiees.push({ unit: u.unitId, value: av, decision: d!.decision, id: d!.id });
      else if (state === 'UNDETERMINED') incertaines.push(av);
      else absentes.push(av);
    }
    if (absentes.length) omissions.push({ unit: u, values: absentes });
    if (incertaines.length) indeterminees.push({ unit: u, values: incertaines });
  }
  const tracer = (v: Absente) => ({
    ...valeurTracee(v),
    ...(v.state ? { decision: { state: v.state, ...(v.decisionId ? { id: v.decisionId } : {}), ...(v.code ? { code: v.code } : {}) } } : {}),
  });
  const trace = (os: typeof omissions) => os.slice(0, DETAIL_MAX).map((o) => ({ unit: o.unit.unitId, status: o.unit.status, values: o.values.slice(0, 5).map(tracer) }));
  // Sans contrat : empreinte d'avant (constats inchangés) ; avec : l'état de décision en fait partie.
  const cle = (os: typeof omissions) => os.map((o) => [o.unit.unitId, o.values.map((v) => (carried ? `${v.kind}:${v.normalized}:${v.state}` : `${v.kind}:${v.normalized}`)).sort()]);
  const nonCouvertes = omissions.filter((o) => !COUVERTES.has(o.unit.status));
  const relancables = nonCouvertes.filter((o) => x.repairableUnitIds.has(o.unit.unitId));
  const epuisees = nonCouvertes.filter((o) => !x.repairableUnitIds.has(o.unit.unitId));
  const couvertes = omissions.filter((o) => COUVERTES.has(o.unit.status));
  // Lot 91D : réexamen ciblé des décisions (contrat porté) — unités couvertes et reprises épuisées, UNE fois par diagnostic.
  const relancablesEpuisees = relancables.length > 0 && !x.coverage.nextRetryAt && x.coverage.retryAttempts >= x.maxRetries;
  const aReexaminer = carried ? [...(relancablesEpuisees ? relancables : []), ...epuisees, ...couvertes] : [];
  // Empreinte SANS l'état des décisions : un seul réexamen par ensemble de valeurs omises (le réexamen change les états).
  // L'écriture de l'unité (nouvelle extraction, reprise) en fait partie : une source réécrite peut être réexaminée une fois.
  const valeursSeules = (os: typeof omissions) => os.map((o) => [o.unit.unitId, o.unit.updatedAt, o.values.map((v) => `${v.kind}:${v.normalized}`).sort()]);
  const reviewHash = aReexaminer.length ? hashOf({ fileId: x.fileId, a: 'DECISION_REVIEW', e: x.extractionId, omis: valeursSeules(aReexaminer) }) : null;
  const reviewTried = reviewHash !== null && x.triedHashes.has(reviewHash);
  const reviewDue = reviewHash !== null && !reviewTried;
  const revue = (anomaly: string, link: ChainLink, expected: string, qualification: Qualification): Diagnostic => ({
    link, anomaly, verdict: 'REPAIRABLE', repair: 'DECISION_REVIEW', hash: reviewHash!, expected, observed: trace(aReexaminer),
    extra: { qualification, motive: 'DECISION_REVIEW_DUE', decisionReview: 'DUE' },
  });
  const apresRevue = carried ? { decisionReview: reviewTried ? 'TRIED' : 'NONE' } : {};
  if (relancables.length) {
    const hash = hashOf({ fileId: x.fileId, a: 'FACT_OMITTED_BY_T1', e: x.extractionId, omis: cle(relancables) });
    const base = { link: 'T1' as const, hash, expected: 'valeur de l’extract reprise par T1 (fait ou indice)', observed: trace(relancables) };
    if (x.triedHashes.has(hash)) diags.push({ ...base, anomaly: 'RELAUNCH_ALREADY_TRIED', verdict: 'FINDING', extra: { relaunch: 'T1_REPAIR', qualification: 'REPAIR_TECHNICAL', motive: 'T1_REPAIR_ALREADY_TRIED' } });
    else if (x.coverage.nextRetryAt) diags.push({ ...base, anomaly: 'FACT_OMITTED_RETRY_SCHEDULED', verdict: 'FINDING', extra: { handledBy: 't1-completeness-retry', nextRetryAt: x.coverage.nextRetryAt, qualification: 'UNJUSTIFIED_OMISSION', motive: 'RETRY_SCHEDULED' } });
    else if (x.coverage.retryAttempts >= x.maxRetries) {
      if (reviewDue) diags.push(revue('FACT_OMITTED_REPAIR_EXHAUSTED', 'T1', 'valeur de l’extract reprise par T1, ou décision T1 motivée', 'REPAIR_TECHNICAL'));
      else diags.push({ ...base, anomaly: 'FACT_OMITTED_REPAIR_EXHAUSTED', verdict: 'FINDING', extra: { qualification: 'REPAIR_TECHNICAL', motive: carried ? 'NO_VALID_DECISION_AFTER_REVIEW' : 'REPAIR_EXHAUSTED', ...apresRevue } });
    } else diags.push({ ...base, anomaly: 'FACT_OMITTED_BY_T1', verdict: 'REPAIRABLE', repair: 'T1_REPAIR', extra: { qualification: 'UNJUSTIFIED_OMISSION', motive: 'T1_REPAIR_DUE' } });
  }
  if (epuisees.length) {
    if (reviewDue) diags.push(revue('FACT_OMITTED_REPAIR_EXHAUSTED', 'T1', 'valeur de l’extract reprise par T1, ou décision T1 motivée', 'REPAIR_TECHNICAL'));
    else {
      diags.push({ link: 'T1', anomaly: 'FACT_OMITTED_REPAIR_EXHAUSTED', verdict: 'FINDING', hash: hashOf({ fileId: x.fileId, a: 'EXHAUSTED', e: x.extractionId, omis: cle(epuisees) }),
        expected: 'valeur de l’extract reprise par T1', observed: trace(epuisees),
        extra: { qualification: 'REPAIR_TECHNICAL', motive: carried ? 'NO_VALID_DECISION_AFTER_REVIEW' : 'REPAIR_EXHAUSTED', ...apresRevue } });
    }
  }
  if (couvertes.length) {
    if (reviewDue) diags.push(revue('FACT_OMITTED_COVERED_UNIT', 'T1', 'valeur reprise par T1, ou décision T1 motivée sur cette valeur', 'UNJUSTIFIED_OMISSION'));
    else {
      diags.push({ link: 'T1', anomaly: 'FACT_OMITTED_COVERED_UNIT', verdict: 'FINDING', hash: hashOf({ fileId: x.fileId, a: 'COVERED', e: x.extractionId, omis: cle(couvertes) }),
        expected: 'valeur reprise par T1, ou écartée avec un motif (disposition T1)', observed: trace(couvertes),
        extra: carried
          ? { qualification: 'UNJUSTIFIED_OMISSION', motive: 'NO_VALID_DECISION_AFTER_REVIEW', ...apresRevue }
          : { pendingContract: T1_OMISSIONS_CONTRACT, qualification: 'UNJUSTIFIED_OMISSION', motive: 'DECISION_CONTRACT_PENDING' } });
    }
  }
  // Lot 91D : interprétation incertaine — jamais une conformité.
  if (indeterminees.length) {
    diags.push({ link: 'T1', anomaly: 'FACT_DECISION_UNDETERMINED', verdict: 'FINDING', hash: hashOf({ fileId: x.fileId, a: 'UNDETERMINED', e: x.extractionId, omis: cle(indeterminees) }),
      expected: 'décision T1 établie (structurée, composante ou contexte, non retenue avec motif)', observed: trace(indeterminees),
      extra: { qualification: 'UNDETERMINED_DECISION', motive: 'T1_UNDETERMINED' } });
  }

  // (a) aval : faits T1 jamais projetés sur le bien du document.
  if (x.projection && x.projection.expectedKeys.length > 0 && x.projection.evidenceCount === 0) {
    const keys = [...new Set(x.projection.expectedKeys)].sort();
    diags.push({
      link: 'PERSISTENCE', anomaly: 'FACTS_NOT_PROJECTED', verdict: 'REPAIRABLE', repair: 'PROJECT',
      hash: hashOf({ fileId: x.fileId, a: 'FACTS_NOT_PROJECTED', assetId: x.projection.assetId, keys }),
      expected: { assetId: x.projection.assetId, fields: keys.slice(0, DETAIL_MAX) }, observed: { evidence: 0 },
      extra: { qualification: 'DOWNSTREAM', motive: 'FACTS_NOT_PROJECTED' },
    });
  }

  const resume = diags.map((d) => ({ link: d.link, anomaly: d.anomaly, verdict: d.verdict }));
  const commun = {
    matched, t1Unstructured: nonStructurees, diagnostics: resume,
    downstreamOwners: [...new Set((Object.keys(matched) as SignificantKind[]).filter((k) => matched[k] > 0).flatMap((k) => DOWNSTREAM_OWNERS[k]))],
    // Lot 91D : décisions T1 (contrat porté) — décompte par état et échantillon des justifications retenues (motif de résolution).
    ...(carried ? {
      valueDecisions: {
        contract: 'CARRIED', justified: etats.JUSTIFIED, undetermined: etats.UNDETERMINED, absent: etats.ABSENT,
        invalid: etats.INVALID, stale: etats.STALE, linkGone: etats.LINK_GONE,
        justifiedSample: justifiees.slice(0, 3).map((j) => ({ unit: j.unit, ...valeurTracee(j.value), decision: j.decision, id: j.id })),
      },
    } : x.decisionContract ? { valueDecisions: { contract: x.decisionContract } } : {}),
  };
  const choisi = diags.find((d) => d.verdict === 'REPAIRABLE') ?? diags.find((d) => d.verdict === 'FINDING');
  if (!choisi) return { verdict: 'CONSISTENT', detail: commun };
  return {
    verdict: choisi.verdict, anomaly: choisi.anomaly, faultyLink: choisi.link, expected: choisi.expected, observed: choisi.observed,
    detail: { ...commun, ...(choisi.extra ?? {}), repair: choisi.repair ?? null, t1Relaunch: choisi.repair === 'T1_REPAIR', reextract: choisi.repair === 'REEXTRACT' },
    inputHash: choisi.hash,
  };
}

// ── Lectures (lecture seule) ─────────────────────────────────────────────────

const vide = (): T1Knowledge => ({ amounts: new Set(), dates: new Set(), identifiers: new Set() });

/** Ajoute à la connaissance les formes normalisées d'une valeur rendue par T1 (texte ou nombre). */
async function ajouterValeur(k: T1Knowledge, v: unknown): Promise<void> {
  if (v === null || v === undefined || v === '') return;
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Montant en unités (« 1234.5 ») ou déjà en centimes (« 123400 ») : les deux lectures sont retenues (prudence : jamais d'omission inventée).
    k.amounts.add(Math.round(v * 100));
    if (Number.isInteger(v)) k.amounts.add(v);
    return;
  }
  const s = String(v).trim();
  if (!s) return;
  for (const x of significantValues(s, { identifiers: true })) {
    if (x.kind === 'AMOUNT') k.amounts.add(Number(x.normalized));
    else if (x.kind === 'DATE') k.dates.add(x.normalized);
    else k.identifiers.add(x.normalized);
  }
  const { normalizeDateValue } = await import('@/services/canonical/registry/normalize');
  const d = normalizeDateValue(s);
  if (d) k.dates.add(d);
  const m = /^-?(\d{1,3}(?:[   .]\d{3})+|\d+)(?:[.,](\d{1,2}))?\s*(?:€|eur|euros?)?$/i.exec(s);
  if (m) {
    const c = amountToCents(m[1], m[2] ?? null);
    if (c !== null) k.amounts.add(c);
    if (!m[2] && /^\d+$/.test(m[1])) k.amounts.add(Number(m[1]));
  }
  const id = compactIdentifier(s);
  if (id.length >= 4) k.identifiers.add(id);
}

/** Valeurs (montants, dates) des candidats d'Opération T1 (indices financiers et temporels). */
function valeursCandidat(payload: unknown): unknown[] {
  const p = (typeof payload === 'string' ? JSON.parse(payload) : payload) as Record<string, unknown> | null;
  if (!p) return [];
  const out: unknown[] = [];
  for (const h of (Array.isArray(p.financialHints) ? p.financialHints : []) as Array<Record<string, unknown>>) {
    if (typeof h.amountMinor === 'number') out.push({ cents: h.amountMinor });
    for (const k of ['economicDate', 'periodStart', 'periodEnd']) if (typeof h[k] === 'string') out.push(h[k]);
  }
  const t = (p.temporalHints ?? {}) as Record<string, unknown>;
  for (const v of Object.values(t)) if (typeof v === 'string') out.push(v);
  return out;
}

interface Loaded {
  files: Map<number, Row>;
  units: Map<number, ExtractUnit[]>;
  t1: Map<number, T1Knowledge>;
  unstructured: Map<number, T1Knowledge>;
  evidence: Map<string, number>;
  journal: Map<number, { pending: Set<string>; tried: Set<string> }>;
  /** Lot 91D : faits ACTIFS et candidats ACTIFS par document (rattachements des décisions). */
  factIds: Map<number, Set<number>>;
  candidateKeys: Map<number, Set<string>>;
}

async function charger(ctx: CheckContext, accountId: number, ids: readonly number[]): Promise<Loaded> {
  const ens = intArray(ids);
  const files = new Map((await rows(ctx.sql, `
    SELECT f.id, f.asset_id, (a.id IS NOT NULL AND a.deleted_at IS NULL) AS asset_live,
           c.extraction_id, c.retry_attempts, to_char(c.next_retry_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS next_retry_at,
           to_jsonb(c)->'verification' AS verification
      FROM asset_files f
      JOIN document_extraction_coverage c ON c.file_id = f.id AND c.account_id = f.account_id
      LEFT JOIN assets a ON a.id = f.asset_id AND a.account_id = f.account_id
     WHERE f.account_id = $1 AND f.id = ANY($2::int[]) AND ${OPEN_DOCUMENT_SQL}`, [accountId, ens])).map((r) => [Number(r.id), r]));
  const units = new Map<number, ExtractUnit[]>();
  for (const u of await rows(ctx.sql, `
    SELECT u.file_id, u.source_unit_id, u.kind, u.ordinal, u.content_text, u.label, u.value_text, u.coverage_status, u.coverage_reason, u.salient,
           u.repair_attempts, to_jsonb(u)->>'repair_state' AS repair_state, u.payload->>'retryable' AS retryable,
           to_char(u.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS updated_at
      FROM document_source_units u
     WHERE u.account_id = $1 AND u.file_id = ANY($2::int[]) AND u.kind IN ('TEXT_BLOCK', 'LABEL_VALUE', 'FORM_FIELD', 'TABLE_ROW', 'PAGE_GAP')
     ORDER BY u.file_id, u.ordinal`, [accountId, ens])) {
    const texte = (u.content_text as string | null) ?? (u.label || u.value_text ? `${u.label ?? ''} : ${u.value_text ?? ''}` : null);
    const l = units.get(Number(u.file_id)) ?? [];
    l.push({
      unitId: String(u.source_unit_id), kind: String(u.kind), ordinal: Number(u.ordinal), text: texte, status: String(u.coverage_status),
      reason: (u.coverage_reason as string | null) ?? null, salient: u.salient === true, repairAttempts: Number(u.repair_attempts ?? 0),
      repairState: (u.repair_state as string | null) ?? null, retryable: u.retryable == null ? null : u.retryable === 'true',
      updatedAt: (u.updated_at as string | null) ?? null,
    });
    units.set(Number(u.file_id), l);
  }
  const t1 = new Map<number, T1Knowledge>();
  const factIds = new Map<number, Set<number>>();
  const candidateKeys = new Map<number, Set<string>>();
  const de = (m: Map<number, T1Knowledge>, id: number) => { let k = m.get(id); if (!k) { k = vide(); m.set(id, k); } return k; };
  for (const f of await rows(ctx.sql, `
    SELECT f.id::float8 AS id, f.file_id, f.value_text, f.normalized_value, f.value_number::float8 AS value_number,
           to_char(f.period_start, 'YYYY-MM-DD') AS period_start, to_char(f.period_end, 'YYYY-MM-DD') AS period_end,
           to_jsonb(f)->>'raw_value' AS raw_value
      FROM document_facts f WHERE f.account_id = $1 AND f.file_id = ANY($2::int[]) AND f.status = 'active'`, [accountId, ens])) {
    const k = de(t1, Number(f.file_id));
    factIds.set(Number(f.file_id), (factIds.get(Number(f.file_id)) ?? new Set<number>()).add(Number(f.id)));
    for (const v of [f.value_text, f.normalized_value, f.raw_value, f.period_start, f.period_end]) await ajouterValeur(k, v);
    if (f.value_number != null) await ajouterValeur(k, Number(f.value_number));
  }
  for (const e of await rows(ctx.sql, `
    SELECT file_id, amount_cents::float8 AS amount_cents, to_char(document_date, 'YYYY-MM-DD') AS document_date
      FROM document_extractions WHERE account_id = $1 AND file_id = ANY($2::int[])`, [accountId, ens])) {
    const k = de(t1, Number(e.file_id));
    if (e.amount_cents != null) k.amounts.add(Number(e.amount_cents));
    if (e.document_date) k.dates.add(String(e.document_date));
  }
  for (const c of await rows(ctx.sql, `
    SELECT file_id, candidate_key, payload FROM document_operation_candidates WHERE account_id = $1 AND file_id = ANY($2::int[]) AND status = 'ACTIVE'`, [accountId, ens])) {
    const k = de(t1, Number(c.file_id));
    candidateKeys.set(Number(c.file_id), (candidateKeys.get(Number(c.file_id)) ?? new Set<string>()).add(String(c.candidate_key)));
    for (const v of valeursCandidat(c.payload)) {
      if (v && typeof v === 'object' && 'cents' in (v as Record<string, unknown>)) k.amounts.add(Number((v as { cents: number }).cents));
      else await ajouterValeur(k, v);
    }
  }
  const unstructured = new Map<number, T1Knowledge>();
  for (const u of await rows(ctx.sql, `
    SELECT file_id, raw_value FROM document_unresolved_facts WHERE account_id = $1 AND file_id = ANY($2::int[]) AND raw_value IS NOT NULL`, [accountId, ens])) {
    await ajouterValeur(de(unstructured, Number(u.file_id)), u.raw_value);
  }
  const evidence = new Map<string, number>();
  for (const e of await rows(ctx.sql, `
    SELECT source_id, asset_id, count(*)::int AS n FROM field_evidence
     WHERE account_id = $1 AND source_type IN ('document', 'web_link') AND source_id = ANY($2::int[]) GROUP BY 1, 2`, [accountId, ens])) {
    evidence.set(`${e.source_id}:${e.asset_id}`, Number(e.n));
  }
  const journal = new Map<number, { pending: Set<string>; tried: Set<string> }>();
  for (const j of await rows(ctx.sql, `
    SELECT object_id, input_hash, outcome FROM coherence_repairs
     WHERE account_id = $1 AND check_id = $2 AND object_id = ANY($3::bigint[]) AND input_hash IS NOT NULL AND outcome IN ('PENDING', 'INEFFECTIVE', 'REPAIRED')`,
  [accountId, EXTRACT_CHAIN_CHECK_ID, ens])) {
    const id = Number(j.object_id);
    const x = journal.get(id) ?? { pending: new Set<string>(), tried: new Set<string>() };
    (j.outcome === 'PENDING' ? x.pending : x.tried).add(String(j.input_hash));
    journal.set(id, x);
  }
  return { files, units, t1, unstructured, evidence, journal, factIds, candidateKeys };
}

/**
 * Lot 91D — décisions ACTIVES des documents, par clé de valeur, avec l'état
 * de leurs rattachements (fait ou candidat encore actif). Lecture seule.
 */
async function chargerDecisions(ctx: CheckContext, accountId: number, ids: readonly number[], d: Loaded): Promise<Map<number, Map<string, DecisionView>>> {
  const { loadActiveValueDecisions } = await import('@/services/ai/source-analysis/value-decisions/store');
  const out = new Map<number, Map<string, DecisionView>>();
  for (const x of await loadActiveValueDecisions(ctx.sql as never, accountId, ids)) {
    if (!x.sourceUnitId || !x.kind || !x.normalizedValue) continue;
    const faits = d.factIds.get(x.fileId);
    const cands = d.candidateKeys.get(x.fileId);
    const linkActive = x.relatedFactIds.some((id) => faits?.has(id)) || x.relatedCandidateKeys.some((k) => cands?.has(k));
    const m = out.get(x.fileId) ?? new Map<string, DecisionView>();
    // Plusieurs décisions actives pour une valeur (unités ex æquo) : la plus récente prime.
    m.set(valueKey(x.sourceUnitId, x.kind, x.normalizedValue), {
      id: x.id, decision: x.decision, validity: x.validity, invalidReason: x.invalidReason, confidence: x.confidence,
      unitFingerprint: x.unitFingerprint, linkActive,
    });
    out.set(x.fileId, m);
  }
  return out;
}

/** Champs attendus de la projection du document sur son bien (même calcul que la projection). */
async function projectionAttendue(accountId: number, fileId: number, assetId: number): Promise<string[]> {
  const [{ getDocumentKnowledge, linkedAssetProjectionFields }, { isInputOnlyKey }] = await Promise.all([
    import('@/services/ai/knowledge/document-knowledge.service'), import('@/services/canonical/registry'),
  ]);
  const k = await getDocumentKnowledge(accountId, fileId);
  if (!k || k.facts.length === 0) return [];
  return linkedAssetProjectionFields(k, assetId)
    .filter((f) => !f.target || (f.target.targetType === 'ASSET' && f.target.targetEntityId === assetId))
    .map((f) => f.canonicalKey ?? f.fieldKey)
    .filter((key) => !isInputOnlyKey(key));
}

// ── Contrôle du registre ─────────────────────────────────────────────────────

export const extractChainCheck: CoherenceCheck = {
  id: EXTRACT_CHAIN_CHECK_ID,
  version: 1,
  status: 'ACTIVE',
  title: 'Chaîne document → extract → T1 → aval (omissions de l’extraction, maillon défaillant)',
  domain: 'documents-t1',
  level: 'N3',
  objectType: 'document',
  scope: 'documents visibles du compte dont l’extract existe (couche A : unités sources et couverture)',
  sources: ['document_source_units', 'document_extraction_coverage', 'document_facts', 'document_unresolved_facts', 'document_extractions', 'document_operation_candidates', 'document_value_decisions', 'field_evidence', 'coherence_repairs'],
  applicability: 'compte éligible ; document dont la couche A est écrite (sinon : reprise historique t1-source-units-backfill)',
  invariant: 'toute valeur significative de l’extract est reprise par T1 (ou qualifiée par une décision T1 valide et motivée) puis exploitée en aval ; l’extract lui-même est complet',
  anomalies: [
    'EXTRACT_INCOMPLETE', 'EXTRACT_RETRY_SCHEDULED', 'EXTRACT_INCOMPLETE_FINAL', 'EXTRACT_INCOMPLETE_UNRECOVERABLE',
    'FACT_OMITTED_BY_T1', 'FACT_OMITTED_RETRY_SCHEDULED', 'FACT_OMITTED_REPAIR_EXHAUSTED', 'FACT_OMITTED_COVERED_UNIT',
    'FACTS_NOT_PROJECTED', 'RELAUNCH_ALREADY_TRIED',
    // Lot 91D : décision T1 incertaine sur une valeur (contrat t1-value-decisions-v1 porté).
    'FACT_DECISION_UNDETERMINED',
  ],
  autoRepairWhen: 'premier maillon réparable seulement : réextraction (lacune fiable, reprise disponible) ; passe T1 ciblée (unité non couverte, encore réparable) ; réexamen ciblé des décisions T1 (contrat porté, unité couverte ou reprise épuisée, une fois par diagnostic) ; projection aval (faits jamais projetés)',
  forbiddenRepairs: [
    'relancer T1 sur tout le document sans diagnostic', 'relancer deux fois le même diagnostic', 'juger la pertinence d’une valeur à la place de T1',
    'inventer une valeur absente ou ambiguë', 'relancer T1 pour une information déjà extraite (réparation aval seule)', 'appeler l’IA en mode à blanc',
    'justifier une valeur à la place de T1 (motif générique, décision simulée)', 'réanalyser tout le document pour qualifier une valeur',
  ],
  services: [
    'ai/source-analysis/source-units/jobs#requeueDocumentForReread', 'ai/source-analysis/source-units/jobs#repairDocumentSourceUnits (passe repair.ts)',
    'ai/knowledge/document-knowledge.service#projectDocumentKnowledgeToAsset', 'coherence/orchestrator#requestTargetedChecks (propagation aval)',
    'ai/source-analysis/value-decisions/review#reviewDocumentValueDecisions (réexamen ciblé des décisions T1, lot 91D)',
  ],
  chain: ['EXTRACT', 'T1', 'T3', 'T4', 'PERSISTENCE'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPDATED', 'DOCUMENT_UPLOADED'],
  frequency: 'campagne exhaustive quotidienne (lecture seule, sans IA) + contrôle ciblé après chaque analyse ou modification du document',
  criticality: 'HIGH',
  tests: ['L83B-U-EXTRACT', 'L83B-E2E-01', 'L83B-E2E-02', 'L83B-E2E-03', 'L83B-E2E-04', 'L83B-E2E-05', 'L83B-E2E-11', 'L91D-U', 'L91D-E2E'],
  // Lot 91D : rattrapage des documents déjà en constat d'omission dès que le contrat T1 est porté (réexamen ciblé).
  async catchupCandidates(c) {
    return decisionReviewCatchup(c);
  },

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `
      SELECT f.id FROM asset_files f
        JOIN document_extraction_coverage c ON c.file_id = f.id AND c.account_id = f.account_id
       WHERE f.account_id = $1 AND f.id > $2 AND ${OPEN_DOCUMENT_SQL} ORDER BY f.id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    return idsOf(await rows(ctx.sql, `
      SELECT f.id FROM asset_files f JOIN document_extraction_coverage c ON c.file_id = f.id AND c.account_id = f.account_id
       WHERE f.account_id = $1 AND f.id = $2 AND ${OPEN_DOCUMENT_SQL}`, [accountId, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const d = await charger(ctx, accountId, ids);
    const [{ maxCompletenessRetries }, { repairAttemptCap }, { selectRepairUnits }] = await Promise.all([
      import('@/services/ai/source-analysis/source-units/repository'),
      import('@/services/ai/source-analysis/source-units/repair'),
      import('@/services/ai/source-analysis/source-units/coverage'),
    ]);
    const maxRetries = maxCompletenessRetries();
    const cap = repairAttemptCap();
    let budget = await t1RelaunchBudgetLeft(ctx);
    // Lot 91D : décisions T1 exploitées SEULEMENT si le prompt T1 effectif porte le contrat (sinon : constats d'avant).
    const { valueDecisionsCapability } = await import('@/services/ai/source-analysis/value-decisions/contract');
    const contrat = await valueDecisionsCapability();
    const decisions = contrat.carried ? await chargerDecisions(ctx, accountId, ids, d) : null;
    for (const fileId of ids) {
      const f = d.files.get(fileId);
      if (!f) { out.set(fileId, { verdict: 'GONE' }); continue; }
      const units = d.units.get(fileId) ?? [];
      const reparables = new Set(selectRepairUnits(units.map((u) => ({
        sourceUnitId: u.unitId, kind: u.kind as never, page: null, ordinal: u.ordinal, parentUnitId: null, text: u.text, payload: {}, location: {},
        origin: 'PASS_1', salient: u.salient, status: u.status as never, reason: u.reason, factCount: 0, repairAttempts: u.repairAttempts,
        repairState: (u.repairState ?? null) as never,
      })), cap).map((u) => u.sourceUnitId));
      const assetId = f.asset_id != null && f.asset_live === true ? Number(f.asset_id) : null;
      const evidenceCount = assetId ? (d.evidence.get(`${fileId}:${assetId}`) ?? 0) : 0;
      const verification = (typeof f.verification === 'string' ? JSON.parse(f.verification) : f.verification) as { pagesMissing?: unknown } | null;
      const j = d.journal.get(fileId);
      const i = diagnoseExtractChain({
        fileId, extractionId: f.extraction_id == null ? null : Number(f.extraction_id),
        coverage: {
          retryAttempts: Number(f.retry_attempts ?? 0), nextRetryAt: (f.next_retry_at as string | null) ?? null,
          pagesMissing: Array.isArray(verification?.pagesMissing) ? (verification!.pagesMissing as unknown[]).map(Number).filter(Number.isInteger) : [],
        },
        units, t1: d.t1.get(fileId) ?? vide(), t1Unstructured: d.unstructured.get(fileId) ?? vide(),
        // Projection attendue calculée seulement quand aucune preuve n'existe (coût borné).
        projection: assetId && evidenceCount === 0 ? { assetId, expectedKeys: await projectionAttendue(accountId, fileId, assetId), evidenceCount } : null,
        repairableUnitIds: reparables, maxRetries, pendingHashes: j?.pending ?? new Set(), triedHashes: j?.tried ?? new Set(),
        ...(decisions ? { decisions: decisions.get(fileId) ?? new Map() } : {}), decisionContract: contrat.reason,
      });
      // Budget des relances IA : au-delà, MÊME diagnostic en constat (l'anti-boucle reste exact ; relancé plus tard).
      const relance = i.verdict === 'REPAIRABLE' && (i.detail?.repair === 'T1_REPAIR' || i.detail?.repair === 'REEXTRACT' || i.detail?.repair === 'DECISION_REVIEW')
        && i.detail?.awaiting !== true;
      if (relance && budget <= 0) out.set(fileId, { ...i, verdict: 'FINDING', detail: { ...i.detail, relaunchBudgetReached: true } });
      else {
        if (relance) budget--;
        out.set(fileId, i);
      }
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const jobs = await import('@/services/ai/source-analysis/source-units/jobs');
    const { requestTargetedChecks } = await import('../../orchestrator');
    for (const { id, inspection } of items) {
      const quoi = (inspection.detail?.repair ?? null) as ExtractRepair | null;
      const [doc] = await rows(ctx.sql, `
        SELECT f.asset_id, f.analysis_state, c.retry_attempts, a.owner_user_id
          FROM asset_files f JOIN document_extraction_coverage c ON c.file_id = f.id JOIN accounts a ON a.id = f.account_id
         WHERE f.account_id = $1 AND f.id = $2`, [accountId, id]);
      if (!doc) { out.set(id, { called: false, service: 'none', result: { skipped: 'DOCUMENT_GONE' } }); continue; }
      // Analyse en cours : aucune relance concurrente (le recontrôle suivant reprendra avec le nouvel extract).
      if (doc.analysis_state === 'ANALYZING' || doc.analysis_state === 'UPLOADED') {
        out.set(id, { called: false, service: 'none', result: { skipped: 'ANALYSIS_IN_PROGRESS' } });
        continue;
      }
      // Propagation aval : contrôles du document redemandés (jamais ce contrôle-ci).
      const propager = async () => requestTargetedChecks({
        accountId, sql: ctx.sql, skipEligibility: true, excludeChecks: [EXTRACT_CHAIN_CHECK_ID],
        event: { type: 'SOURCE_ANALYZED', entityId: id, assetId: doc.asset_id == null ? null : Number(doc.asset_id) },
      }).catch(() => ({}));
      if (quoi === 'REEXTRACT') {
        const ok = await jobs.requeueDocumentForReread({
          fileId: id, accountId, attempt: Number(doc.retry_attempts ?? 0) + 1, origin: 'coherence-control', result: 'REQUEUED_T1_COHERENCE',
        });
        if (!ok) throw new Error('nouvelle extraction refusée par la file T1');
        out.set(id, {
          called: true, service: 'requeueDocumentForReread', pending: true, aiCalls: 0,
          result: { queued: true, origin: 'coherence-control', diagnostic: inspection.anomaly, propagation: 'à l’analyse (abonnés de fin d’analyse T1)' },
          rollbackRef: `document_extraction_coverage:file=${id}:last_retry_result=REQUEUED_T1_COHERENCE`,
        });
      } else if (quoi === 'T1_REPAIR') {
        const r = await jobs.repairDocumentSourceUnits({ accountId, fileId: id });
        const propagation = r.newFacts > 0 ? await propager() : {};
        out.set(id, {
          called: true, service: 'repairDocumentSourceUnits', aiCalls: r.calls,
          result: { outcome: r.outcome, calls: r.calls, attempted: r.attempted.slice(0, DETAIL_MAX), newFacts: r.newFacts, coverageResult: r.result, propagation },
          rollbackRef: `document_facts:file=${id}:origin=REPAIR`,
        });
      } else if (quoi === 'DECISION_REVIEW') {
        // Lot 91D : réexamen ciblé des décisions T1 sur les SEULES unités en constat (texte persisté, aucun fichier relu).
        const unites = [...new Set(((inspection.observed ?? []) as Array<{ unit?: string }>).map((o) => o.unit).filter((u): u is string => typeof u === 'string'))];
        const { reviewDocumentValueDecisions } = await import('@/services/ai/source-analysis/value-decisions/review');
        const r = await reviewDocumentValueDecisions({ accountId, fileId: id, unitIds: unites, origin: 'coherence-control' });
        if (r.outcome === 'FAILED') throw new Error(`réexamen des décisions T1 en échec : ${r.error ?? 'erreur'}`);
        const propagation = r.newFacts > 0 ? await propager() : {};
        out.set(id, {
          called: r.calls > 0, service: REVIEW_SERVICE, aiCalls: r.calls,
          result: { outcome: r.outcome, calls: r.calls, units: unites.slice(0, DETAIL_MAX), decisions: r.decisions, newFacts: r.newFacts, propagation },
          rollbackRef: `document_value_decisions:file=${id}:origin=REVIEW;document_facts:file=${id}:origin=REPAIR`,
        });
      } else if (quoi === 'PROJECT') {
        if (doc.asset_id == null) throw new Error('document sans bien : projection impossible');
        const { projectDocumentKnowledgeToAsset } = await import('@/services/ai/knowledge/document-knowledge.service');
        await projectDocumentKnowledgeToAsset({ accountId, userId: Number(doc.owner_user_id), fileId: id, assetId: Number(doc.asset_id) });
        const propagation = await propager();
        out.set(id, {
          called: true, service: 'projectDocumentKnowledgeToAsset', aiCalls: 0,
          result: { assetId: Number(doc.asset_id), t1Relaunch: false, propagation },
          rollbackRef: `field_evidence:source_id=${id}`,
        });
      } else {
        out.set(id, { called: false, service: 'none', result: { skipped: 'NO_REPAIR_FOR_DIAGNOSTIC' } });
      }
    }
    return out;
  },
};

/** Constats d'omission repris par le rattrapage 91D (documents du diagnostic du 26/10/2026 et suivants). */
const REVIEW_ANOMALIES = ['FACT_OMITTED_COVERED_UNIT', 'FACT_OMITTED_REPAIR_EXHAUSTED'];

/**
 * Lot 91D — RATTRAPAGE : documents dont la preuve porte encore un constat
 * d'omission établi SANS le contrat T1 (aucun réexamen tenté depuis) — un
 * contrôle ciblé est demandé ; c'est le contrôle qui décide du réexamen
 * (mode de campagne, budget, anti-boucle). Contrat non porté : rien (les
 * constats restent ceux d'avant). Idempotent : un document déjà demandé, ou
 * déjà réexaminé depuis son constat, n'est pas repris.
 */
async function decisionReviewCatchup(c: {
  sql: CheckContext['sql']; now: Date; limit: number; accountId?: number | null; apply: boolean; eligible?: (accountId: number) => Promise<boolean>;
}): Promise<CatchupCandidate[]> {
  const { valueDecisionsCapability } = await import('@/services/ai/source-analysis/value-decisions/contract');
  if (!(await valueDecisionsCapability()).carried) return [];
  const lignes = await rows(c.sql, `
    SELECT p.account_id, p.object_id FROM coherence_object_proofs p
     WHERE p.check_id = $1 AND p.last_result = 'FINDING' AND p.requested_at IS NULL AND p.finding->>'anomaly' = ANY($2::text[])
       AND ($3::int IS NULL OR p.account_id = $3)
       AND NOT EXISTS (SELECT 1 FROM coherence_repairs r WHERE r.account_id = p.account_id AND r.check_id = p.check_id AND r.object_id = p.object_id
                          AND r.service = $4 AND r.created_at >= COALESCE(p.first_detected_at, '-infinity'::timestamptz))
     ORDER BY p.account_id, p.object_id LIMIT $5`, [EXTRACT_CHAIN_CHECK_ID, REVIEW_ANOMALIES, c.accountId ?? null, REVIEW_SERVICE, c.limit]);
  const out: CatchupCandidate[] = [];
  const eligibles = new Map<number, boolean>();
  for (const l of lignes) {
    const accountId = Number(l.account_id);
    if (!eligibles.has(accountId)) eligibles.set(accountId, !c.eligible || await c.eligible(accountId));
    if (eligibles.get(accountId)) out.push({ accountId, objectId: Number(l.object_id), reason: 'DECISION_REVIEW' });
  }
  return out;
}
