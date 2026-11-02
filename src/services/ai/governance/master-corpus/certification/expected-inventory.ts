/**
 * Lot 105B — RÉFÉRENTIEL D'INVENTAIRE ATTENDU, versionné (ticket P1 « IA
 * auto-amélioration », §2 ; #601). PUR, sans base.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI
 *
 * Le verrou A1 du lot 100B ne jugeait que les entrées PRÉSENTES au manifeste :
 * un corpus incomplet (ZIP #601 non reçu : 127 entrées au lieu de 401 + 15)
 * pouvait passer au vert sur le périmètre déclaré. Ce référentiel décrit ce
 * qui DOIT exister — indépendamment de ce qui a été importé — et chaque manque
 * devient un BLOCAGE de la promotion automatique (pas seulement un affichage) :
 *
 *   · totaux du ZIP #601 rapprochés entrée par entrée : 86 historiques + 20 à
 *     revalider + 295 nouveaux (= 401), 15 stress distincts, 110 paires A/B ;
 *   · par traitement : difficultés et types de test couverts par au moins une
 *     référence APPROUVÉE, paires valides minimales ;
 *   · cas obligatoires nommés (ex. références T6 à certifier individuellement) ;
 *   · tout cas de qualité du périmètre non approuvé, ou approuvé mais non
 *     exécuté / non concluant sur la candidate, interdit la promotion ;
 *   · complétude T2 du CDC 4 §35.3 (9 catégories × 8 références approuvées,
 *     précision ≥ 95 %) intégrée à la décision bloquante ;
 *   · opérations actives et familles de risque : TOUJOURS dérivées du registre
 *     courant et de `RISK_FAMILIES` (`coverage.ts`), jamais figées ici.
 *
 * EXCLUSIONS : une exigence ne disparaît jamais en silence. Une exclusion est
 * une ligne de CE fichier (relue en revue de code), avec l'identifiant exact de
 * l'exigence, le motif, l'auteur et la date ; elle est affichée « exclue
 * (motif) » partout où l'exigence l'aurait été. Aucun seuil n'est abaissé
 * automatiquement : seule une nouvelle version de ce fichier change une règle.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { Treatment } from '../../../config/treatments';
import { TREATMENTS } from '../../../config/treatments';
import type { CaseStatus, Difficulty, ManifestEntry, TestType } from './model';

export type InventoryGroup = 'HISTORIQUE' | 'A_REVALIDER' | 'NOUVEAU' | 'STRESS';

export interface InventoryExclusion {
  /** Identifiant EXACT de l'exigence (voir `requirementIds`). */
  requirement: string;
  reason: string;
  decidedBy: string;
  at: string;
}

export interface ExpectedInventory {
  version: string;
  source: string;
  /** Totaux annoncés du ZIP #601 (rapprochement entrée par entrée, sans double comptage). */
  totals: { historical: number; toRevalidate: number; newScenarios: number; stress: number; pairs: number };
  perTreatment: Readonly<Record<Treatment, { difficulties: readonly Difficulty[]; testTypes: readonly TestType[]; minValidPairs: number }>>;
  /** Cas nommés qui DOIVENT exister, être critiques et non rejetés (leur approbation est exigée par la règle des cas critiques). */
  requiredCases: ReadonlyArray<{ id: string; treatment: Treatment; operationCode: string; reason: string }>;
  /** Tout cas de qualité du périmètre doit être approuvé (aucun « à compléter » toléré). */
  requireAllCasesApproved: boolean;
  /** Tout cas approuvé du périmètre doit être exécuté et concluant sur la candidate. */
  requireConclusiveResults: boolean;
  t2Completeness: { required: boolean; source: string };
  exclusions: readonly InventoryExclusion[];
}

const TOUTES_DIFFICULTES: readonly Difficulty[] = ['SIMPLE', 'INTERMEDIAIRE', 'DIFFICILE', 'ADVERSARIAL'];
const TYPES_QUALITE: readonly TestType[] = ['QUALITE_MODELE', 'PAIRE_ADVERSARIALE'];

/**
 * Référentiel en vigueur. Une évolution = une nouvelle `version` (elle entre dans l'empreinte de contexte A1 :
 * les candidates bloquées sont réévaluées, les preuves antérieures ne valent plus pour une promotion).
 * À CONFIRMER à réception du ZIP #601 : répartition des 110 paires et des 15 stress par traitement (si un
 * traitement n'a réellement aucune paire, ajouter une EXCLUSION motivée, jamais retirer l'exigence).
 */
export const EXPECTED_INVENTORY: ExpectedInventory = Object.freeze({
  version: 'inventaire-attendu-v1',
  source: '#601 (ZIP annoncé le 27/10/2026 : 401 scénarios dont 86 historiques, 20 à revalider, 295 nouveaux ; 110 paires ; 15 stress) · CDC 4 §35.3 (T2) · ticket IA auto-amélioration du 02/11/2026',
  totals: { historical: 86, toRevalidate: 20, newScenarios: 295, stress: 15, pairs: 110 },
  perTreatment: {
    T1: { difficulties: TOUTES_DIFFICULTES, testTypes: TYPES_QUALITE, minValidPairs: 1 },
    T2: { difficulties: TOUTES_DIFFICULTES, testTypes: TYPES_QUALITE, minValidPairs: 1 },
    T3: { difficulties: TOUTES_DIFFICULTES, testTypes: TYPES_QUALITE, minValidPairs: 1 },
    T4: { difficulties: TOUTES_DIFFICULTES, testTypes: TYPES_QUALITE, minValidPairs: 1 },
    T6: { difficulties: TOUTES_DIFFICULTES, testTypes: TYPES_QUALITE, minValidPairs: 1 },
  },
  requiredCases: [
    { id: 'H-P-T6-01-FORMULATION-FIDELE', treatment: 'T6', operationCode: 't6_formulate', reason: 'référence T6 existante à certifier individuellement (complément T6 v11)' },
    { id: 'H-P-T6-EV-01-DECISION-VALIDE', treatment: 'T6', operationCode: 't6_evaluate', reason: 'référence T6 existante à certifier individuellement (complément T6 v11)' },
  ],
  requireAllCasesApproved: true,
  requireConclusiveResults: true,
  t2Completeness: { required: true, source: 'CDC 4 §35.3 : 95 % de bonnes réponses, au moins 8 cas par catégorie §35.1' },
  exclusions: [],
}) as ExpectedInventory;

let override: ExpectedInventory | null = null;

/** Tests : référentiel substitué (null : référentiel du dépôt). */
export function __setExpectedInventoryForTests(v: ExpectedInventory | null): void { override = v; }

/** Référentiel en vigueur (substitut de test éventuel). */
export function currentExpectedInventory(): ExpectedInventory { return override ?? EXPECTED_INVENTORY; }

/** Référentiel VIDE (aucune exigence au-delà du verrou 100B) — tests d'autres sujets. */
export const EMPTY_INVENTORY_FOR_TESTS: ExpectedInventory = Object.freeze({
  version: 'test-vide', source: 'test', totals: { historical: 0, toRevalidate: 0, newScenarios: 0, stress: 0, pairs: 0 },
  perTreatment: Object.fromEntries(TREATMENTS.map((t) => [t, { difficulties: [], testTypes: [], minValidPairs: 0 }])) as unknown as ExpectedInventory['perTreatment'],
  requiredCases: [], requireAllCasesApproved: false, requireConclusiveResults: false, t2Completeness: { required: false, source: 'test' }, exclusions: [],
}) as ExpectedInventory;

/** Groupe d'inventaire d'une entrée (déclaré, sinon déduit de la provenance). */
export function inventoryGroupOf(e: Pick<ManifestEntry, 'provenance'> & { inventoryGroup?: InventoryGroup | null }): InventoryGroup | null {
  if (e.inventoryGroup) return e.inventoryGroup;
  if (e.provenance === 'HISTORIQUE_86') return 'HISTORIQUE';
  if (e.provenance === 'ZIP_601') return 'NOUVEAU';
  if (e.provenance === 'STRESS_601') return 'STRESS';
  return null;
}

/** Compteurs du manifeste rapprochés de l'inventaire attendu (purs). */
export function inventoryCounts(entries: readonly ManifestEntry[]): { historical: number; toRevalidate: number; newScenarios: number; stress: number; pairs: number } {
  const g = (k: InventoryGroup) => new Set(entries.filter((e) => inventoryGroupOf(e) === k).map((e) => e.id)).size;
  const paires = new Map<string, Set<string>>();
  for (const e of entries) if (e.pair) paires.set(e.pair.id, new Set([...(paires.get(e.pair.id) ?? []), e.pair.side]));
  return { historical: g('HISTORIQUE'), toRevalidate: g('A_REVALIDER'), newScenarios: g('NOUVEAU'), stress: g('STRESS'), pairs: [...paires.values()].filter((s) => s.has('A') && s.has('B')).length };
}

export const TOTAL_LABELS: Readonly<Record<keyof ExpectedInventory['totals'], string>> = {
  historical: 'cas historiques', toRevalidate: 'cas à revalider', newScenarios: 'scénarios nouveaux', stress: 'stress E2E distincts', pairs: 'paires A/B complètes',
};

/** Exigence évaluée (affichage BO, rapports, journal). */
export interface RequirementState { id: string; label: string; treatment: Treatment | null; met: boolean; waived: InventoryExclusion | null; detail: string }

/** Codes de blocage ajoutés par le référentiel (s'ajoutent à ceux du verrou 100B). */
export type InventoryBlockerCode =
  | 'INVENTORY_INCOMPLETE' | 'DIFFICULTY_NOT_COVERED' | 'TEST_TYPE_NOT_COVERED' | 'REQUIRED_CASE_MISSING'
  | 'CASE_NOT_APPROVED' | 'CASE_NOT_CONCLUSIVE' | 'PAIRS_MISSING' | 'T2_INCOMPLETE';

export interface InventoryBlocker { code: InventoryBlockerCode; operationCode: string | null; caseId: string | null; message: string; requirement: string; structural: boolean }

const QUALITE = (e: ManifestEntry) => e.testType === 'QUALITE_MODELE' || e.testType === 'PAIRE_ADVERSARIALE' || e.testType === 'NON_REGRESSION';

/**
 * Évalue le référentiel (pur). `results` : résultats de la candidate par identifiant du manifeste (null : matrice
 * seule). Rend les blocages (exigences non satisfaites et non exclues) et l'état de chaque exigence.
 * `structural` : manque qu'aucun nouvel appel modèle ne peut combler (import, approbation humaine) — une
 * candidate bloquée pour une telle cause n'est jamais relancée tant qu'il subsiste.
 */
export function assessInventory(p: {
  inventory: ExpectedInventory;
  treatments: readonly Treatment[];
  entries: readonly ManifestEntry[];
  statusOf: (e: ManifestEntry) => CaseStatus;
  operations: ReadonlyArray<{ operationCode: string; treatment: Treatment }>;
  results: ReadonlyMap<string, { outcome: string; inconclusiveReason?: string | null }> | null;
  t2: { verdict: 'SUFFISANTE' | 'INSUFFISANTE' | 'NON_MESUREE'; gaps: string[] } | null;
}): { blockers: InventoryBlocker[]; requirements: RequirementState[] } {
  const inv = p.inventory;
  const reqs: RequirementState[] = [];
  const blockers: InventoryBlocker[] = [];
  const waiver = (id: string) => inv.exclusions.find((x) => x.requirement === id) ?? null;
  const exiger = (r: Omit<RequirementState, 'waived'>, b: Omit<InventoryBlocker, 'requirement'> | null) => {
    const w = waiver(r.id);
    reqs.push({ ...r, waived: w });
    if (!r.met && !w && b) blockers.push({ ...b, requirement: r.id });
  };
  const opCodes = new Set(p.operations.map((o) => o.operationCode));
  const inScope = p.entries.filter((e) => e.operationCode && opCodes.has(e.operationCode));
  const approved = (e: ManifestEntry) => p.statusOf(e) === 'REFERENCE_APPROUVEE';

  // 1. Totaux du ZIP #601 (globaux : un corpus incomplet bloque TOUT traitement).
  const n = inventoryCounts(p.entries);
  for (const k of Object.keys(inv.totals) as Array<keyof ExpectedInventory['totals']>) {
    const attendu = inv.totals[k];
    if (attendu <= 0) continue;
    const met = n[k] >= attendu;
    exiger({ id: `totals.${k}`, label: `${attendu} ${TOTAL_LABELS[k]} (#601)`, treatment: null, met, detail: `${n[k]} au manifeste / ${attendu} attendus` },
      { code: 'INVENTORY_INCOMPLETE', operationCode: null, caseId: null, structural: true, message: `inventaire #601 incomplet : ${n[k]} ${TOTAL_LABELS[k]} au manifeste sur ${attendu} attendus` });
  }

  for (const t of p.treatments) {
    const conf = inv.perTreatment[t];
    const mine = inScope.filter((e) => e.treatment === t);
    // 2. Difficultés et types de test couverts par une référence approuvée.
    for (const d of conf?.difficulties ?? []) {
      const k = mine.filter((e) => e.difficulty === d && QUALITE(e) && approved(e)).length;
      exiger({ id: `difficulty.${t}.${d}`, label: `${t} · difficulté ${d}`, treatment: t, met: k > 0, detail: `${k} référence(s) approuvée(s)` },
        { code: 'DIFFICULTY_NOT_COVERED', operationCode: null, caseId: null, structural: true, message: `${t} · difficulté « ${d} » : aucune référence approuvée` });
    }
    for (const tt of conf?.testTypes ?? []) {
      const k = mine.filter((e) => e.testType === tt && approved(e)).length;
      exiger({ id: `testType.${t}.${tt}`, label: `${t} · type de test ${tt}`, treatment: t, met: k > 0, detail: `${k} référence(s) approuvée(s)` },
        { code: 'TEST_TYPE_NOT_COVERED', operationCode: null, caseId: null, structural: true, message: `${t} · type de test « ${tt} » : aucune référence approuvée` });
    }
    // 3. Paires dont les DEUX côtés sont approuvés (la validité d'exécution est jugée par le verrou 100B).
    if ((conf?.minValidPairs ?? 0) > 0) {
      const cotes = new Map<string, Set<string>>();
      for (const e of mine.filter((x) => x.pair && approved(x))) cotes.set(e.pair!.id, new Set([...(cotes.get(e.pair!.id) ?? []), e.pair!.side]));
      const k = [...cotes.values()].filter((s) => s.has('A') && s.has('B')).length;
      exiger({ id: `pairs.${t}`, label: `${t} · ${conf.minValidPairs} paire(s) A/B approuvée(s)`, treatment: t, met: k >= conf.minValidPairs, detail: `${k} paire(s) aux deux côtés approuvés` },
        { code: 'PAIRS_MISSING', operationCode: null, caseId: null, structural: true, message: `${t} : ${k} paire(s) A/B aux deux côtés approuvés sur ${conf.minValidPairs} exigée(s)` });
    }
    // 4. Cas nommés obligatoires.
    for (const rc of inv.requiredCases.filter((x) => x.treatment === t && opCodes.has(x.operationCode))) {
      const e = p.entries.find((x) => x.id === rc.id);
      const st = e ? p.statusOf(e) : null;
      const met = Boolean(e && e.critical && st !== 'REJETEE' && e.operationCode === rc.operationCode);
      exiger({ id: `case.${rc.id}`, label: `cas obligatoire ${rc.id}`, treatment: t, met, detail: e ? `${st}${e.critical ? '' : ', non critique'}` : 'absent du manifeste' },
        { code: 'REQUIRED_CASE_MISSING', operationCode: rc.operationCode, caseId: rc.id, structural: true, message: `cas obligatoire ${rc.id} (${rc.operationCode}) ${e ? (st === 'REJETEE' ? 'rejeté' : 'non critique ou mal rattaché') : 'absent du manifeste'} — ${rc.reason}` });
    }
  }

  // 5. Cas du périmètre non approuvés / approuvés non concluants (agrégés par opération, liste lisible).
  for (const op of p.operations.filter((o) => p.treatments.includes(o.treatment))) {
    const mine = inScope.filter((e) => e.operationCode === op.operationCode && QUALITE(e));
    if (inv.requireAllCasesApproved) {
      const nonApprouves = mine.filter((e) => p.statusOf(e) === 'A_COMPLETER');
      exiger({ id: `approval.${op.operationCode}`, label: `${op.operationCode} · tous les cas de qualité approuvés`, treatment: op.treatment, met: nonApprouves.length === 0, detail: `${nonApprouves.length} à compléter / ${mine.length}` },
        { code: 'CASE_NOT_APPROVED', operationCode: op.operationCode, caseId: nonApprouves[0]?.id ?? null, structural: true, message: `${op.operationCode} : ${nonApprouves.length} cas non approuvé(s) (${nonApprouves.slice(0, 3).map((e) => e.id).join(', ')}${nonApprouves.length > 3 ? ', …' : ''})` });
    }
    if (inv.requireConclusiveResults && p.results) {
      const manque = mine.filter((e) => approved(e) && !e.critical).filter((e) => {
        const r = p.results!.get(e.id);
        return !r || r.outcome === 'NOT_RUN' || r.outcome === 'INCONCLUSIVE';
      });
      exiger({ id: `results.${op.operationCode}`, label: `${op.operationCode} · cas approuvés exécutés et concluants`, treatment: op.treatment, met: manque.length === 0, detail: `${manque.length} non exécuté(s) ou non concluant(s)` },
        { code: 'CASE_NOT_CONCLUSIVE', operationCode: op.operationCode, caseId: manque[0]?.id ?? null, structural: false, message: `${op.operationCode} : ${manque.length} cas approuvé(s) non exécuté(s) ou non concluant(s) sur la candidate (${manque.slice(0, 3).map((e) => e.id).join(', ')})` });
    }
  }

  // 6. Complétude T2 (CDC 4 §35.3) dans la décision bloquante.
  if (inv.t2Completeness.required && p.treatments.includes('T2') && p.t2) {
    const met = p.t2.verdict === 'SUFFISANTE';
    exiger({ id: 't2.completeness', label: `T2 · complétude ${inv.t2Completeness.source}`, treatment: 'T2', met, detail: p.t2.verdict },
      { code: 'T2_INCOMPLETE', operationCode: null, caseId: null, structural: p.t2.verdict === 'INSUFFISANTE' && !p.results, message: `T2 · complétude CDC 4 §35 ${p.t2.verdict === 'NON_MESUREE' ? 'non mesurée' : 'insuffisante'} : ${p.t2.gaps.slice(0, 3).join(' ; ')}` });
  }
  return { blockers, requirements: reqs };
}

/** Identifiants des exigences (pour rédiger une exclusion exacte). */
export function requirementIds(inv: ExpectedInventory, ops: ReadonlyArray<{ operationCode: string; treatment: Treatment }>): string[] {
  return [
    ...Object.keys(inv.totals).map((k) => `totals.${k}`),
    ...TREATMENTS.flatMap((t) => [
      ...inv.perTreatment[t].difficulties.map((d) => `difficulty.${t}.${d}`),
      ...inv.perTreatment[t].testTypes.map((x) => `testType.${t}.${x}`),
      ...(inv.perTreatment[t].minValidPairs > 0 ? [`pairs.${t}`] : []),
    ]),
    ...inv.requiredCases.map((c) => `case.${c.id}`),
    ...ops.flatMap((o) => [`approval.${o.operationCode}`, `results.${o.operationCode}`]),
    't2.completeness',
  ];
}
