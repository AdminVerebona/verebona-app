/**
 * Lot 100B — RECLASSEMENT des fixtures historiques du corpus (ticket #601,
 * partie 1/5 : « 27 réponses utilisables, 20 gardes, 11 à corriger, 7
 * variantes de contrat, 21 non rejouables — vérifier chaque classement »).
 *
 * Le classement est CALCULÉ cas par cas, par des règles explicites et
 * vérifiables (jamais recopié de l'annonce) :
 *   1. rôle `guard` déclaré par l'équipe IA (sortie enregistrée délibérément
 *      fautive) → GARDE (GARDE_SERVEUR : reste en CI, jamais une référence de
 *      promotion) ;
 *   2. contrat de sortie remplacé par un contrat plus récent de la même
 *      branche, avec un cas jumeau au contrat courant → VARIANTE_CONTRAT
 *      (HISTORIQUE, lié à SA version : un test historique incompatible n'est
 *      pas un échec du modèle moderne) ;
 *   3. entrée réelle non reconstituable par les constructeurs de production,
 *      ou cas qui prétend tester un fichier (image, PDF, OCR) sans le fichier
 *      réel (« un nom de fichier seul ou une transcription fournie parfaite ne
 *      prouve pas l'analyse du document ») → NON_REJOUABLE (HISTORIQUE, jamais
 *      vert) ;
 *   4. réponse sans attendu, attendu contradictoire ou non étayé par le
 *      contexte du cas, identifiant dupliqué → À_CORRIGER (À_COMPLÉTER) ;
 *   5. sinon → RÉPONSE_UTILISABLE (À_COMPLÉTER : proposition d'oracle
 *      prête, approbation humaine INDIVIDUELLE requise).
 * Aucun cas n'est RÉFÉRENCE_APPROUVÉE sans approbation humaine.
 */
import { basename } from 'node:path';
import type { MasterCorpusCase } from '../cases';
import { amountsInText, datesInText, oracleFingerprint, toIsoDate } from './oracle';
import type { Difficulty, HistoricalClass, ManifestEntry, Oracle, OracleFact } from './model';

/** Fixtures ajoutées après la base lot 88 (les 86 historiques du ticket = base lot 88). */
export const ADDED_AFTER_LOT88 = new Set([
  'p-t3-18-naming-period-a-mensualite.json', 'p-t3-19-naming-period-b-plage.json', 'p-t3-20-naming-period-c-semestre.json',
  'p-t3-21-naming-period-d-mois-designe.json', 'p-t3-22-naming-period-e-serie.json', 'p-t3-23-naming-period-garde-dates.json',
  'p-t3-id-01-devis-mal-regroupe.json', 'p-t3-id-02-source-protegee.json', 'p-t3-kq-07-constituants-complets.json',
  'p-t3-kq-08-proprietes-manquantes-etablie.json', 'p-t3-kq-09-proprietes-manquantes-abstention.json',
  'p-t4-15-v4-representation-doublon.json', 'p-t4-16-v4-representation-reference-inventee.json',
]);

/**
 * Identifiants `case` dupliqués CORRIGÉS au lot 100B (deux fixtures
 * différentes portaient « T1-02 » : leurs observations se confondaient dans
 * le verdict d'un couple, regroupé par identifiant de cas).
 */
export const CASE_ID_CORRECTIONS: Readonly<Record<string, { from: string; to: string }>> = {
  't1-02-achat-piece.json': { from: 'T1-02', to: 'T1-02-ACHAT-PIECE' },
};

/** Contrat de sortie COURANT par branche (défaut du contrat d'exécution T4 : `t4_output_v3`, v4 pour AGENDA_REPRESENTATION). */
const CURRENT_CONTRACT: Readonly<Record<string, string>> = {
  CLASSIFY_EVENT: 't4_output_v3', VERIFY_COMPLETION: 't4_output_v3', TEMPORAL_AMBIGUITY: 't4_output_v3', AGENDA_REPRESENTATION: 't4_output_v4',
};

/** Famille de risque des cas connus (lecture des descriptions et attendus) ; défaut par opération. */
const RISK_BY_CASE: Readonly<Record<string, string>> = {
  'P-T1-01': 'T1_REGROUPEMENT', 'P-T1-02': 'T1_MULTIMODAL', 'P-T1-04': 'T1_RATTACHEMENT', 'T1-03': 'T1_MONTANTS', 'T1-02': 'T1_MONTANTS',
  'F-001 / F-028': 'T1_MONTANTS', 'F-093 (acompte)': 'T1_MONTANTS', 'F-092 / F-093 (solde)': 'T1_MONTANTS', 'F-105': 'T1_MONTANTS', 'F-010': 'T1_CLASSEMENT',
  'P-T2-02': 'T2_CORRECTIONS_UTILISATEUR', 'P-T2-08': 'T2_ABSTENTION_INJUSTIFIEE', 'P-T2-09': 'T2_SOURCES_VERIFIEES', 'P-T2-03': 'T2_SOURCES_VERIFIEES',
  'P-T3-01': 'T3_CORRECTIONS_PRESERVEES', 'P-T3-08': 'T3_IDENTITE_ECONOMIQUE', 'P-T3-09': 'T3_DOUBLE_COMPTE', 'P-T3-12': 'T3_IDENTITE_ECONOMIQUE',
  'P-T3-13': 'T3_IDENTITE_ECONOMIQUE', 'P-T3-ID-01': 'T3_DOUBLE_COMPTE', 'P-T3-ID-02': 'T3_CORRECTIONS_PRESERVEES',
  'P-T4-01': 'T4_ECHEANCE', 'P-T4-02': 'T4_PREUVE_OCCURRENCE', 'P-T4-03': 'T4_PREUVE_OCCURRENCE', 'P-T4-04': 'T4_ECHEANCE', 'P-T4-05': 'T4_ECHEANCE',
  'P-T4-06': 'T4_PERIODE', 'P-T4-07': 'T4_RECONDUCTION', 'P-T4-V3-07': 'T4_RECONDUCTION', 'P-T4-08': 'T4_PERIODE', 'P-T4-V3-08': 'T4_PERIODE',
  'P-T4-09': 'T4_RECONDUCTION', 'P-T4-V3-09': 'T4_RECONDUCTION', 'P-T4-10': 'T4_RECONDUCTION', 'P-T4-V3-10': 'T4_RECONDUCTION',
  'P-T4-11': 'T4_FIN_REELLE', 'P-T4-V3-11': 'T4_FIN_REELLE', 'P-T4-12': 'T4_ECHEANCE', 'P-T4-V3-12': 'T4_ECHEANCE',
  'P-T4-V3-13': 'T4_ECHEANCE', 'P-T4-V3-14': 'T4_ECHEANCE', 'P-T4-V4-15': 'T4_PERIODE', 'P-T4-V4-16': 'T4_PERIODE',
  'P-T6-01': 'T6_INFORMATION_UTILE', 'P-T6-EV-01': 'T6_ACTION_UTILE', 'P-T6-EV-03': 'T6_SOLLICITATION_INUTILE', 'P-T6-EV-04': 'T6_INFORMATION_UTILE',
};
const RISK_BY_OPERATION: Readonly<Record<string, string>> = {
  t1_group_upload: 'T1_REGROUPEMENT', t1_analyze_document: 'T1_FAITS_PREUVES',
  t2_understand: 'T2_INTENTION', t2_answer: 'T2_SOURCES_VERIFIEES', t2_revalidate: 'T2_REVALIDATION',
  t3_value_conflict: 'T3_CORRECTIONS_PRESERVEES', t3_link_ambiguity: 'T3_RATTACHEMENT', t3_operation_match: 'T3_IDENTITE_ECONOMIQUE',
  t3_document_naming: 'T3_NOMMAGE', t3_knowledge_query: 'T3_CONNAISSANCE', t3_operation_identity: 'T3_DOUBLE_COMPTE',
  t4_classify_event: 'T4_ECHEANCE', t4_verify_completion: 'T4_PREUVE_OCCURRENCE', t4_temporal_ambiguity: 'T4_ECHEANCE', t4_agenda_representation: 'T4_PERIODE',
  t6_formulate: 'T6_INFORMATION_UTILE', t6_evaluate: 'T6_ACTION_UTILE',
};

const TREATMENT_OF = (op: string) => (op.startsWith('t1_') ? 'T1' : op.startsWith('t2_') ? 'T2' : op.startsWith('t3_') ? 'T3' : op.startsWith('t4_') ? 'T4' : 'T6') as ManifestEntry['treatment'];

/** Identifiant immuable d'une fixture historique : nom du fichier (unique), jamais l'identifiant `case` (dupliqué). */
export function historicalId(file: string): string {
  return `H-${basename(file, '.json').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

export interface HistoricalFacts {
  /** Variables réelles constructibles par le constructeur de production (`liveVariablesFor`). */
  replayable: boolean;
  /** Autres fichiers portant le même identifiant `case`. */
  duplicates: string[];
  /** Identifiants `case` des cas du corpus (jumeaux de contrat). */
  allCaseIds: ReadonlySet<string>;
}

/** Le cas prétend tester un fichier (image / PDF) que le corpus ne fournit pas. */
export function claimsFileWithoutPiece(c: Pick<MasterCorpusCase, 'context' | 'operationCode'>): boolean {
  const x = c.context as { mimeTypes?: string[]; displayNames?: string[]; attachments?: unknown[] };
  if (!c.operationCode.startsWith('t1_')) return false;
  const fichiers = (x.mimeTypes ?? []).some((m) => /^image\/|pdf/.test(m)) || (x.displayNames ?? []).some((n) => /\.(jpe?g|png|heic|pdf|webp)$/i.test(n));
  return fichiers && !(Array.isArray(x.attachments) && x.attachments.length > 0);
}

/** Attendu contradictoire : une valeur à la fois attendue et interdite. */
export function expectedContradictions(expected: Record<string, unknown> | null): string[] {
  if (!expected) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(expected)) {
    const m = /^never([A-Z].*?)s?$/.exec(k);
    if (!m) continue;
    const cible = m[1].charAt(0).toLowerCase() + m[1].slice(1);
    const attendu = expected[cible];
    const interdits = Array.isArray(v) ? v : [v];
    if (attendu !== undefined && interdits.some((x) => JSON.stringify(x) === JSON.stringify(attendu))) out.push(`${cible} = ${JSON.stringify(attendu)} à la fois attendu et interdit (${k})`);
  }
  return out;
}

/** Montants et dates de l'attendu absents du contexte du cas (attendu non étayé par ses sources). */
export function unsupportedExpected(c: Pick<MasterCorpusCase, 'context' | 'expected'>): string[] {
  if (!c.expected) return [];
  const ctx = JSON.stringify(c.context ?? {});
  const montantsCtx = new Set(amountsInText(ctx).map(String));
  const nombresCtx = new Set((ctx.match(/-?\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n))));
  const datesCtx = new Set([...datesInText(ctx), ...(ctx.match(/\d{4}-\d{2}-\d{2}/g) ?? [])]);
  const out: string[] = [];
  const visit = (v: unknown, path: string) => {
    if (typeof v === 'string') {
      for (const a of amountsInText(v)) if (!montantsCtx.has(String(a)) && !nombresCtx.has(String(a)) && !nombresCtx.has(String(Math.round(a * 100)))) out.push(`${path} : montant ${a} € absent des sources du cas`);
      const iso = toIsoDate(v);
      if (iso && !datesCtx.has(iso)) out.push(`${path} : date ${iso} absente des sources du cas`);
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => visit(x, `${path}[${i}]`)); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, path ? `${path}.${k}` : k);
  };
  // Les textes INTERDITS (`answerNotContains`, `forbidden…`) n'ont pas à figurer dans les sources.
  visit(Object.fromEntries(Object.entries(c.expected).filter(([k]) => !/^(never|forbidden|answerNotContains)/.test(k))), '');
  return out;
}

/**
 * Proposition d'ORACLE depuis l'attendu existant (rédigé contre le contexte
 * du cas) : l'attendu serveur est repris tel quel, les valeurs observables
 * deviennent des faits ; preuves = contexte du cas. Une PROPOSITION : elle
 * n'est jamais approuvée sans relecture humaine sur les sources.
 */
export function proposeOracle(c: Pick<MasterCorpusCase, 'id' | 'operationCode' | 'context' | 'expected' | 'file'>): Oracle | null {
  const e = c.expected;
  if (!e || !Object.keys(e).length) return null;
  const preuve = [{ source: `contexte du cas (${basename(c.file)})`, excerpt: null }];
  const facts: OracleFact[] = [];
  const absent: Oracle['absentFacts'] = [];
  const ctx = c.context as { sources?: Array<{ id?: string }> };
  if (typeof e.answerContains === 'string') {
    const montants = amountsInText(e.answerContains);
    facts.push(montants.length === 1
      ? { key: 'reponse_montant', kind: 'AMOUNT', value: montants[0], unit: 'EUR', critical: true, evidenceRequired: false, evidence: preuve }
      : { key: 'reponse_texte', kind: 'TEXT', value: e.answerContains, critical: true, evidenceRequired: false, evidence: preuve });
  }
  for (const x of (Array.isArray(e.answerNotContains) ? e.answerNotContains : []) as string[]) absent.push({ key: `interdit_${absent.length + 1}`, kind: 'TEXT', value: x, reason: 'jamais affiché (attendu du cas)' });
  if (typeof e.chosenDate === 'string') facts.push({ key: 'date_retenue', kind: 'DATE', value: e.chosenDate, critical: true, evidenceRequired: false, evidence: preuve });
  if (e.values && typeof e.values === 'object') {
    for (const [k, v] of Object.entries(e.values as Record<string, unknown>)) facts.push({ key: k, kind: 'TEXT', value: String(v), critical: true, evidenceRequired: false, evidence: preuve });
  }
  return {
    version: 1, requiredFacts: facts, absentFacts: absent, entities: { expected: [], forbidden: [] }, decisions: { allowed: [], forbidden: [] },
    abstention: { expected: 'EITHER', criteria: null },
    allowedSources: c.operationCode === 't2_answer' ? (ctx.sources ?? []).map((s) => String(s.id ?? '')).filter(Boolean) : [],
    equivalences: [], amountTolerance: 0, serverExpected: e,
    notes: 'Proposition générée au lot 100B depuis l’attendu historique du cas : à relire sur les sources (contexte du cas, pièces), jamais sur une sortie de modèle.',
  };
}

function difficultyOf(c: Pick<MasterCorpusCase, 'description'>): Difficulty {
  return /ambigu|abstention|contradict|aucune information|hors (monde|contexte)|inventé|garde/i.test(c.description) ? 'DIFFICILE' : /plusieurs|deux|multi|série|famille|cumul/i.test(c.description) ? 'INTERMEDIAIRE' : 'SIMPLE';
}

/** Classement d'une fixture historique (pur). */
export function classifyHistoricalCase(c: MasterCorpusCase, f: HistoricalFacts): { cls: HistoricalClass; status: ManifestEntry['status']; reason: string; critical: boolean; inputMode: ManifestEntry['inputMode'] } {
  const fichier = claimsFileWithoutPiece(c);
  const inputMode: ManifestEntry['inputMode'] = fichier ? 'FILE' : c.operationCode.startsWith('t1_') ? 'TEXT' : 'STRUCTURED';
  const dup = f.duplicates.length ? ` ; identifiant « ${c.id} » dupliqué (${f.duplicates.map((x) => basename(x)).join(', ')}) : identifiant immuable du manifeste attribué` : '';
  if (c.qualificationRole === 'guard') {
    return { cls: 'GARDE', status: 'GARDE_SERVEUR', reason: `garde serveur : sortie enregistrée délibérément fautive, contrôle de la réaction du serveur (reste en CI, jamais une référence de promotion)${dup}`, critical: false, inputMode };
  }
  const courant = CURRENT_CONTRACT[c.task];
  if (c.outputContract && courant && c.outputContract !== courant) {
    const jumeau = c.id.replace(/^P-T4-(\d+)$/, 'P-T4-V3-$1');
    if (jumeau !== c.id && f.allCaseIds.has(jumeau)) {
      return { cls: 'VARIANTE_CONTRAT', status: 'HISTORIQUE', reason: `variante de contrat : lié à ${c.outputContract} (contrat courant ${courant}) ; même scénario couvert par ${jumeau} — un écart sur ce contrat historique n’est pas un échec du modèle moderne${dup}`, critical: false, inputMode };
    }
  }
  if (!f.replayable || fichier) {
    const motif = fichier
      ? 'le cas prétend analyser un fichier (image / PDF) mais le corpus ne fournit que son nom ou une transcription : fichier réel requis pour être rejoué'
      : 'entrée réelle non reconstituable par les constructeurs de production (pièce jointe ou contexte incomplet)';
    const sansAttendu = c.qualificationRole === 'answer' && (!c.expected || !Object.keys(c.expected).length) ? ' ; de plus, réponse sans attendu : oracle à rédiger' : '';
    return { cls: 'NON_REJOUABLE', status: 'HISTORIQUE', reason: `non rejouable : ${motif} — jamais compté vert${sansAttendu}${dup}`, critical: false, inputMode };
  }
  const aCorriger: string[] = [];
  if (!c.expected || !Object.keys(c.expected).length) aCorriger.push('réponse de référence sans attendu : oracle à rédiger depuis les sources');
  aCorriger.push(...expectedContradictions(c.expected));
  aCorriger.push(...unsupportedExpected(c).map((x) => `attendu non étayé — ${x}`));
  if (f.duplicates.length) aCorriger.push(`identifiant « ${c.id} » dupliqué (${f.duplicates.map((x) => basename(x)).join(', ')})`);
  if (aCorriger.length) return { cls: 'A_CORRIGER', status: 'A_COMPLETER', reason: `à corriger : ${aCorriger.join(' ; ')}`, critical: true, inputMode };
  return { cls: 'REPONSE_UTILISABLE', status: 'A_COMPLETER', reason: 'réponse potentiellement utilisable : proposition d’oracle prête, approbation humaine individuelle requise (sources du cas)', critical: true, inputMode };
}

/** Entrée de manifeste d'une fixture historique (pure). */
export function historicalEntry(c: MasterCorpusCase, f: HistoricalFacts, at: string): ManifestEntry {
  const k = classifyHistoricalCase(c, f);
  const file = basename(c.file);
  const corr = CASE_ID_CORRECTIONS[file];
  if (corr) k.reason = `${k.reason} ; identifiant dupliqué corrigé : « ${corr.from} » → « ${corr.to} »`;
  const oracle = k.cls === 'REPONSE_UTILISABLE' || k.cls === 'A_CORRIGER' ? proposeOracle(c) : null;
  return {
    id: historicalId(c.file), sourceCaseId: c.id, file: c.file.replace(/\\/g, '/'), operationCode: c.operationCode, treatment: TREATMENT_OF(c.operationCode),
    contract: c.outputContract ?? null, schema: c.outputSchema,
    riskFamily: k.inputMode === 'FILE' ? 'T1_MULTIMODAL' : RISK_BY_CASE[c.id] ?? RISK_BY_OPERATION[c.operationCode] ?? null,
    difficulty: difficultyOf(c), critical: k.critical, pair: null,
    provenance: ADDED_AFTER_LOT88.has(file) ? 'AJOUT_LOTS_97_99' : 'HISTORIQUE_86', sourcePieces: [], inputMode: k.inputMode,
    testType: k.cls === 'GARDE' ? 'GARDE_SERVEUR' : 'QUALITE_MODELE', evaluationType: k.cls === 'GARDE' ? 'GARDE_SERVEUR' : 'ORACLE',
    status: k.status, reason: k.reason, historicalClass: k.cls,
    cdc35Category: null, oracle, expectedSummary: c.expected ? JSON.stringify(c.expected).slice(0, 2000) : null,
    revisions: [{ revision: 1, at, by: 'lot100b', reason: `reclassement initial (${k.cls}) : ${c.description.slice(0, 300)}`, changes: ['*'], oracleFingerprint: oracleFingerprint(oracle) }],
  };
}

/** Cas de référence T1 du harnais historique (documents anonymisés HTML) : entrée À_COMPLÉTER avec proposition d'oracle. */
export function t1ReferenceEntry(c: { caseId: string; category: string; fixturePath: string; expected: { documentType?: string; fields?: Record<string, unknown>; assetRefs?: string[] } }, at: string): ManifestEntry {
  const source = `src/services/ai/governance/corpus/fixtures/${c.fixturePath}`;
  const preuve = [{ source, excerpt: null }];
  const facts: OracleFact[] = Object.entries(c.expected.fields ?? {}).map(([k, v]) => {
    const kind: OracleFact['kind'] = typeof v === 'number' ? (/prix|montant|prime|loyer|cout|coût|total|mensualit/i.test(k) ? 'AMOUNT' : 'NUMBER') : typeof v === 'string' && toIsoDate(v) ? 'DATE' : typeof v === 'boolean' ? 'BOOLEAN' : 'TEXT';
    return { key: k, kind, value: v as string | number | boolean | null, unit: kind === 'AMOUNT' ? 'EUR' : null, critical: true, evidenceRequired: kind === 'AMOUNT' || kind === 'DATE', evidence: preuve };
  });
  const oracle: Oracle = {
    version: 1, requiredFacts: facts, absentFacts: [], entities: { expected: [], forbidden: [] },
    decisions: { allowed: c.expected.documentType ? [c.expected.documentType] : [], forbidden: [] }, abstention: { expected: facts.length ? 'ANSWER' : 'EITHER', criteria: null },
    allowedSources: [], equivalences: [], amountTolerance: 0, serverExpected: null,
    notes: 'Proposition générée au lot 100B depuis les attendus du harnais T1 historique (cas consultatifs) : à relire sur le document source.',
  };
  return {
    id: `R-T1-${c.caseId.toUpperCase().replace(/[^A-Z0-9]+/g, '-')}`, sourceCaseId: c.caseId, file: null, operationCode: 't1_analyze_document', treatment: 'T1',
    contract: null, schema: 'T1AnalyzeDocumentOutput', riskFamily: facts.some((f) => f.kind === 'AMOUNT') ? 'T1_MONTANTS' : 'T1_FAITS_PREUVES', difficulty: c.category === 'document_contradictoire' ? 'DIFFICILE' : 'SIMPLE',
    critical: false, pair: null, provenance: 'REFERENCE_T1', sourcePieces: [{ path: source, mimeType: 'text/html', sha256: null }], inputMode: 'TEXT',
    testType: 'QUALITE_MODELE', evaluationType: 'ORACLE', status: 'A_COMPLETER',
    reason: 'cas de référence T1 consultatif (harnais historique absorbé au lot 86A) : attendus non validés, proposition d’oracle à approuver sur le document',
    historicalClass: null, cdc35Category: null, oracle, expectedSummary: JSON.stringify(c.expected).slice(0, 2000),
    revisions: [{ revision: 1, at, by: 'lot100b', reason: `inventaire initial (catégorie ${c.category})`, changes: ['*'], oracleFingerprint: oracleFingerprint(oracle) }],
  };
}
