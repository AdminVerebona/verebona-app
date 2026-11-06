/**
 * Lot 105B — REVALIDATION D'UNE PROMOTION AUTOMATIQUE (ticket P1 « IA
 * auto-amélioration », §3 ; recette R5). Préproduction seulement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * INVARIANT : une activation automatique n'a lieu que si TOUT est revérifié
 * DEPUIS LA BASE, à la frontière `activateQualifiedCandidate` puis dans la
 * transaction finale. L'objet A1 transmis par l'appelant n'est qu'une
 * RÉCLAMATION qui désigne ce qu'il faut relire ; `{ allowed: true }` fourni,
 * forgé ou obsolète n'est JAMAIS suffisant.
 *
 * Frontière (`revalidatePromotion`) — refus motivé (code stable) si :
 *   · environnement autre que la préproduction (NOT_PREPROD) ;
 *   · réclamation absente ou sans désignation vérifiable (CLAIM_MALFORMED) ;
 *   · autre candidate (CANDIDATE_MISMATCH), candidate non QUALIFIÉE, non
 *     automatique, supprimée, déjà active (CANDIDATE_NOT_QUALIFIED) ;
 *   · autre campagne, campagne d'un autre environnement ou d'un autre type,
 *     qualification serveur absente (CAMPAIGN_MISMATCH) ; autre périmètre
 *     (TREATMENT_MISMATCH) ;
 *   · décision A1 journalisée absente, refusée, d'une autre campagne /
 *     candidate / contexte (A1_ASSESSMENT_*), règles changées
 *     (A1_RULES_CHANGED), trop ancienne (A1_EXPIRED) ;
 *   · empreinte de contexte A1 COURANTE différente (approbation révoquée,
 *     oracle modifié, rejet, manifeste ou référentiel changé :
 *     A1_CONTEXT_CHANGED) ;
 *   · preuve de chaque opération absente, non admissible, ou signée avec une
 *     autre empreinte que la signature COURANTE du couple (prompt, contrat,
 *     schéma, corpus, oracles, profil, capacités du modèle, seuils :
 *     EVIDENCE_*) ;
 *   · verrou A1 RECALCULÉ sur les résultats PERSISTÉS de la campagne et la
 *     certification courante refusé (A1_NOW_REFUSED) ;
 *   · gel de configuration actif (FROZEN, ACT-03 — respect du choix humain).
 * Transaction (`transactionGuard`) — sous le verrou de l'environnement, la
 * ligne de la candidate verrouillée, les approbations / rejets du corpus
 * VERROUILLÉS en partage (aucune décision concurrente ne peut s'intercaler
 * jusqu'à la validation) : certification, configuration active, révision et
 * campagne de la candidate, gel — inchangés depuis la frontière, sinon
 * CONCURRENT_CHANGE / FROZEN et RIEN n'est activé.
 * Chaque décision (acceptée ou refusée) est journalisée avec sa version de
 * référence (`ai_promotion_events`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { getAiEnvironment } from '../config/environment';
import type { Treatment } from '../config/treatments';
import type { SqlLike } from '../config/config-version.repository';
import type { MasterCorpusCase, MasterFileReader } from '../governance/master-corpus/cases';
import type { CaseResult } from '../governance/master-corpus/certification/coverage';
import { promotionParams } from './promotion-params';
import { recordPromotionEvent } from './promotion-journal';

type Row = Record<string, unknown>;

export type GateCode =
  | 'NOT_PREPROD' | 'CLAIM_MALFORMED' | 'CANDIDATE_MISMATCH' | 'CANDIDATE_NOT_QUALIFIED' | 'CAMPAIGN_MISMATCH' | 'TREATMENT_MISMATCH'
  | 'A1_ASSESSMENT_MISSING' | 'A1_ASSESSMENT_REFUSED' | 'A1_ASSESSMENT_MISMATCH' | 'A1_RULES_CHANGED' | 'A1_EXPIRED' | 'A1_CONTEXT_CHANGED' | 'A1_NOW_REFUSED'
  | 'EVIDENCE_MISSING' | 'EVIDENCE_NOT_ADMISSIBLE' | 'EVIDENCE_STALE' | 'FROZEN' | 'CONCURRENT_CHANGE'
  // Lot 113I (CDC V2 PRO-01, PRO-07, C-004, BUD-05) :
  | 'PROMOTION_GUARD_UNAVAILABLE' | 'MODEL_VERSION_UNVERIFIABLE' | 'CANDIDATE_STALE' | 'COST_UNRECONCILED';

export const GATE_CODE_LABELS: Readonly<Record<GateCode, string>> = {
  NOT_PREPROD: 'activation automatique hors préproduction',
  CLAIM_MALFORMED: 'réclamation A1 sans désignation vérifiable (objet allowed:true fourni)',
  CANDIDATE_MISMATCH: 'réclamation d’une autre candidate',
  CANDIDATE_NOT_QUALIFIED: 'candidate non qualifiée en base',
  CAMPAIGN_MISMATCH: 'campagne différente de la qualification enregistrée',
  TREATMENT_MISMATCH: 'périmètre différent de la qualification enregistrée',
  A1_ASSESSMENT_MISSING: 'décision A1 journalisée introuvable',
  A1_ASSESSMENT_REFUSED: 'décision A1 journalisée refusée',
  A1_ASSESSMENT_MISMATCH: 'décision A1 d’une autre campagne, candidate ou contexte',
  A1_RULES_CHANGED: 'règles du verrou A1 changées depuis la décision',
  A1_EXPIRED: 'décision A1 trop ancienne',
  A1_CONTEXT_CHANGED: 'certification / inventaire changés depuis la décision A1 (preuve obsolète)',
  A1_NOW_REFUSED: 'verrou A1 refusé sur les résultats persistés et la certification courante',
  EVIDENCE_MISSING: 'preuve de qualification absente pour une opération',
  EVIDENCE_NOT_ADMISSIBLE: 'preuve de qualification non admissible',
  EVIDENCE_STALE: 'preuve signée avec une empreinte différente de la configuration courante',
  FROZEN: 'configuration gelée par un administrateur',
  CONCURRENT_CHANGE: 'changement concurrent entre la revalidation et l’activation',
  PROMOTION_GUARD_UNAVAILABLE: 'lecture des gels administratifs impossible : promotion bloquée (fail-closed, jamais « aucun gel »)',
  MODEL_VERSION_UNVERIFIABLE: 'stabilité officielle / version effective du modèle non prouvée (présomption par le nom refusée)',
  CANDIDATE_STALE: 'configuration effective du traitement changée depuis la qualification (intervention humaine ou autre promotion)',
  COST_UNRECONCILED: 'coût d’appels d’amélioration inconnu ou sous-estimé non rapproché : aucune promotion fondée sur ces mesures',
};

/** Version de référence d'une décision de revalidation (journalisée, rejouée dans la transaction). */
export interface GateReference {
  environment: string;
  candidateVersionId: number;
  campaignId: number | null;
  treatment: Treatment | null;
  assessmentId: number | null;
  rulesVersion: string | null;
  contextFingerprint: string | null;
  inventoryVersion: string | null;
  manifestVersion: number | null;
  certificationStamp: string | null;
  activeVersionId: number | null;
  candidateRevisionId: number | null;
  evidence: Array<{ operationCode: string; evidenceId: number; signature: string }>;
  paramsVersion: string;
}

export interface GateDecision { ok: boolean; code: GateCode | null; reasons: string[]; reference: GateReference }

export class PromotionGateRefused extends Error {
  constructor(readonly gateCode: GateCode, message: string) { super(message); this.name = 'PromotionGateRefused'; }
}

export interface GateCaseOptions { readMasterFile?: MasterFileReader; corpusCases?: MasterCorpusCase[]; includeT1Reference?: boolean }

const q = async (sql: SqlLike, text: string, params: unknown[] = []): Promise<Row[]> => (await sql.unsafe(text, params as never[])) as unknown as Row[];
const sameSet = (a: readonly string[], b: readonly string[]) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());

/** Empreinte des approbations / rejets du corpus (même formule que `certificationStamp`, sur la connexion donnée). */
async function stampOf(sql: SqlLike): Promise<string> {
  try {
    const [a] = await q(sql, `SELECT count(*)::int AS n, coalesce(max(id), 0)::bigint AS m FROM ai_corpus_oracle_approvals`);
    const [d] = await q(sql, `SELECT count(*)::int AS n, coalesce(max(id), 0)::bigint AS m FROM ai_corpus_case_decisions`);
    return `a${a.n}:${a.m}|d${d.n}:${d.m}`;
  } catch {
    return 'absent';
  }
}

/** Réclamation lisible ? (désignation vérifiable exigée : jamais la seule propriété `allowed`). */
function parseClaim(claim: unknown): { assessmentId: number; campaignId: number; candidateVersionId: number; treatments: Treatment[]; context: string; contextFingerprint: string; rulesVersion: string } | null {
  if (!claim || typeof claim !== 'object') return null;
  const c = claim as Record<string, unknown>;
  const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);
  if (c.allowed !== true) return null;
  const assessmentId = int(c.assessmentId);
  const campaignId = int(c.campaignId);
  const candidateVersionId = int(c.candidateVersionId);
  const treatments = Array.isArray(c.treatments) ? c.treatments.map(String) as Treatment[] : null;
  if (!assessmentId || !campaignId || !candidateVersionId || !treatments?.length) return null;
  if (typeof c.context !== 'string' || typeof c.contextFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(c.contextFingerprint) || typeof c.rulesVersion !== 'string') return null;
  return { assessmentId, campaignId, candidateVersionId, treatments, context: c.context, contextFingerprint: c.contextFingerprint, rulesVersion: c.rulesVersion };
}

/** Résultats par cas du manifeste depuis les observations PERSISTÉES (réussi seulement si toutes réussissent). */
async function persistedResults(evidenceIds: readonly number[], entries: ReadonlyMap<string, { critical: boolean }>): Promise<Map<string, CaseResult>> {
  const out = new Map<string, CaseResult>();
  if (!evidenceIds.length) return out;
  let rows: Row[] = [];
  try {
    rows = await q(pgClient as unknown as SqlLike,
      `SELECT manifest_case_id, outcome, defects, inconclusive_reason, decisions, expected_source FROM ai_qualification_cases
        WHERE evidence_id = ANY($1::bigint[]) AND manifest_case_id IS NOT NULL ORDER BY case_id, observation`, [[...evidenceIds]]);
  } catch { rows = []; }
  const par = new Map<string, Row[]>();
  for (const r of rows.filter((x) => !String(x.expected_source ?? '').endsWith(':ADVISORY'))) par.set(String(r.manifest_case_id), [...(par.get(String(r.manifest_case_id)) ?? []), r]);
  for (const [id, l] of par) {
    const outcome = l.some((o) => o.outcome === 'FAILED') ? 'FAILED' : l.every((o) => o.outcome === 'PASSED') ? 'PASSED' : 'INCONCLUSIVE';
    const defects = l.flatMap((o) => (o.defects as CaseResult['defects']) ?? []);
    out.set(id, {
      caseId: id, outcome, decisions: [...new Set(l.flatMap((o) => (o.decisions as string[] | null) ?? []))], defects,
      criticalDefects: entries.get(id)?.critical ? defects : [], inconclusiveReason: (l.find((o) => o.inconclusive_reason)?.inconclusive_reason as string | undefined) ?? null,
    });
  }
  return out;
}

/**
 * Revalidation COMPLÈTE depuis la base (frontière d'activation). Rend la décision et sa version de référence ;
 * journalise toujours (acceptée ou refusée).
 */
/** Statut de cycle de vie du catalogue (lecture ; absent → null). */
async function catalogLifecycle(model: string): Promise<{ lifecycle: string | null; basis: 'structured' | 'name_rule' | null } | null> {
  try {
    const [r] = await q(pgClient as unknown as SqlLike, `SELECT lifecycle, lifecycle_basis FROM ai_model_catalog WHERE model = $1 ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`, [model]);
    if (!r) return null;
    return { lifecycle: r.lifecycle == null ? null : String(r.lifecycle), basis: r.lifecycle_basis === 'structured' ? 'structured' : r.lifecycle_basis == null ? null : 'name_rule' };
  } catch { return null; }
}

/** Engagements budgétaires bloquants (coût inconnu, sous-estimation) ; table absente : aucun. */
async function budgetBlockers(environment: string): Promise<string | null> {
  try {
    const [r] = await q(pgClient as unknown as SqlLike,
      `SELECT count(*) FILTER (WHERE state = 'UNRECONCILED')::int AS u, count(*) FILTER (WHERE underestimated AND anomaly_resolved_at IS NULL)::int AS s
         FROM ai_improvement_budget_reservations WHERE environment = $1`, [environment]);
    const u = Number(r?.u ?? 0);
    const s = Number(r?.s ?? 0);
    return u || s ? `${u} engagement(s) au coût inconnu, ${s} sous-estimation(s) non résolue(s) (BO › Promotion automatique › Budget)` : null;
  } catch (e) {
    if (String((e as { code?: string })?.code) === '42P01') return null;
    return `registre budgétaire illisible (${(e as Error).message.slice(0, 120)})`;
  }
}

export async function revalidatePromotion(p: {
  versionId: number; claim: unknown; caseOptions?: GateCaseOptions; now?: Date;
  /** Tests : lecture des gels (défaut : base). Une erreur levée = garde illisible. */
  readInterventions?: (environment: string) => Promise<Array<import('../config/config-interventions.service').Intervention>>;
  readCatalogLifecycle?: (model: string) => Promise<{ lifecycle: string | null; basis: 'structured' | 'name_rule' | null } | null>;
}): Promise<GateDecision> {
  const params = promotionParams();
  const environment = getAiEnvironment();
  const now = p.now ?? new Date();
  const reference: GateReference = {
    environment, candidateVersionId: p.versionId, campaignId: null, treatment: null, assessmentId: null, rulesVersion: null, contextFingerprint: null,
    inventoryVersion: null, manifestVersion: null, certificationStamp: null, activeVersionId: null, candidateRevisionId: null, evidence: [], paramsVersion: params.version,
  };
  const decide = async (code: GateCode | null, reasons: string[]): Promise<GateDecision> => {
    const d: GateDecision = { ok: code === null, code, reasons, reference };
    await recordPromotionEvent({
      environment, kind: 'ACTIVATION_GATE', candidateVersionId: p.versionId, campaignId: reference.campaignId, treatment: reference.treatment,
      allowed: d.ok, code, message: d.ok ? 'Revalidation depuis la base réussie : activation autorisée (transaction finale à suivre).' : `Activation refusée (${code}) : ${GATE_CODE_LABELS[code!]} — ${reasons.join(' ; ')}`.slice(0, 2000),
      reference: reference as unknown as Record<string, unknown>,
    });
    return d;
  };
  if (environment === 'production') return decide('NOT_PREPROD', ['la production importe le fichier global : aucune activation automatique (R9)']);
  const claim = parseClaim(p.claim);
  if (!claim) return decide('CLAIM_MALFORMED', ['la réclamation doit désigner l’évaluation A1 journalisée, la campagne, la candidate, le périmètre et l’empreinte de contexte']);
  reference.campaignId = claim.campaignId;
  reference.assessmentId = claim.assessmentId;
  if (claim.candidateVersionId !== p.versionId) return decide('CANDIDATE_MISMATCH', [`réclamation pour la candidate ${claim.candidateVersionId}, activation demandée pour ${p.versionId}`]);

  const cfg = await import('../config/config-version.repository');
  const row = await cfg.readCandidatePromotion(p.versionId);
  if (!row || row.origin !== 'auto' || row.deleted || row.environment !== environment || row.state !== 'QUALIFIED' || row.status === 'ACTIVE') {
    return decide('CANDIDATE_NOT_QUALIFIED', [`candidate ${p.versionId} : ${!row ? 'introuvable' : `origine ${row.origin ?? '—'}, état ${row.state ?? '—'}, statut ${row.status}${row.deleted ? ', supprimée' : ''}, environnement ${row.environment}`}`]);
  }
  reference.candidateRevisionId = row.currentRevisionId;
  const qual = (row.promotion.qualification ?? null) as { campaignId?: number; treatment?: Treatment; state?: string; gains?: Array<{ operationCode: string; outcome: string }>; excluded?: string[] } | null;
  if (row.campaignId !== claim.campaignId || !qual || qual.campaignId !== claim.campaignId || qual.state !== 'QUALIFIED') {
    return decide('CAMPAIGN_MISMATCH', [`campagne réclamée ${claim.campaignId}, campagne de la candidate ${row.campaignId ?? '—'}, qualification serveur ${qual ? `${qual.state} (campagne ${qual.campaignId})` : 'absente'}`]);
  }
  const { getCampaignRow } = await import('./repository');
  const camp = await getCampaignRow(claim.campaignId);
  const kindAttendu = claim.context === 'PROMPT_CONFORMITY' ? 'CONFORMITY' : 'AUTO';
  const candidatsCampagne = [camp?.candidateVersionId, ...((camp?.request.candidates as number[] | undefined) ?? []), (camp?.request.conformity as { candidateVersionId?: number } | undefined)?.candidateVersionId]
    .filter((x): x is number => typeof x === 'number');
  if (!camp || camp.environment !== environment || camp.kind !== kindAttendu || !candidatsCampagne.includes(p.versionId)) {
    return decide('CAMPAIGN_MISMATCH', [`campagne ${claim.campaignId} : ${!camp ? 'introuvable' : `type ${camp.kind} (attendu ${kindAttendu}), environnement ${camp.environment}, candidates ${candidatsCampagne.join(', ') || '—'}`}`]);
  }
  const treatment = qual.treatment ?? null;
  reference.treatment = treatment;
  if (!treatment || !sameSet(claim.treatments, [treatment])) return decide('TREATMENT_MISMATCH', [`périmètre réclamé ${claim.treatments.join(', ')}, qualification enregistrée ${treatment ?? '—'}`]);

  // Décision A1 journalisée.
  const promo = await import('../governance/master-corpus/certification/promotion');
  const { A1_RULES_VERSION } = await import('../governance/master-corpus/certification/coverage');
  const lockTest = promo.promotionLockOverride();
  let a1: Row | undefined;
  try {
    [a1] = await q(pgClient as unknown as SqlLike, `SELECT * FROM ai_corpus_a1_assessments WHERE id = $1`, [claim.assessmentId]);
  } catch { a1 = undefined; }
  if (!a1) return decide('A1_ASSESSMENT_MISSING', [`évaluation A1 n° ${claim.assessmentId} absente du journal`]);
  const summary = (a1.summary ?? {}) as { contextFingerprint?: string; inventoryVersion?: string };
  reference.rulesVersion = String(a1.rules_version);
  reference.contextFingerprint = summary.contextFingerprint ?? null;
  reference.inventoryVersion = summary.inventoryVersion ?? null;
  reference.manifestVersion = a1.manifest_version == null ? null : Number(a1.manifest_version);
  if (a1.allowed !== true) return decide('A1_ASSESSMENT_REFUSED', [`évaluation A1 n° ${claim.assessmentId} : verrou fermé`]);
  if (Number(a1.campaign_id) !== claim.campaignId || Number(a1.candidate_version_id) !== p.versionId || String(a1.context) !== claim.context
    || !sameSet((a1.treatments as string[]) ?? [], claim.treatments) || summary.contextFingerprint !== claim.contextFingerprint || String(a1.environment) !== environment) {
    return decide('A1_ASSESSMENT_MISMATCH', [`évaluation A1 n° ${claim.assessmentId} : campagne ${String(a1.campaign_id)}, candidate ${String(a1.candidate_version_id)}, contexte ${String(a1.context)}, empreinte ${String(summary.contextFingerprint ?? '—').slice(0, 12)} ≠ réclamation`]);
  }
  if (String(a1.rules_version) !== A1_RULES_VERSION && !(lockTest && String(a1.rules_version) === 'test')) {
    return decide('A1_RULES_CHANGED', [`règles ${String(a1.rules_version)} ≠ règles en vigueur ${A1_RULES_VERSION}`]);
  }
  const age = now.getTime() - new Date(String(a1.created_at)).getTime();
  if (age > params.gate.maxAssessmentAgeMs) return decide('A1_EXPIRED', [`décision de ${Math.round(age / 60_000)} min (maximum ${Math.round(params.gate.maxAssessmentAgeMs / 60_000)} min)`]);

  // Contexte A1 COURANT (approbations, révocations, rejets, oracles, manifeste, référentiel).
  const { loadCertificationState } = await import('../governance/master-corpus/certification/state');
  const etat = await loadCertificationState();
  const courant = await promo.a1ContextFingerprint([treatment], etat);
  if (courant.fingerprint !== claim.contextFingerprint) {
    return decide('A1_CONTEXT_CHANGED', [`empreinte de contexte A1 courante ${courant.fingerprint.slice(0, 12)} ≠ décision ${claim.contextFingerprint.slice(0, 12)} : la preuve A1 n’est plus courante, réévaluation exigée`]);
  }
  reference.manifestVersion = etat.manifest.version;

  // Preuves de chaque opération : admissibles et signées avec la signature COURANTE du couple.
  const version = await cfg.getVersion(p.versionId);
  if (!version) return decide('CANDIDATE_NOT_QUALIFIED', [`candidate ${p.versionId} introuvable`]);
  const { couplesWithState, defaultMasterReader } = await import('./context');
  const couples = (await couplesWithState(version, {
    readMasterFile: p.caseOptions?.readMasterFile ?? await defaultMasterReader(), treatments: [treatment],
    corpusCases: p.caseOptions?.corpusCases, includeT1Reference: p.caseOptions?.includeT1Reference,
  })).filter((c) => c.rank === 0 && !(qual.excluded ?? []).includes(c.operationCode));
  if (!couples.length) return decide('EVIDENCE_MISSING', [`aucune opération modèle à prouver pour ${treatment}`]);
  const { changedParts, PART_LABELS } = await import('./signature');
  for (const c of couples) {
    const [ev] = await q(pgClient as unknown as SqlLike,
      `SELECT id, verdict, signature, prompt_fingerprint, contract_fingerprint, corpus_fingerprint, evaluator_fingerprint, capabilities_sha256, thresholds_version, model, profile
         FROM ai_qualification_evidence WHERE campaign_id = $1 AND config_version_id = $2 AND role = 'CANDIDATE' AND operation_code = $3 AND rank = 0 ORDER BY id DESC LIMIT 1`,
      [claim.campaignId, p.versionId, c.operationCode]);
    if (!ev) return decide('EVIDENCE_MISSING', [`${c.operationCode} : aucune preuve de la candidate dans la campagne ${claim.campaignId}`]);
    if (String(ev.verdict) !== 'ADMISSIBLE') return decide('EVIDENCE_NOT_ADMISSIBLE', [`${c.operationCode} : preuve n° ${String(ev.id)} ${String(ev.verdict)}`]);
    if (String(ev.signature) !== c.signature) {
      const avant = {
        model: String(ev.model), rank: 0, profile: ev.profile as Record<string, unknown>, promptFingerprint: ev.prompt_fingerprint as string | null, contractFingerprint: ev.contract_fingerprint as string | null,
        corpusFingerprint: ev.corpus_fingerprint as string | null, evaluatorFingerprint: ev.evaluator_fingerprint as string | null, capabilitiesSha256: ev.capabilities_sha256 as string | null, thresholdsVersion: String(ev.thresholds_version),
      };
      const parts = changedParts(avant, c.parts).map((k) => PART_LABELS[k]);
      return decide('EVIDENCE_STALE', [`${c.operationCode} : preuve n° ${String(ev.id)} signée avec une autre empreinte (${parts.join(', ') || 'signature'} changé(s))`]);
    }
    reference.evidence.push({ operationCode: c.operationCode, evidenceId: Number(ev.id), signature: c.signature });
  }

  // Verrou A1 RECALCULÉ sur les résultats persistés et la certification courante.
  if (lockTest) {
    const a = await lockTest({ treatments: [treatment], observations: [], gains: qual.gains ?? [] });
    if (!a.allowed) return decide('A1_NOW_REFUSED', a.blockers.slice(0, 5).map((b) => b.message));
  } else {
    const { assessA1 } = await import('../governance/master-corpus/certification/coverage');
    const results = await persistedResults(reference.evidence.map((e) => e.evidenceId), etat.byId);
    const a = assessA1({ treatments: [treatment], entries: etat.manifest.entries, statusOf: etat.statusOf, results, gains: qual.gains ?? [] });
    if (!a.allowed) return decide('A1_NOW_REFUSED', a.blockers.slice(0, 5).map((b) => b.message));
  }

  // Gel (respect du choix humain). Lot 113I (PRO-07, EC-07) : une lecture impossible BLOQUE — jamais « aucun gel ».
  const { listActiveInterventions, freezeFor } = await import('../config/config-interventions.service');
  let interventions: Awaited<ReturnType<typeof listActiveInterventions>>;
  try {
    interventions = await (p.readInterventions ?? listActiveInterventions)(environment);
  } catch (e) {
    return decide('PROMOTION_GUARD_UNAVAILABLE', [`gels administratifs illisibles (${(e as Error).message.slice(0, 200)})`]);
  }
  const gel = freezeFor(treatment, interventions);
  if (gel) return decide('FROZEN', [`gel ${gel.treatment ?? 'global'} posé le ${gel.createdAt.slice(0, 10)} : ${gel.reason}`.slice(0, 300)]);

  // Lot 113I (PRO-01, C-004, MOD-03/04) : un NOUVEAU modèle principal n'est promu automatiquement que si sa stabilité
  // officielle est prouvée (statut structuré du fournisseur ou attestation administrative) — jamais présumée par le nom.
  const delta = (row.promotion.delta ?? null) as { axes?: string[] } | null;
  const entree = version.entries.find((e) => e.treatment === treatment);
  if (entree?.primaryModel && (!delta || (delta.axes ?? []).includes('MODEL'))) {
    const active = await cfg.getActiveVersion(environment).catch(() => null);
    const actuel = active?.entries.find((e) => e.treatment === treatment)?.primaryModel ?? null;
    if (entree.primaryModel !== actuel) {
      const { loadPolicy, stabilityProof } = await import('./improvement-policy');
      const policy = await loadPolicy(environment);
      const cat = await (p.readCatalogLifecycle ?? catalogLifecycle)(entree.primaryModel);
      const preuve = stabilityProof(entree.primaryModel, cat, policy);
      if (!preuve.verified) return decide('MODEL_VERSION_UNVERIFIABLE', [preuve.detail]);
    }
  }

  // Lot 113I (BUD-05, FIN-006) : mesures dont le coût est inconnu / sous-estimé non rapproché → aucune promotion.
  const bloquants = await budgetBlockers(environment);
  if (bloquants) return decide('COST_UNRECONCILED', [bloquants]);

  reference.certificationStamp = await stampOf(pgClient as unknown as SqlLike);
  reference.activeVersionId = (await cfg.getActiveVersion(environment).catch(() => null))?.id ?? null;
  return decide(null, []);
}

/**
 * Revalidation FINALE dans la transaction d'activation (verrou de l'environnement pris, ligne de la candidate
 * verrouillée par `lockedVersion`). Verrouille en PARTAGE les approbations et rejets du corpus jusqu'à la
 * validation : aucune approbation / révocation concurrente ne peut s'intercaler.
 */
export function transactionGuard(ref: GateReference): (sql: SqlLike) => Promise<void> {
  return async (sql) => {
    const refuse = (code: GateCode, m: string) => { throw new PromotionGateRefused(code, `Activation annulée dans la transaction (${code}) : ${m}`); };
    for (const t of ['ai_corpus_oracle_approvals', 'ai_corpus_case_decisions']) {
      const [x] = await q(sql, `SELECT to_regclass($1) IS NOT NULL AS ok`, [t]);
      if (x?.ok) await sql.unsafe(`LOCK TABLE ${t} IN SHARE MODE`);
    }
    const stamp = await stampOf(sql);
    if (stamp !== ref.certificationStamp) refuse('CONCURRENT_CHANGE', `certification du corpus modifiée (${ref.certificationStamp} → ${stamp})`);
    // Lot 113I (PRO-04, REC-064) : la configuration active PEUT avoir changé pour un AUTRE traitement — la promotion
    // ciblée fusionne sur la dernière active. Le conflit sur le traitement CIBLÉ est jugé par empreinte dans
    // `promoteTreatment` (CANDIDATE_STALE).
    const [v] = await q(sql, `SELECT candidate_state, candidate_campaign_id, current_revision_id FROM ai_config_versions WHERE id = $1`, [ref.candidateVersionId]);
    if (!v || String(v.candidate_state) !== 'QUALIFIED' || Number(v.candidate_campaign_id) !== ref.campaignId || Number(v.current_revision_id) !== ref.candidateRevisionId) {
      refuse('CONCURRENT_CHANGE', `candidate modifiée (état ${String(v?.candidate_state ?? '—')}, campagne ${String(v?.candidate_campaign_id ?? '—')}, révision ${String(v?.current_revision_id ?? '—')})`);
    }
    const { listActiveInterventions, freezeFor } = await import('../config/config-interventions.service');
    let interventions: Awaited<ReturnType<typeof listActiveInterventions>> = [];
    try {
      interventions = await listActiveInterventions(ref.environment, sql);
    } catch (e) {
      refuse('PROMOTION_GUARD_UNAVAILABLE', `gels administratifs illisibles dans la transaction (${(e as Error).message.slice(0, 200)})`);
    }
    if (freezeFor(ref.treatment, interventions)) refuse('FROZEN', 'gel posé pendant l’activation');
  };
}
