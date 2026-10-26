/**
 * ADAPTATEUR UNIQUE des preuves de qualification et des seuils — lot 86B
 * (CDC Pilotage IA V2, phase P6 : VER-02, VER-03, QUAL-01, ACT-04, MIG-02 ;
 * décision PO 14).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SOURCE UNIQUE (lot 89A, P8)
 *
 * Le fichier global `verebona-ia-config-export` 2.0.0 transporte une section
 * « preuves de qualification » par COUPLE et les seuils (en lecture). Export,
 * import et routage ne lisent les preuves et les seuils QUE par ce fichier :
 *   · `readPairEvidence(pairs)`      — preuves par couple de la qualification
 *     (`ai_qualification_evidence`, lot 86A, état courant calculé contre la
 *     configuration active) ; un couple sans preuve est `never_tested` ;
 *   · `qualificationThresholds()`    — constante versionnée de 86A ;
 *   · `EVIDENCE_SOURCE`              — `pair_evidence`.
 * Une preuve n'est `admissible` qu'à signature identique, sinon `obsolete`.
 *
 * RETIRÉ au lot 89A : la règle transitoire du lot 86B qui, pour un couple
 * jamais qualifié, lisait la qualification TECHNIQUE par modèle
 * (`ai_model_qualification`) et rendait `technical_only` / `refused` /
 * `obsolete`. Elle ne produisait jamais `admissible` (aucun effet sur les
 * décisions automatiques), mais montrait pour le même couple un autre état
 * que la qualification par couple du BO (MIG-04 : pas deux règles pour une
 * même preuve). Le statut `technical_only` reste LISIBLE (fichiers 2.0.0
 * exportés avant le lot 89A) ; il n'est plus produit. La qualification
 * technique par modèle reste utilisée par le catalogue (capacités, 85C).
 */
import { canonicalJson, sha256 } from './config-snapshot';
import { QUALIFICATION_THRESHOLDS } from '../qualification/thresholds';

/** États d'une preuve (CDC §16.1) + `technical_only` (historique : lu dans les anciens fichiers, plus produit depuis le lot 89A). */
export const EVIDENCE_STATUSES = ['never_tested', 'in_test', 'admissible', 'refused', 'inconclusive', 'obsolete', 'technical_only'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

const EVIDENCE_STATUS_LABELS: Readonly<Record<EvidenceStatus, string>> = {
  never_tested: 'jamais testé',
  in_test: 'en test',
  admissible: 'qualifié (admissible)',
  refused: 'refusé',
  inconclusive: 'non concluant',
  obsolete: 'preuve obsolète',
  technical_only: 'qualification technique seulement (aucune preuve métier par couple)',
};

/**
 * Source des preuves : les preuves PAR COUPLE de la qualification
 * (`ai_qualification_evidence`). `model_qualification` : source historique,
 * lisible dans un fichier exporté avant le lot 89A, plus produite.
 */
export const EVIDENCE_SOURCE = 'pair_evidence' as const;
export type EvidenceSource = typeof EVIDENCE_SOURCE | 'model_qualification';

/** Couple dont on demande la preuve : empreintes de ce qui serait exécuté. */
export interface PairRef {
  operationCode: string;
  model: string;
  /** Empreinte du profil effectif du rang (raisonnement, plafond, délai). */
  profileSha256: string;
  /** Empreinte du prompt maître appliqué (`null` : inconnue). */
  promptSha256: string | null;
  /** Contrat de sortie (`Nom@vN`). */
  contractRef: string | null;
}

export interface PairEvidence {
  operationCode: string;
  model: string;
  profileSha256: string;
  status: EvidenceStatus;
  source: EvidenceSource;
  /** Environnement où la preuve a été obtenue. */
  environment: string;
  testedAt: string | null;
  /** Empreintes sous lesquelles la preuve a été obtenue (`null` : non rattachée). */
  promptSha256: string | null;
  contractRef: string | null;
  /** Version des seuils appliqués (`null` : aucune). */
  thresholdsSha256: string | null;
  summary: string;
}

/**
 * Statut d'un couple jamais qualifié par couple (lot 89A, P8) : `never_tested`
 * — la règle transitoire du lot 86B (« qualification technique seulement »,
 * lue sur la qualification TECHNIQUE par modèle) est RETIRÉE : elle donnait
 * pour le même couple un autre état que la qualification par couple du BO
 * (« jamais testé »), deux règles pour une même preuve (MIG-04). Pur.
 */
export function evidenceNeverTested(pair: PairRef, ctx: { environment: string }): PairEvidence {
  return {
    operationCode: pair.operationCode, model: pair.model, profileSha256: pair.profileSha256, status: 'never_tested', source: 'pair_evidence',
    environment: ctx.environment, testedAt: null, promptSha256: null, contractRef: null, thresholdsSha256: null,
    summary: 'Aucune preuve de qualification par couple : jamais testé (un choix manuel reste possible, sans qualification).',
  };
}

interface EvidenceReaderDeps {
  environment?: string;
  /** Preuves par couple (86A), injectables en test. */
  loadPairEvidence?: (environment: string) => Promise<PairQualificationRecord[]>;
}

/** Preuve par couple de la qualification (sous-ensemble de `QualificationEvidenceRecord`, lot 86A). */
interface PairQualificationRecord {
  operationCode: string;
  model: string;
  environment: string;
  createdAt: string;
  thresholdsVersion: string;
  /** État COURANT calculé par la qualification contre la configuration active (signature exacte). */
  currentState?: 'NEVER_TESTED' | 'TESTING' | 'ADMISSIBLE' | 'REFUSED' | 'INCONCLUSIVE' | 'OBSOLETE';
  currentStateChanged?: string[];
}

/**
 * Conversion PURE d'une preuve par couple (86A) en `PairEvidence`. L'état
 * courant de 86A compare déjà la signature complète (modèle servi, profil,
 * prompt, contrat, corpus, évaluateur, capacités, seuils) à la configuration
 * active : « admissible » n'est rendu qu'à signature identique, et la preuve
 * porte alors les empreintes COURANTES du couple ; sinon « obsolète ».
 */
export function evidenceFromPairRecord(pair: PairRef, r: PairQualificationRecord, ctx: { thresholdsSha256: string }): PairEvidence {
  const st = r.currentState ?? 'OBSOLETE';
  const status: EvidenceStatus = st === 'ADMISSIBLE' ? 'admissible' : st === 'REFUSED' ? 'refused' : st === 'INCONCLUSIVE' ? 'inconclusive'
    : st === 'TESTING' ? 'in_test' : st === 'NEVER_TESTED' ? 'never_tested' : 'obsolete';
  const exact = status === 'admissible';
  return {
    operationCode: pair.operationCode, model: pair.model, profileSha256: pair.profileSha256, status, source: 'pair_evidence',
    environment: r.environment, testedAt: r.createdAt,
    promptSha256: exact ? pair.promptSha256 : null, contractRef: exact ? pair.contractRef : null,
    thresholdsSha256: exact ? ctx.thresholdsSha256 : null,
    summary: status === 'obsolete'
      ? `Preuve par couple obsolète (${(r.currentStateChanged ?? []).join(', ') || 'signature différente'}).`
      : `Qualification par couple (${r.thresholdsVersion}) : ${EVIDENCE_STATUS_LABELS[status]}.`,
  };
}

async function defaultReader(pairs: PairRef[], deps: EvidenceReaderDeps): Promise<PairEvidence[]> {
  const environment = deps.environment ?? (await import('./environment')).getAiEnvironment();
  // Preuves par couple (86A) : dernière preuve de chaque couple, état courant calculé.
  const parCouple = new Map<string, PairQualificationRecord>();
  try {
    const records = deps.loadPairEvidence
      ? await deps.loadPairEvidence(environment)
      : await (await import('../qualification/service')).listQualificationEvidence({ environment, latestPerCouple: true });
    for (const r of records) {
      const k = `${r.operationCode}|${r.model}`;
      const prev = parCouple.get(k);
      if (!prev || r.createdAt > prev.createdAt) parCouple.set(k, r);
    }
  } catch { /* table absente (migration non jouée) : aucune preuve, jamais testé */ }
  const th = thresholdsSha256(qualificationThresholds());
  return pairs.map((p) => {
    const r = parCouple.get(`${p.operationCode}|${p.model}`);
    return r ? evidenceFromPairRecord(p, r, { thresholdsSha256: th }) : evidenceNeverTested(p, { environment });
  });
}

/**
 * Preuves des couples demandés, dans l'ordre demandé. Ne lève jamais : une
 * source illisible rend `never_tested` (jamais une preuve inventée).
 * Source unique : preuves par couple (lot 86A), voir l'en-tête.
 */
export async function readPairEvidence(pairs: PairRef[], deps: EvidenceReaderDeps = {}): Promise<PairEvidence[]> {
  try {
    return await defaultReader(pairs, deps);
  } catch {
    return pairs.map((p) => evidenceNeverTested(p, { environment: deps.environment ?? 'inconnu' }));
  }
}

// ── Seuils (décision PO 14) ─────────────────────────────────────────────────

export interface QualificationThresholds {
  /** Libellé de la source des valeurs. */
  source: string;
  /** Qualité : tolérance zéro sur chaque critère éliminatoire. */
  quality: Record<'inventions' | 'proven_omissions' | 'incorrect_values' | 'wrong_attachments' | 'dates_without_evidence' | 'unjustified_changes' | 'schema_violations', number>;
  /** Part minimale des contrôles et scénarios obligatoires exécutés et validés (%). */
  mandatoryChecksPassedPct: number;
  latency: { callsWithinOperationCapPct: number; maxP95DegradationPct: number };
  concurrency: { queuePerWorkerInstance: number; queuePerTreatment: number; synchronousSimultaneousT2: number; synchronousSimultaneousT6: number };
}

/**
 * Seuils de qualification, en LECTURE (le BO et le fichier les montrent ;
 * aucun champ ne les modifie). Valeurs de la décision PO 14.
 * Constante versionnée de la qualification par couple (lot 86A).
 */
export function qualificationThresholds(): QualificationThresholds {
  const q = QUALIFICATION_THRESHOLDS;
  const d = q.quality.maxDefects;
  const sync = q.concurrency.synchronousTreatments;
  return {
    source: `Seuils versionnés de la qualification par couple (${q.version}, décision PO 14).`,
    quality: {
      inventions: d.INVENTION, proven_omissions: d.OMISSION, incorrect_values: d.INCORRECT_VALUE, wrong_attachments: d.ATTRIBUTION,
      dates_without_evidence: d.DATE_WITHOUT_PROOF, unjustified_changes: d.UNJUSTIFIED_CHANGE, schema_violations: d.SCHEMA,
    },
    mandatoryChecksPassedPct: Math.round(q.quality.mandatoryValidatedRatio * 100),
    latency: { callsWithinOperationCapPct: Math.round(q.latency.withinCapRatio * 100), maxP95DegradationPct: Math.round(q.latency.maxP95Degradation * 100) },
    concurrency: {
      queuePerWorkerInstance: q.concurrency.queuedPerWorker, queuePerTreatment: q.concurrency.queuedPerTreatment,
      synchronousSimultaneousT2: sync.includes('T2') ? q.concurrency.synchronousSimultaneous : 0,
      synchronousSimultaneousT6: sync.includes('T6') ? q.concurrency.synchronousSimultaneous : 0,
    },
  };
}

/** Empreinte des VALEURS des seuils (la source, simple libellé, n'y entre pas). */
export function thresholdsSha256(t: QualificationThresholds): string {
  const { source: _s, ...values } = t;
  return sha256(canonicalJson(values));
}

/**
 * Une preuve vaut-elle pour une promotion AUTOMATIQUE de ce couple, ici et
 * maintenant (ACT-01, QUAL-07, VER-03) ? Seulement `admissible`, obtenue
 * sous les MÊMES empreintes (profil, prompt, contrat, seuils) : sinon elle
 * est obsolète, jamais une qualification active.
 */
export function evidenceSupportsAutomaticPromotion(
  e: Pick<PairEvidence, 'status' | 'profileSha256' | 'promptSha256' | 'contractRef' | 'thresholdsSha256'> | null | undefined,
  current: { profileSha256: string; promptSha256: string | null; contractRef: string | null; thresholdsSha256: string },
): boolean {
  if (!e || e.status !== 'admissible') return false;
  return e.profileSha256 === current.profileSha256
    && e.promptSha256 !== null && e.promptSha256 === current.promptSha256
    && e.contractRef === current.contractRef
    && e.thresholdsSha256 === current.thresholdsSha256;
}
