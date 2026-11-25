/**
 * POST /api/admin/ai/t1-completeness/retry — lot 53 (retour PO D19).
 *
 * Reprise MANUELLE d'un document en « vérification incomplète » depuis
 * BO › Exécutions IA › Complétude T1 : le document repasse dans la file T1
 * (relecture du fichier, traitement technique non facturé et non annoncé à
 * l'utilisateur). Tracée sur la ligne de couverture (dernière reprise :
 * `REQUEUED_T1_ADMIN`) et dans le journal. Corps : `{ fileId }`.
 * Refus : document inconnu (404), autre état que VERIFICATION_INCOMPLETE (409).
 * Lot 114H (Trello #775, P1-B) : mise en file NON confirmée par la file T1
 * (compte non éligible, refus transitoire ou définitif) → 409 `NOT_QUEUED` avec
 * le statut réel ; un travail déjà vivant est rendu `alreadyRunning`.
 *
 * Lot 84D (CDC Pilotage IA V2 BO-03, BO-10) : même reprise depuis le détail
 * d'une exécution métier — `businessExecutionId` optionnel ; journalisée
 * (`AI_EXECUTION_RELAUNCH` : acteur, document, exécution d'origine). La
 * reprise CONTINUE l'exécution (même identité, R22).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';
import { parseExecutionId } from '@/services/ai/business-execution/identity';
import { logAdminAction } from '@/lib/admin-audit';

/** Lot 114H (#775) : message d'une remise en file NON confirmée (textes nouveaux, à valider par le PO). */
const REQUEUE_REFUSAL_MESSAGE: Record<string, string> = {
  ACCOUNT_NOT_ELIGIBLE: 'Analyse non relancée : le compte n’est pas éligible au traitement.',
  REJECTED_TRANSIENT: 'Analyse non relancée : la file d’analyse a refusé la demande (erreur passagère). Réessayer dans quelques minutes.',
  REJECTED_FINAL: 'Analyse non relancée : la file d’analyse a refusé la demande (refus définitif). Voir la Supervision.',
  // Lot 115H (#785, § 1) : refus par la règle commune des reprises, AVANT tout enfilement (textes nouveaux,
  // à valider par le PO). Aucune reprise n'a été consommée et aucun travail n'a été créé.
  NOT_ADMISSIBLE: 'Analyse non relancée : ce document n’a plus de reprise disponible (plafond atteint ou reprises désactivées). Aucune reprise n’a été consommée.',
  // Lot 115H (#785, § 2) : demande identique déjà servie par une analyse terminée, aucune preuve nouvelle depuis
  // (texte nouveau, à valider par le PO).
  ALREADY_SATISFIED: 'Analyse non relancée : cette demande a déjà été traitée et rien n’a changé depuis (même fichier, mêmes preuves). Aucune reprise n’a été consommée.',
  // Carte #837 (A3) : la MÊME demande est en cours de traitement par une autre exécution (planificateur, autre clic).
  IDENTICAL_REQUEST_IN_PROGRESS: 'Analyse non relancée : la même demande est déjà en cours de traitement (autre exécution). Aucune reprise n’a été consommée.',
  // Carte #837 (A2) : travail déjà terminé au moment du contrôle, en échec MÉTIER.
  COMPLETED: 'Analyse relancée puis terminée en échec métier : la lacune n’est pas réparée. Voir la Supervision.',
};
/** Motif précis du refus de la règle commune (affiché après le message). */
const NOT_ADMISSIBLE_REASON: Record<string, string> = {
  RETRIES_DISABLED: 'Les reprises automatiques sont désactivées par le paramétrage.',
  RETRY_CAP_REACHED: 'Le plafond de reprises de ce document est atteint.',
  // Carte #837 (A1, A3) : motifs du point d'admission commun (textes nouveaux, à valider par le PO).
  SOURCE_NOT_AVAILABLE: 'Le fichier source est absent ou supprimé : il ne peut pas être relu.',
  NOTHING_TO_RETRY: 'Le document est complet : aucune action utile.',
  ACCOUNT_NOT_ELIGIBLE: 'Le compte n’est pas éligible au traitement ; la demande repartira à sa réactivation.',
  AI_TREATMENT_BLOCKED: 'Le traitement T1 est suspendu ou arrêté (exploitation IA).',
  ACCOUNT_AI_BUDGET_REACHED: 'Le plafond de coût IA du compte est atteint pour la période.',
  IDENTITY_UNAVAILABLE: 'Identité des demandes indisponible (migrations 1805 / 1970 non appliquées) : remise en file refusée par sécurité.',
};

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const body = (await req.json().catch(() => null)) as { fileId?: unknown; businessExecutionId?: unknown } | null;
  const fileId = Number(body?.fileId);
  const executionId = typeof body?.businessExecutionId === 'string' && parseExecutionId(body.businessExecutionId) ? body.businessExecutionId : null;
  if (!Number.isSafeInteger(fileId) || fileId <= 0) {
    return NextResponse.json({ error: 'INVALID_BODY', message: '`fileId` (entier) est requis.' }, { status: 400 });
  }
  try {
    const { sourceLayerReady } = await import('@/services/ai/source-analysis/source-units/repository');
    if (!(await sourceLayerReady())) return NextResponse.json({ error: 'UNAVAILABLE', message: 'Couche de couverture absente.' }, { status: 409 });
    const { pgClient } = await import('@/db');
    const [row] = (await pgClient.unsafe(
      `SELECT c.account_id, c.quality_state, c.retry_attempts FROM document_extraction_coverage c
         JOIN asset_files af ON af.id = c.file_id AND af.deleted_at IS NULL
        WHERE c.file_id = $1`,
      [fileId] as never[],
    )) as unknown as Array<{ account_id: number; quality_state: string; retry_attempts: number }>;
    if (!row) return NextResponse.json({ error: 'NOT_FOUND', message: 'Document introuvable.' }, { status: 404 });
    if (row.quality_state !== 'VERIFICATION_INCOMPLETE') {
      return NextResponse.json({ error: 'NOT_APPLICABLE', message: 'Reprise réservée aux vérifications incomplètes.' }, { status: 409 });
    }
    // Lot 114H (#775, P1-B) : l'issue RÉELLE de la file est rendue — plus de « ok » pour une mise en file refusée.
    const { requeueDocumentForRereadDetailed } = await import('@/services/ai/source-analysis/source-units/jobs');
    const r = await requeueDocumentForRereadDetailed({
      fileId, accountId: Number(row.account_id), attempt: Number(row.retry_attempts ?? 0) + 1,
      origin: 't1-completeness-retry', result: 'REQUEUED_T1_ADMIN',
      // Lot 115H (#785, § 1) : la relance complète du BO passe par la MÊME règle de droit que les autres
      // origines — aucun contournement implicite par cette route.
      requestedBy: 'BO',
    });
    await logAdminAction({
      adminId: guard.ctx.adminUserId, action: 'AI_EXECUTION_RELAUNCH', targetType: 'AI_EXECUTION', targetId: fileId, result: r.queued || (r.status === 'COMPLETED' && (r.businessResult === 'APPLIED' || r.businessResult === 'NO_CHANGE')) ? 'SUCCESS' : 'FAILURE',
      details: {
        kind: 't1-completeness-retry', fileId, businessExecutionId: executionId, queued: r.queued, status: r.status, reason: r.reason, jobId: r.jobId,
        ...(r.businessResult !== undefined ? { businessResult: r.businessResult } : {}), ...(r.traceErrors ? { traceErrors: r.traceErrors } : {}),
      },
    });
    console.info(`[t1-completeness] reprise manuelle du document ${fileId} par l'administrateur ${guard.ctx.adminUserId} : ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
    if (!r.queued) {
      // Lot 115H (#785, § 1) : un refus de la règle commune est distinct d'un refus de la file — il dit son motif
      // et garantit qu'aucune reprise n'a été consommée.
      // Carte #837 (A2) : un travail déjà terminé AVEC succès métier n'est pas un refus.
      if (r.status === 'COMPLETED' && (r.businessResult === 'APPLIED' || r.businessResult === 'NO_CHANGE')) {
        return NextResponse.json({ ok: true, queued: false, completed: true, status: r.status, businessResult: r.businessResult, jobId: r.jobId });
      }
      const plafond = r.reason === 'RETRIES_DISABLED' || r.reason === 'RETRY_CAP_REACHED';
      const message = r.status === 'NOT_ADMISSIBLE'
        ? `${plafond ? REQUEUE_REFUSAL_MESSAGE.NOT_ADMISSIBLE : 'Analyse non relancée. Aucune reprise n’a été consommée.'}${r.reason && NOT_ADMISSIBLE_REASON[r.reason] ? ` ${NOT_ADMISSIBLE_REASON[r.reason]}` : ''}`
        : REQUEUE_REFUSAL_MESSAGE[r.status] ?? 'Mise en file refusée.';
      return NextResponse.json({
        ok: false, queued: false, status: r.status, reason: r.reason, attemptConsumed: r.attemptConsumed,
        error: r.status === 'NOT_ADMISSIBLE' ? 'NOT_ADMISSIBLE' : r.status === 'ALREADY_SATISFIED' ? 'ALREADY_SATISFIED'
          : r.status === 'IDENTICAL_REQUEST_IN_PROGRESS' ? 'IN_PROGRESS' : r.status === 'COMPLETED' ? 'BUSINESS_FAILED' : 'NOT_QUEUED', message,
        ...(r.businessResult !== undefined ? { businessResult: r.businessResult } : {}),
      }, { status: 409 });
    }
    return NextResponse.json({
      ok: true, queued: true, status: r.status,
      // Lot 115H (#785, § 2) : une demande identique CONSTATE le travail vivant — jamais un second passage.
      alreadyRunning: r.status === 'ALREADY_RUNNING' || r.status === 'IDENTICAL_REQUEST_ALIVE', jobId: r.jobId,
    });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/t1-completeness/retry');
  }
}
