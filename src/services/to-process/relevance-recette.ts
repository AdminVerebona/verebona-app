/**
 * Recette de la pertinence « À traiter » avec le VÉRITABLE T4 — lot 61
 * (ticket « BUG P1 — écarts résiduels du lot 58B », écart 8 : « tests T4
 * principalement simulés » ; ticket « pertinence », §7 cas de référence).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN CORPUS LIVRÉ, LANCÉ DEPUIS LE BO, SANS SQL
 *
 * `RELEVANCE_RECETTE_CASES` : contrats actifs, expirés, résiliés,
 * reconductibles, prêts (début + durée, simple date d'édition), anciens
 * contrats sans date, échéances futures proches / lointaines, date du seul
 * titre, période de facturation (U7), obligation de restitution. Dates
 * RELATIVES au jour du lancement : le corpus reste valable dans le temps.
 *
 * Chaque cas passe par la MÊME décision que la production
 * (`assessDeadlinePertinence`, `computeDerivation`) avec la configuration IA
 * ACTIVE de l'environnement (version T4 du BO) : les cas déterministes ne
 * consomment aucun appel ; les autres appellent réellement T4 (coût imputé
 * au compte de l'administrateur, hors plafond). Résultat attendu / obtenu par
 * cas, trace IA, enregistrés (0446) et affichés au BO (File d'attente IA ›
 * Pertinence « À traiter » › « Lancer la recette T4 réelle »).
 *
 * Les attentes IA admettent plusieurs issues PRUDENTES quand le métier le
 * permet (ex. reconduction : action maintenant OU différée), et listent ce
 * qui est INTERDIT (ex. jamais NO_ACTION sur le seul titre, jamais une
 * question de date pour une obligation réelle).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import {
  assessDeadlinePertinence, assessKnownDeadlineObligation, DOCUMENT_RULE_ENGINE_VERSION, lifecycleSignalsOf, t4AssessmentConfig, todayParis, withThresholds,
  type PertinenceCandidate, type PertinenceResult, type RelevanceOutcome, type T4AssessmentConfig,
} from './document-field-evidence';
import { computeDerivation, derivationFor } from './document-derivations';
import { getRule } from './rules-catalog';
import { DEFAULT_TO_PROCESS_THRESHOLDS } from './relevance-thresholds';

interface RecetteCase {
  id: string;
  label: string;
  rule: 'DATA-CONTRACT-END' | 'DATA-WARRANTY-END';
  documentType: string;
  title: string;
  /** Dates candidates de l'échéance (décalage en jours par rapport au jour du lancement). */
  candidates?: Array<{ days: number; source: string; excerpt?: string }>;
  /** Autres dates fiables du document. */
  contextDates?: Array<{ key: string; days: number }>;
  /** Calcul déterministe : début effectif (décalage) et durée lue. */
  derivation?: { startDays: number | null; duration: string | null; certain: boolean };
  /** Lot 72 (C2) : signaux de cycle de vie lus dans le document (reconduction, fin effective, obligation résiduelle). */
  lifecycle?: { renewal: boolean; terminated: boolean; residual: boolean };
  /**
   * Lot 75I (A) : date DÉJÀ CONNUE (décalage en jours) — seule l'obligation
   * est évaluée (`assessKnownDeadlineObligation`), jamais une question de date.
   */
  known?: { days: number; source?: string };
  /** Lot 75I (A) : clauses lues ailleurs que dans l'extrait de la date (signaux de cycle de vie déduits). */
  clauses?: string[];
  /** Lot 75I (D) : configuration T4 incompatible IMPOSÉE (cas déterministe : aucune action arbitraire). */
  forceIncompatible?: boolean;
  expected: {
    outcomes: Array<RelevanceOutcome | 'AUTO_RESOLVED'>;
    card?: 'INTERVENTION' | 'DATA_QUESTION' | null;
    kinds?: string[];
    never?: Array<RelevanceOutcome | 'DATA_QUESTION'>;
    derivation?: 'CALCULATED_RELIABLE' | 'CALCULATED_PROBABLE' | 'NOT_DERIVABLE' | 'AMBIGUOUS';
  };
  /** Aucun appel IA attendu (décision du code). */
  deterministic: boolean;
}

export const RELEVANCE_RECETTE_CASES: readonly RecetteCase[] = [
  {
    id: 'ATR-REC-01', label: 'Prêt immobilier : début effectif + durée fiables → échéance théorique calculée, sans carte',
    rule: 'DATA-CONTRACT-END', documentType: 'FINANCING_CONTRACT', title: 'Offre de prêt immobilier',
    derivation: { startDays: -800, duration: '240 mois', certain: true },
    expected: { outcomes: ['AUTO_RESOLVED'], derivation: 'CALCULATED_RELIABLE' }, deterministic: true,
  },
  {
    id: 'ATR-REC-02', label: 'Prêt avec simple date d’édition : aucune date de début supposée',
    rule: 'DATA-CONTRACT-END', documentType: 'FINANCING_CONTRACT', title: 'Offre de prêt — édition',
    derivation: { startDays: null, duration: '20 ans', certain: true },
    expected: { outcomes: ['AUTO_RESOLVED', 'CREATE_ACTION', 'DEFER', 'NO_ACTION'], derivation: 'NOT_DERIVABLE', never: ['AUTO_RESOLVED'] }, deterministic: true,
  },
  {
    // Lot 72 (C2) : l'ancienneté n'est qu'un indice — décision différée, jamais « sans enjeu ».
    id: 'ATR-REC-03', label: 'Ancien contrat sans date de fin, rien de probant → pas de carte, décision différée (jamais « sans enjeu » sur l’âge)',
    rule: 'DATA-CONTRACT-END', documentType: 'SERVICE_CONTRACT', title: 'Contrat d’entretien chaudière',
    contextDates: [{ key: 'documentDate', days: -3400 }, { key: 'contractStartDate', days: -3400 }],
    expected: { outcomes: ['DEFER'], never: ['NO_ACTION', 'CREATE_ACTION'] }, deterministic: true,
  },
  {
    id: 'ATR-REC-04', label: 'Échéance future lointaine → interpellation différée',
    rule: 'DATA-CONTRACT-END', documentType: 'SERVICE_CONTRACT', title: 'Contrat de maintenance',
    candidates: [{ days: 420, source: 'SOURCE_UNITS' }, { days: 450, source: 'FACTS' }],
    expected: { outcomes: ['DEFER'] }, deterministic: true,
  },
  {
    id: 'ATR-REC-05', label: 'Échéance future proche, date incertaine → question utile maintenant',
    rule: 'DATA-CONTRACT-END', documentType: 'SERVICE_CONTRACT', title: 'Contrat de maintenance',
    candidates: [{ days: 40, source: 'SOURCE_UNITS' }],
    expected: { outcomes: ['CREATE_ACTION'], card: 'DATA_QUESTION' }, deterministic: true,
  },
  {
    id: 'ATR-REC-06', label: 'Contrat expiré sans reconduction → aucune intervention',
    rule: 'DATA-CONTRACT-END', documentType: 'SERVICE_CONTRACT', title: 'Contrat de location de matériel',
    candidates: [{ days: -400, source: 'FACTS', excerpt: 'Le présent contrat a pris fin à son terme, sans reconduction. Aucune somme ni démarche ne reste due.' }],
    expected: { outcomes: ['NO_ACTION'], never: ['DATA_QUESTION', 'CREATE_ACTION'] }, deterministic: false,
  },
  {
    id: 'ATR-REC-07', label: 'Contrat résilié (résiliation effective) → aucune intervention',
    rule: 'DATA-CONTRACT-END', documentType: 'SUBSCRIPTION_CONTRACT', title: 'Confirmation de résiliation',
    candidates: [{ days: -90, source: 'FACTS', excerpt: 'Nous vous confirmons la résiliation de votre contrat, effective à cette date. Votre dossier est soldé.' }],
    expected: { outcomes: ['NO_ACTION'], never: ['DATA_QUESTION', 'CREATE_ACTION'] }, deterministic: false,
  },
  {
    id: 'ATR-REC-08', label: 'Contrat reconductible tacitement : décision à prendre (jamais une question de date)',
    rule: 'DATA-CONTRACT-END', documentType: 'MAINTENANCE_CONTRACT', title: 'Contrat d’entretien annuel — reconduction tacite',
    candidates: [{ days: -20, source: 'FACTS', excerpt: 'Le contrat est reconduit tacitement par périodes d’un an, sauf résiliation par lettre recommandée deux mois avant l’échéance.' }],
    expected: { outcomes: ['CREATE_ACTION', 'DEFER'], never: ['DATA_QUESTION', 'NO_ACTION'] }, deterministic: false,
  },
  {
    id: 'ATR-REC-09', label: 'Obligation réelle après l’échéance (restitution du matériel) → carte décrivant l’obligation',
    rule: 'DATA-CONTRACT-END', documentType: 'SERVICE_CONTRACT', title: 'Contrat de location — box',
    candidates: [{ days: -10, source: 'FACTS', excerpt: 'À la fin du contrat, le locataire doit restituer le matériel loué dans un délai de 30 jours, à défaut de quoi il sera facturé.' }],
    expected: { outcomes: ['CREATE_ACTION'], card: 'INTERVENTION', kinds: ['RETURN_OR_RESTITUTE', 'PERFORM_OBLIGATION'], never: ['DATA_QUESTION'] }, deterministic: false,
  },
  {
    id: 'ATR-REC-10', label: 'Garantie expirée → aucune intervention',
    rule: 'DATA-WARRANTY-END', documentType: 'WARRANTY_CERTIFICATE', title: 'Certificat de garantie',
    candidates: [{ days: -200, source: 'FACTS', excerpt: 'Garantie constructeur de 2 ans à compter de la date d’achat.' }],
    expected: { outcomes: ['NO_ACTION'], never: ['DATA_QUESTION'] }, deterministic: false,
  },
  {
    id: 'ATR-REC-11', label: 'Échéance suggérée par le seul titre → jamais « aucune intervention » sur ce seul indice',
    rule: 'DATA-CONTRACT-END', documentType: 'SERVICE_CONTRACT', title: 'Votre contrat arrive à échéance',
    candidates: [{ days: -117, source: 'TITLE_ONLY', excerpt: 'Votre contrat arrive à échéance' }],
    expected: { outcomes: ['DEFER', 'CREATE_ACTION'], never: ['NO_ACTION'] }, deterministic: false,
  },
  {
    id: 'ATR-REC-12', label: 'Fin de période de facturation (U7) → pas une fin de contrat, aucune intervention',
    rule: 'DATA-CONTRACT-END', documentType: 'SUBSCRIPTION_CONTRACT', title: 'Facture internet — période mensuelle',
    candidates: [{ days: -15, source: 'SOURCE_UNITS', excerpt: 'Période de facturation du 08/08 au 07/09. Abonnement mensuel sans engagement.' }],
    expected: { outcomes: ['NO_ACTION', 'DEFER'], never: ['DATA_QUESTION', 'CREATE_ACTION'] }, deterministic: false,
  },
  {
    id: 'ATR-REC-13', label: 'Contrat actif récent sans date de fin : question seulement si utile',
    rule: 'DATA-CONTRACT-END', documentType: 'SUBSCRIPTION_CONTRACT', title: 'Contrat de télésurveillance — engagement 36 mois',
    contextDates: [{ key: 'contractStartDate', days: -60 }],
    expected: { outcomes: ['CREATE_ACTION', 'DEFER', 'NO_ACTION'], never: [] }, deterministic: false,
  },
  // ── Lot 72 (C1, C2) : calculs composites, contrats anciens ────────────────
  {
    id: 'ATR-REC-14', label: 'Contrat signé il y a six ans, reconductible tacitement, sans date de fin → jamais « sans enjeu » sur l’âge',
    rule: 'DATA-CONTRACT-END', documentType: 'MAINTENANCE_CONTRACT', title: 'Contrat d’entretien — reconduction tacite annuelle',
    contextDates: [{ key: 'contractStartDate', days: -2200 }], lifecycle: { renewal: true, terminated: false, residual: false },
    expected: { outcomes: ['CREATE_ACTION', 'DEFER'], never: ['NO_ACTION'] }, deterministic: false,
  },
  {
    id: 'ATR-REC-15', label: 'Contrat ancien dont la fin effective est prouvée (résilié, sans obligation) → aucune carte',
    rule: 'DATA-CONTRACT-END', documentType: 'SUBSCRIPTION_CONTRACT', title: 'Abonnement résilié',
    contextDates: [{ key: 'contractStartDate', days: -3000 }], lifecycle: { renewal: false, terminated: true, residual: false },
    expected: { outcomes: ['NO_ACTION'], never: ['CREATE_ACTION'] }, deterministic: true,
  },
  {
    id: 'ATR-REC-16', label: 'Prêt de 240 mois « dont 12 mois de différé » → 240 mois (jamais 252)',
    rule: 'DATA-CONTRACT-END', documentType: 'FINANCING_CONTRACT', title: 'Offre de prêt avec différé',
    derivation: { startDays: -400, duration: '240 mois, dont 12 mois de différé', certain: true },
    expected: { outcomes: ['AUTO_RESOLVED'], derivation: 'CALCULATED_RELIABLE' }, deterministic: true,
  },
  {
    id: 'ATR-REC-17', label: 'Location de 12 mois renouvelable pour 12 mois → aucune durée de 24 mois, aucun calcul fiable',
    rule: 'DATA-CONTRACT-END', documentType: 'SERVICE_CONTRACT', title: 'Contrat de location de matériel',
    derivation: { startDays: -100, duration: '12 mois renouvelables pour 12 mois', certain: true },
    expected: { outcomes: [], derivation: 'CALCULATED_PROBABLE', never: ['AUTO_RESOLVED'] }, deterministic: true,
  },
  {
    id: 'ATR-REC-18', label: 'Abonnement « 36 ou 48 mois » (durée composite ambiguë) → aucun calcul',
    rule: 'DATA-CONTRACT-END', documentType: 'SUBSCRIPTION_CONTRACT', title: 'Contrat d’abonnement',
    derivation: { startDays: -30, duration: '36 ou 48 mois', certain: true },
    expected: { outcomes: [], derivation: 'AMBIGUOUS', never: ['AUTO_RESOLVED'] }, deterministic: true,
  },
  // ── Lot 75I (A, D) : date CONNUE — obligation évaluée ; contrat T4 incompatible ──
  {
    id: 'ATR-REC-19', label: 'Date de fin passée CONNUE + clause de restitution (hors extrait de la date) → carte décrivant l’obligation, aucune question de date',
    rule: 'DATA-CONTRACT-END', documentType: 'SERVICE_CONTRACT', title: 'Contrat de location — box internet',
    known: { days: -40 }, clauses: ['À la fin du contrat, le locataire doit restituer le matériel loué dans un délai de 30 jours, à défaut de quoi il sera facturé.'],
    expected: { outcomes: ['CREATE_ACTION'], card: 'INTERVENTION', kinds: ['RETURN_OR_RESTITUTE', 'PERFORM_OBLIGATION'], never: ['DATA_QUESTION', 'NO_ACTION'] }, deterministic: false,
  },
  {
    id: 'ATR-REC-20', label: 'Date de fin de garantie passée CONNUE, sans obligation → aucune carte, donnée conservée',
    rule: 'DATA-WARRANTY-END', documentType: 'WARRANTY_CERTIFICATE', title: 'Certificat de garantie constructeur',
    known: { days: -100 }, clauses: ['Garantie constructeur de 2 ans à compter de la date d’achat. Les frais de port du retour sont à la charge du client.'],
    expected: { outcomes: ['NO_ACTION', 'DEFER'], never: ['DATA_QUESTION', 'CREATE_ACTION'] }, deterministic: false,
  },
  {
    id: 'ATR-REC-21', label: 'Date de fin CONNUE lointaine → décision différée à l’approche, sans IA',
    rule: 'DATA-CONTRACT-END', documentType: 'SERVICE_CONTRACT', title: 'Contrat de maintenance',
    known: { days: 400 },
    expected: { outcomes: ['DEFER'], never: ['DATA_QUESTION', 'CREATE_ACTION'] }, deterministic: true,
  },
  {
    id: 'ATR-REC-22', label: 'Date de fin CONNUE proche, reconduction tacite avec préavis → décision à prendre (jamais une question de date)',
    rule: 'DATA-CONTRACT-END', documentType: 'MAINTENANCE_CONTRACT', title: 'Contrat d’entretien annuel',
    known: { days: 50 }, clauses: ['Le contrat est reconduit tacitement par périodes d’un an, sauf résiliation par lettre recommandée deux mois avant l’échéance.'],
    expected: { outcomes: ['CREATE_ACTION', 'DEFER'], card: 'INTERVENTION', never: ['DATA_QUESTION', 'NO_ACTION'] }, deterministic: false,
  },
  {
    id: 'ATR-REC-23', label: 'Date inconnue, contrat T4 incompatible (imposé) → aucune question par défaut, incompatibilité signalée',
    rule: 'DATA-CONTRACT-END', documentType: 'SUBSCRIPTION_CONTRACT', title: 'Contrat de télésurveillance',
    contextDates: [{ key: 'contractStartDate', days: -60 }], forceIncompatible: true,
    expected: { outcomes: ['DEFER'], never: ['CREATE_ACTION', 'NO_ACTION'] }, deterministic: true,
  },
  {
    id: 'ATR-REC-24', label: 'Date de fin passée CONNUE, fin effective prouvée sans obligation → aucune carte, sans IA',
    rule: 'DATA-CONTRACT-END', documentType: 'SUBSCRIPTION_CONTRACT', title: 'Confirmation de résiliation',
    known: { days: -60 }, clauses: ['Nous vous confirmons la résiliation effective de votre contrat. Votre dossier est clôturé.'],
    expected: { outcomes: ['NO_ACTION'], never: ['DATA_QUESTION', 'CREATE_ACTION'] }, deterministic: true,
  },
  {
    id: 'ATR-REC-25', label: 'Date de fin passée CONNUE, aucune clause d’obligation lue → aucune carte, aucun appel IA, donnée conservée',
    rule: 'DATA-CONTRACT-END', documentType: 'SERVICE_CONTRACT', title: 'Contrat d’entretien de la chaudière',
    known: { days: -30 },
    expected: { outcomes: ['NO_ACTION'], never: ['DATA_QUESTION', 'CREATE_ACTION'] }, deterministic: true,
  },
];

const decale = (today: string, days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Lot 75I (F) — nature de la sortie IA d'un cas : VALID (contrat respecté,
 * preuve retrouvée), AMBIGUOUS (T4 incertain, abstention), INCOHERENT (preuve
 * introuvable dans le contexte, échéance invalide, libellé interdit — contrôle
 * serveur), ERROR (panne, sortie hors contrat). Null : aucune IA (déterministe).
 */
type RecetteAiOutput = 'VALID' | 'AMBIGUOUS' | 'INCOHERENT' | 'ERROR';

interface RecetteCaseResult {
  caseId: string;
  label: string;
  ok: boolean;
  expected: RecetteCase['expected'];
  obtained: { outcome: string | null; card: string | null; kind: string | null; pertinence: string | null; derivation?: string | null; action?: string | null };
  aiCalled: boolean;
  aiStatus: string | null;
  traceId: string | null;
  reason: string;
  problems: string[];
  /** Lot 75I (F) : classement de la sortie IA. */
  aiOutput?: RecetteAiOutput | null;
  /** Lot 75I (F) : justification et avertissements du contrôle serveur (trace explicable). */
  justification?: string | null;
  warnings?: string[];
}

/** Classement d'une sortie IA (pure). */
function classifyAiOutput(r: Pick<PertinenceResult, 'aiCalled' | 'cached' | 'technicalFailure' | 'aiStatus' | 'intervention' | 'pertinence'>): RecetteAiOutput | null {
  if (!r.aiCalled) return null;
  if (r.technicalFailure || r.aiStatus === 'ERROR') return 'ERROR';
  if (r.intervention?.warnings.length) return 'INCOHERENT';
  if (r.intervention?.needed === 'uncertain' || r.pertinence === 'UNDECIDED') return 'AMBIGUOUS';
  return 'VALID';
}

type DecideFn = NonNullable<Parameters<typeof assessDeadlinePertinence>[0]['decide']>;

/** Vérifie un résultat contre l'attente (pure). */
export function checkRecetteResult(c: RecetteCase, r: { outcome: string | null; card: string | null; kind: string | null; derivation?: string | null; aiCalled: boolean }): string[] {
  const out: string[] = [];
  if (!c.expected.outcomes.includes(r.outcome as never)) out.push(`issue ${r.outcome ?? 'aucune'} hors attente (${c.expected.outcomes.join(' | ')})`);
  if (c.expected.card !== undefined && r.outcome === 'CREATE_ACTION' && r.card !== c.expected.card) out.push(`carte ${r.card ?? 'aucune'} ≠ ${c.expected.card ?? 'aucune'}`);
  if (c.expected.kinds && r.card === 'INTERVENTION' && !c.expected.kinds.includes(r.kind ?? '')) out.push(`intervention ${r.kind ?? 'aucune'} hors attente (${c.expected.kinds.join(' | ')})`);
  for (const n of c.expected.never ?? []) {
    if (n === 'DATA_QUESTION' ? r.outcome === 'CREATE_ACTION' && r.card === 'DATA_QUESTION' : r.outcome === n) out.push(`issue interdite : ${n}`);
  }
  if (c.expected.derivation && r.derivation !== c.expected.derivation) out.push(`calcul ${r.derivation ?? 'aucun'} ≠ ${c.expected.derivation}`);
  if (c.deterministic && r.aiCalled) out.push('appel IA alors que la décision est déterministe');
  return out;
}

/** Exécute UN cas (même décision que la production). */
export async function runRecetteCase(c: RecetteCase, p: { accountId: number; today: string; config: T4AssessmentConfig; decide?: DecideFn }): Promise<RecetteCaseResult> {
  const rule = getRule(c.rule)!;
  const base = { caseId: c.id, label: c.label, expected: c.expected };
  if (c.derivation) {
    const spec = derivationFor(rule.fieldKey!)!;
    const conf = c.derivation.certain ? 'certain' : 'probable';
    const d = computeDerivation(spec,
      c.derivation.startDays === null ? [] : [{ value: decale(p.today, c.derivation.startDays), confidence: conf, source: 'FACTS', key: spec.start.key }],
      c.derivation.duration ? [{ value: c.derivation.duration, confidence: conf, source: 'FACTS', key: 'dureePret' }] : []);
    const obtained = { outcome: d.status === 'CALCULATED_RELIABLE' ? 'AUTO_RESOLVED' : null, card: null, kind: null, pertinence: null, derivation: d.status };
    const problems = checkRecetteResult(c, { ...obtained, aiCalled: false }).filter((x) => !(obtained.outcome === null && x.startsWith('issue aucune')));
    return { ...base, ok: problems.length === 0, obtained, aiCalled: false, aiStatus: null, traceId: null, reason: d.reason, problems };
  }
  const candidates: PertinenceCandidate[] = (c.candidates ?? []).map((x) => ({ iso: decale(p.today, x.days), source: x.source, excerpt: x.excerpt ?? null }));
  // Lot 75I (D) : configuration incompatible imposée (cas déterministe).
  const config = c.forceIncompatible ? { ...p.config, interventionCapable: false } : p.config;
  const contextDates = (c.contextDates ?? []).map((d) => ({ key: d.key, iso: decale(p.today, d.days) }));
  const lifecycle = c.lifecycle ? { ...c.lifecycle, signals: [] } : c.clauses ? lifecycleSignalsOf(c.clauses) : null;
  let r: PertinenceResult;
  try {
    r = c.known
      // Lot 75I (A) : date CONNUE — même décision que la production (obligation seule).
      ? await assessKnownDeadlineObligation({
        accountId: p.accountId, fileId: 0, rule, documentType: c.documentType, known: { iso: decale(p.today, c.known.days), source: c.known.source ?? 'KNOWN_VALUE' },
        clauses: c.clauses ?? [], today: p.today, decide: p.decide, documentTitle: c.title, contextDates, lifecycle,
        evidenceFingerprint: `recette:${c.id}`, config, remembered: null,
      })
      : await assessDeadlinePertinence({
        accountId: p.accountId, fileId: 0, rule, documentType: c.documentType, candidates, today: p.today, decide: p.decide,
        documentTitle: c.title, contextDates, lifecycle,
        evidenceFingerprint: `recette:${c.id}`, config, remembered: null,
      });
  } catch (e) {
    return { ...base, ok: false, obtained: { outcome: null, card: null, kind: null, pertinence: null }, aiCalled: false, aiStatus: 'ERROR', traceId: null,
      reason: String((e as Error).message).slice(0, 300), problems: ['erreur technique'], aiOutput: 'ERROR' };
  }
  const obtained = { outcome: r.outcome, card: r.card, kind: r.intervention?.kind ?? null, pertinence: r.pertinence, action: r.intervention?.action ?? null };
  const problems = checkRecetteResult(c, { ...obtained, aiCalled: r.aiCalled });
  const aiOutput = classifyAiOutput(r);
  if (r.technicalFailure) problems.push('échec technique T4 (panne ou sortie hors contrat)');
  if (aiOutput === 'INCOHERENT') problems.push(`sortie T4 incohérente : ${r.intervention?.warnings.join(', ')}`);
  if (r.incompatible && !c.forceIncompatible) problems.push('contrat T4 actif incompatible (t4_output_v3 requis)');
  return {
    ...base, ok: problems.length === 0, obtained, aiCalled: r.aiCalled, aiStatus: r.aiStatus, traceId: r.aiTraceId, reason: r.reason, problems,
    aiOutput, justification: r.intervention?.justification ?? null, warnings: r.intervention?.warnings ?? [],
  };
}

/** Configuration de la recette : IA effective, seuils par défaut (lot 63) — pure. */
export function recetteConfig(c: T4AssessmentConfig): T4AssessmentConfig {
  return withThresholds({ ...c, ref: c.aiRef ?? c.ref, thresholds: undefined }, { ...DEFAULT_TO_PROCESS_THRESHOLDS });
}

export async function recetteTableReady(): Promise<boolean> {
  try {
    const [r] = (await pgClient.unsafe(`SELECT to_regclass('to_process_relevance_recette_runs') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
    return r?.ok === true;
  } catch { return false; }
}

/**
 * Lance la recette (enregistrée avant de démarrer, statut consultable) : un
 * cas à la fois, résultats écrits au fil de l'eau. Ne lève jamais.
 */
export async function startRelevanceRecette(p: { accountId: number; userId: number | null; decide?: DecideFn; config?: T4AssessmentConfig; cases?: readonly RecetteCase[] }): Promise<{ runId: number | null; done: Promise<void> }> {
  if (!(await recetteTableReady())) return { runId: null, done: Promise.resolve() };
  // Lot 63 : la recette rejoue un corpus de référence dont les dates sont
  // calées sur les seuils PAR DÉFAUT (lot 61) — elle les impose, quels que
  // soient les seuils réglés dans le BO (sinon ses attentes seraient fausses).
  const config = recetteConfig(p.config ?? await t4AssessmentConfig());
  const cases = p.cases ?? RELEVANCE_RECETTE_CASES;
  const [r] = (await pgClient.unsafe(
    `INSERT INTO to_process_relevance_recette_runs (requested_by, account_id, config_ref, engine_version, total)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [p.userId, p.accountId, config.ref, DOCUMENT_RULE_ENGINE_VERSION, cases.length] as never[],
  )) as unknown as Array<{ id: number }>;
  const runId = Number(r.id);
  const today = todayParis();
  const done = (async () => {
    const results: RecetteCaseResult[] = [];
    try {
      for (const c of cases) {
        results.push(await runRecetteCase(c, { accountId: p.accountId, today, config, decide: p.decide }));
        await pgClient.unsafe(
          `UPDATE to_process_relevance_recette_runs SET results = $2::jsonb, passed = $3, failed = $4, ai_calls = $5 WHERE id = $1`,
          [runId, JSON.stringify(results), results.filter((x) => x.ok).length, results.filter((x) => !x.ok).length, results.filter((x) => x.aiCalled).length] as never[],
        );
      }
      await pgClient.unsafe(
        `UPDATE to_process_relevance_recette_runs SET status = 'DONE', finished_at = now(),
                error = $2 WHERE id = $1`,
        [runId, config.interventionCapable ? null : 'Version T4 active sans contrat t4_output_v3 : activer la version de référence (BO › Prompts maîtres › T4) puis relancer.'] as never[],
      );
    } catch (e) {
      await pgClient.unsafe(
        `UPDATE to_process_relevance_recette_runs SET status = 'ERROR', finished_at = now(), error = $2 WHERE id = $1`,
        [runId, String((e as Error).message).slice(0, 500)] as never[],
      ).catch(() => {});
    }
  })();
  return { runId, done };
}

interface RecetteRunView {
  id: number; status: string; configRef: string | null; engineVersion: string; total: number; passed: number; failed: number; aiCalls: number;
  results: RecetteCaseResult[]; error: string | null; startedAt: string; finishedAt: string | null; requestedBy: number | null;
  /** Lot 75I (F) : sorties IA par nature (valides, ambiguës, incohérentes, en erreur). */
  aiOutputs: Record<RecetteAiOutput, number>;
}

/** Sorties IA d'une recette par nature (pure). */
function aiOutputCounts(results: Array<Pick<RecetteCaseResult, 'aiOutput'>>): Record<RecetteAiOutput, number> {
  const out: Record<RecetteAiOutput, number> = { VALID: 0, AMBIGUOUS: 0, INCOHERENT: 0, ERROR: 0 };
  for (const r of results) if (r.aiOutput) out[r.aiOutput] += 1;
  return out;
}

export async function listRecetteRuns(limit = 5): Promise<RecetteRunView[]> {
  if (!(await recetteTableReady())) return [];
  const rows = (await pgClient.unsafe(
    `SELECT * FROM to_process_relevance_recette_runs ORDER BY id DESC LIMIT $1`, [Math.max(1, Math.min(20, limit))] as never[],
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((x) => {
    const results = ((typeof x.results === 'string' ? JSON.parse(x.results) : x.results) as RecetteCaseResult[] | null) ?? [];
    return {
      id: Number(x.id), status: String(x.status), configRef: (x.config_ref as string) ?? null, engineVersion: String(x.engine_version),
      total: Number(x.total), passed: Number(x.passed), failed: Number(x.failed), aiCalls: Number(x.ai_calls),
      results, aiOutputs: aiOutputCounts(results),
      error: (x.error as string) ?? null, startedAt: new Date(x.started_at as string).toISOString(),
      finishedAt: x.finished_at ? new Date(x.finished_at as string).toISOString() : null, requestedBy: x.requested_by == null ? null : Number(x.requested_by),
    };
  });
}
