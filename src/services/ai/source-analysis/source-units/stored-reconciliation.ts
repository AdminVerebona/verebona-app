/**
 * Lot 113AN (Trello #741) — réconciliation de la couverture d'un document
 * DÉJÀ analysé, depuis ses données PERSISTÉES (aucun appel IA, aucune
 * lecture du fichier) : faits actifs, décisions de valeur actives et
 * VALIDES, métadonnées de l'extraction, lignes de tableau de la couche A.
 *
 * Utilisée par :
 *   · la reprise ciblée (`t1-completeness-retry`, réparation demandée par le
 *     contrôle de cohérence) AVANT de choisir les unités à réparer — seules
 *     les vraies lacunes sont envoyées au modèle — et APRÈS l'ajout des faits ;
 *   · le réexamen des décisions de valeur (`value-decisions/review.ts`) : une
 *     décision arrivée APRÈS l'analyse (contrôle de cohérence) met enfin à
 *     jour la couverture (elle restait `not_extracted`) ;
 *   · BO › Exécutions IA › Complétude T1 › « Réconcilier (sans IA) » :
 *     simulation (rien n'est écrit) ou application (journalisée).
 *
 * Idempotente : une seconde application ne change rien (même provenance,
 * même état). Ne crée ni fait, ni décision, ni lien : seuls l'état de
 * couverture, sa provenance et la politique des unités restantes changent.
 */
import { candidateReconciliationValue, reconcileCoverage, reconciliationSummary, residualCounts, withResidualPolicies, type ReconciliationInput } from './coverage-reconciliation';
import { buildCompletenessReport } from './coverage';
import { decideRetry, releaseUnschedulablePending, retryFactsOf, retryLimits } from './retry-policy';
import {
  loadAllDocumentSourceUnits, loadDocumentCoverage, loadUnresolvedDocumentFacts, writeSourceLayer,
} from './repository';
import { SOURCE_LAYER_VERSION, type CoveredSourceUnit, type T1CoverageDiagnostics, type UnresolvedFactRecord } from './types';

type Row = Record<string, unknown>;
type Sql = { unsafe: (q: string, p?: never[]) => Promise<unknown> };

/** Données persistées d'un document vues par la réconciliation (sans l'étape). */
export async function loadStoredReconciliationInput(sql: Sql, accountId: number, fileId: number): Promise<Omit<ReconciliationInput, 'stage'>> {
  const faits = (await sql.unsafe(
    `SELECT f.id::float8 AS id, f.excerpt, f.location, f.value_text, f.normalized_value, to_jsonb(f)->>'raw_value' AS raw_value,
            f.value_number::float8 AS value_number, f.label, f.attribute, f.fact_key, f.canonical_key, to_jsonb(f)->>'raw_key' AS raw_key,
            to_jsonb(f)->'source_unit_ids' AS source_unit_ids
       FROM document_facts f WHERE f.account_id = $1 AND f.file_id = $2 AND f.status = 'active' ORDER BY f.id`,
    [accountId, fileId] as never[],
  )) as Row[];
  const [ext] = (await sql.unsafe(
    `SELECT amount_cents::float8 AS amount_cents, to_char(document_date, 'YYYY-MM-DD') AS document_date, supplier_siret
       FROM document_extractions WHERE account_id = $1 AND file_id = $2`,
    [accountId, fileId] as never[],
  )) as Row[];
  // Lot 114G (#760, P2-05) : candidats Opération ACTIFS du document — l'analyse les exploitait, le chargement
  // historique les omettait. Table absente (schéma ancien) : aucun candidat, jamais une erreur.
  const candidats = (await sql.unsafe(
    `SELECT candidate_key, payload FROM document_operation_candidates
      WHERE account_id = $1 AND file_id = $2 AND status = 'ACTIVE' ORDER BY id`,
    [accountId, fileId] as never[],
  ).catch(() => [])) as Row[];
  const { loadActiveValueDecisions } = await import('../value-decisions/store');
  const decisions = (await loadActiveValueDecisions(sql as never, accountId, [fileId]).catch(() => []))
    .filter((d) => d.validity === 'VALID' && d.sourceUnitId);
  const page = (loc: unknown) => {
    const l = (typeof loc === 'string' ? JSON.parse(loc) : loc) as { page?: unknown } | null;
    return typeof l?.page === 'number' ? l.page : null;
  };
  return {
    facts: faits.map((f) => ({
      ref: `db:${Number(f.id)}`,
      unitIds: Array.isArray(f.source_unit_ids) ? (f.source_unit_ids as unknown[]).map(String) : [],
      values: [f.value_text, f.normalized_value, f.raw_value, f.value_number == null ? null : Number(f.value_number)],
      labels: [f.label as string | null, f.attribute as string | null, f.fact_key as string | null, f.canonical_key as string | null, f.raw_key as string | null],
      excerpt: (f.excerpt as string | null) ?? null,
      page: page(f.location),
    })),
    values: [
      ...(ext?.amount_cents != null ? [{ ref: 'amount', source: 'METADATA' as const, values: [Number(ext.amount_cents) / 100], page: null }] : []),
      ...(ext?.document_date ? [{ ref: 'documentDate', source: 'METADATA' as const, values: [String(ext.document_date)], page: null }] : []),
      ...(ext?.supplier_siret ? [{ ref: 'supplier', source: 'METADATA' as const, values: [String(ext.supplier_siret)], page: null }] : []),
      ...candidats.map((c) => candidateReconciliationValue(String(c.candidate_key), typeof c.payload === 'string' ? JSON.parse(c.payload) : c.payload))
        .filter((v) => v.values.length > 0),
    ],
    decisions: decisions.map((d) => ({
      ref: `db:${d.id}`, sourceUnitId: d.sourceUnitId!, kind: d.kind, normalizedValue: d.normalizedValue, decision: d.decision,
    })),
  };
}

/** Réconciliation EN MÉMOIRE d'unités persistées (reprise ciblée) ; politiques posées. */
export async function reconcileStoredUnits<U extends CoveredSourceUnit>(sql: Sql, p: { accountId: number; fileId: number; units: readonly U[] }): Promise<U[]> {
  const input = await loadStoredReconciliationInput(sql, p.accountId, p.fileId);
  return withResidualPolicies(reconcileCoverage(p.units, { ...input, stage: 'STORED' }));
}

/** Requalification d'une unité (simulation ou application) — identifiants et codes seulement. */
export interface StoredRequalification {
  unitId: string; kind: string; page: number | null;
  from: { status: string; reason: string | null }; to: { status: string; reason: string | null };
  rule: string | null; refs: string[];
}

export interface StoredReconciliationResult {
  /**
   * Lot 115H (#785, § 4) : `CONFLICT_DEFERRED` — une écriture plus récente de la
   * couche (analyse, reprise, action du BO) est passée pendant le recalcul, deux
   * fois de suite. RIEN n'a été écrit, l'état récent est préservé et le document
   * est explicitement DIFFÉRÉ au passage suivant : jamais un succès fictif.
   */
  outcome: 'APPLIED' | 'SIMULATED' | 'UNCHANGED' | 'NO_LAYER' | 'CONFLICT_DEFERRED';
  requalified: StoredRequalification[];
  before: { covered: number; unresolved: number; uncertain: number; qualityState: string | null };
  after: { covered: number; unresolved: number; uncertain: number; qualityState: string | null };
  /**
   * Lot 114H (#775) — état des reprises AVANT / APRÈS le recalcul par la règle unique (`retry-policy.ts`) :
   * anomalies de complétude, reprise programmée, unités en attente levées, motif d'absence de reprise.
   * Absent pour un document sans couche A.
   */
  retry?: {
    anomaliesBefore: string[]; anomaliesAfter: string[];
    scheduledBefore: boolean; scheduledAfter: boolean;
    /** Unités en attente dont l'attente a été levée (plus aucun chemin exécutable). */
    pendingReleased: number;
    /** Actions automatiques admissibles après recalcul (vide : aucune). */
    actions: string[];
    blocked: string | null;
    /** L'état, les anomalies ou l'échéance ont changé sans requalification d'unité. */
    stateChanged: boolean;
  };
}

const compte = (units: readonly CoveredSourceUnit[], s: string) => units.filter((u) => u.status === s).length;

/**
 * Réconcilie la couche A persistée d'un document. `apply` : écrit les unités
 * requalifiées (provenance, politique) et recalcule le rapport de complétude
 * avec les MÊMES règles que l'analyse ; sinon simulation (rien n'est écrit).
 */
export async function reconcileStoredDocumentCoverage(p: {
  accountId: number; fileId: number; apply: boolean; origin: string;
}): Promise<StoredReconciliationResult> {
  // ══════════════════════════════════════════════════════════════════════
  // LOT 115H (Trello #785, § 4) — CONTRÔLE DE VERSION SUR LE CHEMIN DE LA
  // RÉCONCILIATION ENREGISTRÉE
  //
  // Règle complétée : la lecture (unités, couverture, faits, décisions) avait
  // lieu AVANT la transaction d'écriture, sans aucune garde de version sur ce
  // chemin — une analyse, une reprise ou une action du BO passée entre-temps
  // était ÉCRASÉE par un état calculé sur des données périmées.
  //
  // Désormais la version lue (`updated_at`) est portée jusqu'à l'écriture, qui
  // verrouille la ligne et la compare. En cas de conflit : on RELIT et on
  // RECALCULE une fois ; si le conflit persiste, le document est explicitement
  // DIFFÉRÉ (`CONFLICT_DEFERRED`), rien n'est écrit, et la couche plus récente
  // reste intacte. Jamais de succès fictif.
  // ══════════════════════════════════════════════════════════════════════
  const { CoverageVersionConflictError } = await import('./repository');
  for (let essai = 0; essai < 2; essai++) {
    try {
      return await reconcileStoredPass(p);
    } catch (e) {
      if (!(e instanceof CoverageVersionConflictError)) throw e;
      console.info(`[t1-reconciliation] fichier ${p.fileId} (${p.origin}) : couche écrite entre-temps — `
        + `${essai === 0 ? 'relecture et recalcul' : 'passage différé'}.`);
    }
  }
  const vide = { covered: 0, unresolved: 0, uncertain: 0, qualityState: null };
  return { outcome: 'CONFLICT_DEFERRED', requalified: [], before: vide, after: vide };
}

async function reconcileStoredPass(p: {
  accountId: number; fileId: number; apply: boolean; origin: string;
}): Promise<StoredReconciliationResult> {
  const { pgClient } = await import('@/db');
  const sql = pgClient as unknown as Sql;
  // Carte #837 (B4) : VERSION DES PREUVES lue AVANT les données confrontées — faits, décisions, candidats, tableaux,
  // ancrages, extraction. La garde `updated_at` de la couverture ne les englobe pas : elle est complétée ci-dessous.
  const { loadEvidenceDependencies } = await import('./evidence-version');
  const preuvesLues = p.apply ? await loadEvidenceDependencies(sql, p.accountId, p.fileId) : null;
  const stored = await loadAllDocumentSourceUnits(p.fileId, { accountId: p.accountId });
  const cov = await loadDocumentCoverage(p.fileId, p.accountId);
  if (stored.length === 0 || !cov) {
    const vide = { covered: 0, unresolved: 0, uncertain: 0, qualityState: cov?.qualityState ?? null };
    return { outcome: 'NO_LAYER', requalified: [], before: vide, after: vide };
  }
  const { toCovered, storedDiagnostics } = await import('./jobs');
  const units = stored.map(toCovered);
  let majs = await reconcileStoredUnits(sql, { accountId: p.accountId, fileId: p.fileId, units });
  const requalified: StoredRequalification[] = [];
  majs.forEach((u, i) => {
    const a = units[i];
    if (a.status === u.status && a.reason === u.reason) return;
    requalified.push({
      unitId: u.sourceUnitId, kind: u.kind, page: u.page, from: { status: a.status, reason: a.reason }, to: { status: u.status, reason: u.reason },
      rule: u.coverageProvenance?.rule ?? null, refs: u.coverageProvenance?.refs ?? [],
    });
  });
  const before = { covered: compte(units, 'COVERED'), unresolved: compte(units, 'UNRESOLVED'), uncertain: compte(units, 'UNCERTAIN'), qualityState: cov.qualityState };

  // Rapport recalculé avec les règles de l'analyse (données conservées de la ligne de couverture).
  const diag = storedDiagnostics(cov.verification ?? null);
  // ══════════════════════════════════════════════════════════════════════
  // LOT 114H (Trello #775, P1-A / P1-C) — LA RÉCONCILIATION APPLIQUE AUSSI LA RÈGLE DES REPRISES
  //
  // Règle remplacée : `retryAllowed = tentatives < plafond` et échéance
  // recopiée telle quelle ; un document sans requalification d'unité était
  // rendu « inchangé » même quand son état annonçait une reprise devenue
  // impossible. La règle unique décide : attentes sans chemin levées, état
  // et anomalies recalculés, échéance retirée si plus rien n'est admissible,
  // reposée (15 min) pour une lacune RÉPARABLE restée sans échéance (ancien
  // refus de remise en file). Jamais de nouvelle échéance pour une simple
  // relecture d'image / de scan (aucune relance de masse).
  // ══════════════════════════════════════════════════════════════════════
  const limits = retryLimits();
  const budget = { retryAttempts: cov.retryAttempts, continuationRuns: diag.continuationRuns };
  const faits = { qualityState: cov.qualityState, verificationReason: diag.verification?.reason ?? null, pagesMissing: diag.verification?.missing ?? [] };
  const faitsReprise = retryFactsOf(majs, faits, limits);
  const regle = decideRetry(faitsReprise, budget, limits);
  const enAttenteAvant = majs.filter((u) => u.repairState === 'PENDING').length;
  if (!regle.automatic) majs = releaseUnschedulablePending(majs, regle);
  const pendingReleased = enAttenteAvant - majs.filter((u) => u.repairState === 'PENDING').length;
  const politiquesChangees = majs.some((u, i) => (u.residualPolicy ?? null) !== (units[i].residualPolicy ?? null)
    || (u.repairState ?? null) !== (units[i].repairState ?? null));
  const unresolved: UnresolvedFactRecord[] = (await loadUnresolvedDocumentFacts(p.fileId, { accountId: p.accountId }))
    .map(({ id: _i, fileId: _f, createdAt: _c, ...x }) => { void _i; void _f; void _c; return x; });
  const report = buildCompletenessReport(majs, {
    factsCount: cov.factsCount, unresolvedFacts: unresolved, truncatedSectionsCount: cov.truncatedSectionsCount,
    batchedSectionsCount: cov.batchedSectionsCount, repairPassCount: cov.repairPassCount, chunkCount: cov.chunkCount,
    warningCodes: (cov.anomalies ?? []).includes('PARTIAL_EXTRACTION') ? ['PARTIAL_EXTRACTION'] : [],
    retryAllowed: regle.automatic,
    verification: diag.verification ? { ...diag.verification, verified: Array.from({ length: diag.pagesVerified }, (_, i) => i + 1) } : null,
    normalisation: diag.normalisation, sourceReread: diag.sourceReread,
  });
  if (report.diagnostics) {
    const d = report.diagnostics as T1CoverageDiagnostics & { continuationRuns?: number; scheduledBy?: Record<string, unknown> };
    if (diag.repairPropagation) d.repairPropagation = diag.repairPropagation;
    if (diag.coverageRepair) d.coverageRepair = diag.coverageRepair;
    if (diag.continuationRuns) d.continuationRuns = diag.continuationRuns;
    d.reconciliation = reconciliationSummary(majs, 'STORED');
    d.residualPolicies = residualCounts(majs);
  }
  const after = { covered: report.coveredUnits, unresolved: report.unresolvedUnits, uncertain: report.uncertainUnits, qualityState: report.qualityState };
  const programmeeAvant = cov.nextRetryAt !== null && cov.nextRetryAt !== undefined;
  // ══════════════════════════════════════════════════════════════════════
  // LOT 115H (Trello #785, § 3) — UNE ÉCHÉANCE ABSENTE EST REPOSÉE D'APRÈS
  // L'ACTION RÉELLEMENT ADMISSIBLE, ET PAS SEULEMENT D'APRÈS L'ÉTAT
  //
  // Règle complétée : une échéance absente n'était reposée que pour l'état
  // INCOMPLETE_RETRYABLE. Un document VERIFICATION_INCOMPLETE pour une cause
  // TRANSITOIRE (`source_unreadable`) dont il reste des tentatives a pourtant
  // une action `REQUEUE_T1` réellement admissible : après un ancien refus qui
  // avait effacé son échéance, il restait sans échéance — donc jamais repris,
  // alors que la règle commune autorisait l'action. Ce cas est ajouté.
  //
  // Ce qui N'EST PAS programmé, délibérément (pas de relance de masse) : une
  // image ou un scan NON VÉRIFIABLE dont une observation visuelle reste
  // incertaine. Une relecture du fichier y est bien « admissible » au sens des
  // bornes, mais elle ne peut apporter aucune preuve nouvelle sur une source
  // que la vérification a déclarée non contrôlable : l'incertitude est
  // CONSERVÉE, sans alerte de réparation non actionnable ni relances
  // périodiques identiques. Une telle relecture reste possible à la demande.
  // Au-delà des bornes, aucune action n'est admissible : aucune boucle.
  // ══════════════════════════════════════════════════════════════════════
  const programmable = report.qualityState === 'INCOMPLETE_RETRYABLE'
    || (faitsReprise.transientVerification && regle.actions.includes('REQUEUE_T1'));
  const prochaine = !regle.automatic ? null
    : programmeeAvant ? new Date(cov.nextRetryAt!)
      : programmable ? new Date(Date.now() + 15 * 60_000) : null;
  const anomaliesAvant = [...(cov.anomalies ?? [])].sort();
  const anomaliesApres = [...report.anomalies].sort();
  const stateChanged = report.qualityState !== cov.qualityState || anomaliesAvant.join('|') !== anomaliesApres.join('|')
    || programmeeAvant !== (prochaine !== null);
  // Carte #837 (D1) : une reprise NOUVELLEMENT programmée par une campagne de réévaluation porte la référence de
  // la campagne — la suite exécutée s'y rattache EXPLICITEMENT (jamais par simple proximité de dates).
  if (report.diagnostics && prochaine !== null && !programmeeAvant && p.origin.startsWith('t1-coverage-reassessment:')) {
    (report.diagnostics as T1CoverageDiagnostics & { scheduledBy?: Record<string, unknown> }).scheduledBy = { origin: p.origin, at: new Date().toISOString() };
  }
  const retry = {
    anomaliesBefore: anomaliesAvant, anomaliesAfter: anomaliesApres, scheduledBefore: programmeeAvant, scheduledAfter: prochaine !== null,
    pendingReleased, actions: [...regle.actions], blocked: regle.blocked, stateChanged,
  };
  if (requalified.length === 0 && !politiquesChangees && !stateChanged) return { outcome: 'UNCHANGED', requalified, before, after: before, retry };
  if (!p.apply) return { outcome: 'SIMULATED', requalified, before, after, retry };

  await pgClient.begin(async (tx) => {
    // ══════════════════════════════════════════════════════════════════
    // CARTE #837 (B4) — CONTRÔLE DE VERSION DES PREUVES AVANT TOUTE ÉCRITURE
    // Une preuve (fait, décision, candidat, cellule, ancrage, texte) changée
    // depuis la lecture, même sans réécriture de la couverture, fait refuser
    // l'écriture : relecture et recalcul (une fois), puis report explicite
    // (`CONFLICT_DEFERRED`). Jamais un état calculé sur des preuves périmées.
    // ══════════════════════════════════════════════════════════════════
    if (preuvesLues) {
      const maintenant = await loadEvidenceDependencies(tx as unknown as Sql, p.accountId, p.fileId);
      if (maintenant.fingerprint !== preuvesLues.fingerprint) {
        const { CoverageVersionConflictError: Conflit } = await import('./repository');
        throw new Conflit(p.fileId, `preuves ${preuvesLues.fingerprint}`, `preuves ${maintenant.fingerprint}`);
      }
    }
    await writeSourceLayer(tx as never, {
      accountId: p.accountId, fileId: p.fileId, extractionId: cov.extractionId ?? null, origin: 'RETRY',
      layer: { layerVersion: SOURCE_LAYER_VERSION, units: majs, unresolvedFacts: unresolved, report, retryable: report.qualityState === 'INCOMPLETE_RETRYABLE' },
      retryAttempts: cov.retryAttempts,
      nextRetryAt: prochaine,
      retryResult: requalified.length > 0 ? `RECONCILED_${requalified.length}` : politiquesChangees ? 'RECONCILED_POLICIES' : 'RECONCILED_STATE',
      // Lot 115H (#785, § 4) : la version LUE au début de ce recalcul — l'écriture est refusée si la couche a changé.
      expectUpdatedAt: cov.updatedAt ?? null,
    });
  });
  console.info(`[t1-reconciliation] fichier ${p.fileId} (${p.origin}) : ${requalified.length} unité(s) requalifiée(s), `
    + `${before.qualityState} → ${after.qualityState}`);
  return { outcome: 'APPLIED', requalified, before, after, retry };
}
