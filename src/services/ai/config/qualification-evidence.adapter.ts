/**
 * ADAPTATEUR UNIQUE des preuves de qualification et des seuils — lot 86B
 * (CDC Pilotage IA V2, phase P6 : VER-02, VER-03, QUAL-01, ACT-04, MIG-02 ;
 * décision PO 14).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN ADAPTATEUR
 *
 * Le fichier global `verebona-ia-config-export` 2.0.0 transporte une section
 * « preuves de qualification » par COUPLE (opération × modèle × profil
 * effectif) et les seuils de qualification (en lecture). La table des preuves
 * par couple et sa fonction de lecture sont livrées EN PARALLÈLE par le
 * chantier 86A (phase P5). En attendant, la section est alimentée depuis
 * l'état de qualification EXISTANT (`ai_model_qualification`, qualification
 * TECHNIQUE par modèle, lot 35B / 49 / 85C).
 *
 * TOUT le reste du lot (export, import, routage) ne lit les preuves et les
 * seuils QUE par ce fichier :
 *   · `readPairEvidence(pairs)`      — preuves des couples demandés ;
 *   · `qualificationThresholds()`    — seuils versionnés (lecture seule) ;
 *   · `EVIDENCE_SOURCE`              — libellé de la source (fichier, BO).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * À REBRANCHER À L'INTÉGRATION DE 86A (aucune autre modification requise)
 *
 *   1. `readPairEvidence` : remplacer le corps de `defaultReader` par l'appel
 *      à la fonction de lecture par couple de 86A, en convertissant son
 *      résultat en `PairEvidence` (statuts du CDC §16.1 : jamais testée / en
 *      test / admissible / refusée / non concluante / obsolète). Garder la
 *      règle : une preuve n'est `admissible` que pour l'EMPREINTE exacte
 *      (modèle + profil + opération + prompt + contrat), sinon `obsolete`.
 *   2. `qualificationThresholds` : renvoyer la constante versionnée des seuils
 *      de 86A (décision PO 14 : définis dans le code, jamais abaissés).
 *   3. `EVIDENCE_SOURCE` : `'pair_evidence'`.
 *   Les tests `l86b-transfert-format.test.ts` (« L86B-U07 ») figent ce contrat.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE TRANSITOIRE (MIG-02 « pas de qualification fictive »)
 *
 * La qualification technique par modèle n'est PAS une preuve métier par
 * couple : elle donne au mieux `technical_only` (génération réussie avec la
 * clé testée), `refused` (épreuve de génération en échec), `obsolete`
 * (requalification nécessaire, version d'épreuves périmée) ou `never_tested`.
 * Elle ne produit JAMAIS `admissible` : aucune promotion automatique de
 * production ne peut donc s'appuyer sur elle (ACT-01, R51).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * INTÉGRATION LOT 86 (FAIT) : `readPairEvidence` lit d'abord les preuves par
 * couple de 86A (`listQualificationEvidence`, état courant calculé contre la
 * configuration active), puis retombe sur la règle transitoire ci-dessus
 * pour un couple jamais qualifié ; `qualificationThresholds` lit la
 * constante versionnée `QUALIFICATION_THRESHOLDS` de 86A.
 */
import { canonicalJson, sha256 } from './config-snapshot';
import { QUALIFICATION_THRESHOLDS } from '../qualification/thresholds';

/** États d'une preuve (CDC §16.1) + `technical_only` (transition, MIG-02). */
export const EVIDENCE_STATUSES = ['never_tested', 'in_test', 'admissible', 'refused', 'inconclusive', 'obsolete', 'technical_only'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export const EVIDENCE_STATUS_LABELS: Readonly<Record<EvidenceStatus, string>> = {
  never_tested: 'jamais testé',
  in_test: 'en test',
  admissible: 'qualifié (admissible)',
  refused: 'refusé',
  inconclusive: 'non concluant',
  obsolete: 'preuve obsolète',
  technical_only: 'qualification technique seulement (aucune preuve métier par couple)',
};

/**
 * Source des preuves : depuis l'intégration du lot 86 (86A × 86B), les preuves
 * PAR COUPLE de la qualification (`ai_qualification_evidence`). Un couple
 * jamais qualifié retombe sur la qualification technique par modèle
 * (`model_qualification`, jamais `admissible`).
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

/** Qualification technique stockée (sous-ensemble de `StoredQualification`). */
export interface TechnicalQualification {
  generate: boolean;
  structured: boolean | null;
  multimodal: boolean | null;
  thinking: boolean | null;
  qualifiedAt: string;
  version: string;
  requalificationRequiredAt?: string | null;
}

/**
 * Conversion PURE d'une qualification technique par modèle en preuve de
 * couple (règle transitoire, jamais `admissible`).
 */
export function evidenceFromTechnicalQualification(
  pair: PairRef,
  q: TechnicalQualification | undefined,
  ctx: { environment: string; currentVersion: string },
): PairEvidence {
  const base = {
    operationCode: pair.operationCode, model: pair.model, profileSha256: pair.profileSha256,
    source: 'model_qualification' as EvidenceSource, environment: ctx.environment,
    promptSha256: null, contractRef: null, thresholdsSha256: null,
  };
  if (!q) return { ...base, status: 'never_tested', testedAt: null, summary: 'Aucune qualification connue pour ce modèle avec la clé active.' };
  if (q.version !== ctx.currentVersion || q.requalificationRequiredAt) {
    return { ...base, status: 'obsolete', testedAt: q.qualifiedAt, summary: q.requalificationRequiredAt ? 'Requalification nécessaire (capacités du modèle modifiées).' : `Épreuves techniques périmées (${q.version}).` };
  }
  if (!q.generate) return { ...base, status: 'refused', testedAt: q.qualifiedAt, summary: 'Qualification technique en échec (génération).' };
  const caps = [q.structured ? 'sortie structurée' : null, q.multimodal ? 'image' : null, q.thinking ? 'raisonnement' : null].filter(Boolean);
  return {
    ...base, status: 'technical_only', testedAt: q.qualifiedAt,
    summary: `Qualification technique du modèle réussie (génération${caps.length ? `, ${caps.join(', ')}` : ''}) — aucune preuve métier par couple.`,
  };
}

export interface EvidenceReaderDeps {
  environment?: string;
  /** Qualifications techniques avec la clé active (injectables en test). */
  loadTechnical?: () => Promise<ReadonlyMap<string, TechnicalQualification>>;
  /** Preuves par couple (86A), injectables en test. */
  loadPairEvidence?: (environment: string) => Promise<PairQualificationRecord[]>;
}

/** Preuve par couple de la qualification (sous-ensemble de `QualificationEvidenceRecord`, lot 86A). */
export interface PairQualificationRecord {
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
  const [{ loadQualifications, QUALIFICATION_VERSION }, { getAiEnvironment }] = await Promise.all([
    import('../provider/model-qualification.service'), import('./environment'),
  ]);
  const environment = deps.environment ?? getAiEnvironment();
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
  } catch { /* table absente (migration non jouée) : qualification technique seule */ }
  const technical = deps.loadTechnical ? await deps.loadTechnical() : await loadQualifications();
  const th = thresholdsSha256(qualificationThresholds());
  return pairs.map((p) => {
    const r = parCouple.get(`${p.operationCode}|${p.model}`);
    return r ? evidenceFromPairRecord(p, r, { thresholdsSha256: th })
      : evidenceFromTechnicalQualification(p, technical.get(p.model), { environment, currentVersion: QUALIFICATION_VERSION });
  });
}

/**
 * Preuves des couples demandés, dans l'ordre demandé. Ne lève jamais : une
 * source illisible rend `never_tested` (jamais une preuve inventée).
 * ▶ POINT DE REBRANCHEMENT 86A (voir l'en-tête).
 */
export async function readPairEvidence(pairs: PairRef[], deps: EvidenceReaderDeps = {}): Promise<PairEvidence[]> {
  try {
    return await defaultReader(pairs, deps);
  } catch {
    return pairs.map((p) => evidenceFromTechnicalQualification(p, undefined, { environment: deps.environment ?? 'inconnu', currentVersion: '' }));
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
 * ▶ POINT DE REBRANCHEMENT 86A : renvoyer la constante versionnée de 86A.
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
