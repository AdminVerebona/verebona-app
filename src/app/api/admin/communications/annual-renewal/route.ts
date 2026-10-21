/**
 * POST /api/admin/communications/annual-renewal — rappel J−7 des abonnements
 * annuels : opérations d'exploitation SANS SQL (lot 72F, ticket P1
 * « Fiabiliser le rappel J−7 »). L'état se lit par
 * `GET /api/admin/communications/email-logs?annualRenewal=1`.
 *
 * Corps (un seul `action`) :
 *   · `{ action: 'declare', disabledAt }` — instant (ISO) où « e-mails
 *     concernant les renouvellements à venir » a été DÉSACTIVÉ dans Stripe ;
 *     sans cette déclaration, aucun rappel Verebona n'est préparé ni envoyé ;
 *   · `{ action: 'rollback' }` — retour aux rappels Stripe : tâche suspendue
 *     exigée (409 sinon) ; ouvre la phase « retour arrière en cours » (lot
 *     76D) : demandes jamais transmises neutralisées, appels engagés et
 *     acceptations incertaines CONSERVÉS pour qualification, bascule retirée ;
 *   · `{ action: 'rollback-check' }` — contrôle immédiat de la phase (le même
 *     contrôle tourne chaque minute dans `transactional-emails-retry`) ;
 *   · `{ action: 'rollback-finalize', acknowledgeNotified }` — fin du retour
 *     arrière : refusée tant qu'un appel est en cours / à qualifier ou qu'une
 *     incertitude n'est pas arbitrée ; échéances déjà notifiées par Verebona :
 *     arbitrage explicite exigé. Réactiver les rappels Stripe SEULEMENT après ;
 *   · `{ action: 'coverage', key, decision: 'STRIPE_CONFIRMED' | 'SEND_VEREBONA' }`
 *     — échéance à couverture incertaine (bascule) ;
 *   · `{ action: 'job', jobId, decision: 'RECHECK' | 'CONFIRM_SENT' | 'REISSUE' | 'ABANDON' }`
 *     — acceptation Resend incertaine non résolue (après examen du tableau de
 *     bord Resend).
 * Administrateurs seulement ; chaque opération est journalisée
 * (`ANNUAL_RENEWAL_OPERATION`). Aucun secret ni lien Stripe renvoyé.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';

const bad = (message: string, status = 400, code = 'INVALID_BODY') => NextResponse.json({ code, message }, { status });

export async function POST(request: NextRequest) {
  let adminId: number;
  try {
    adminId = await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const action = typeof body?.action === 'string' ? body.action : '';
  const audit = async (result: 'SUCCESS' | 'FAILURE', details: Record<string, unknown>, targetId: number | null = null) => {
    await logAdminAction({ adminId, action: 'ANNUAL_RENEWAL_OPERATION', targetType: 'ANNUAL_RENEWAL', targetId, result, details: { action, ...details } });
  };
  try {
    const svc = await import('@/services/billing/annual-renewal-reminder.service');
    if (action === 'declare') {
      const at = typeof body?.disabledAt === 'string' ? new Date(body.disabledAt) : null;
      if (!at || Number.isNaN(at.getTime())) return bad('Indiquez la date et l’heure de désactivation des rappels Stripe.');
      const r = await svc.declareStripeRemindersDisabled({ adminId, disabledAt: at });
      await audit(r.ok ? 'SUCCESS' : 'FAILURE', r.ok ? { disabledAt: at.toISOString(), coverageFrom: r.coverageFrom } : { code: r.code });
      if (!r.ok) {
        const msg = r.code === 'ALREADY_DECLARED' ? 'La bascule est déjà déclarée (retour arrière d’abord pour la redéclarer).'
          : r.code === 'ROLLBACK_IN_PROGRESS' ? 'Retour aux rappels Stripe en cours : terminez-le avant de déclarer une nouvelle bascule.'
          : r.code === 'IN_FUTURE' ? 'La désactivation ne peut pas être déclarée dans le futur : désactivez d’abord les rappels dans Stripe.'
            : 'Date invalide.';
        return bad(msg, 409, r.code);
      }
      return NextResponse.json({ success: true, coverageFrom: r.coverageFrom });
    }
    if (action === 'rollback') {
      const r = await svc.rollbackToStripeReminders({ adminId });
      await audit(r.ok ? 'SUCCESS' : 'FAILURE', r.ok ? { ...r.result } : { code: r.code });
      if (!r.ok) return bad('Suspendez d’abord la tâche « Abonnements annuels : rappel à J−7 » (BO › Exploitation › Tâches planifiées).', 409, r.code);
      return NextResponse.json({ success: true, result: r.result });
    }
    if (action === 'rollback-check') {
      const r = await svc.advanceAnnualRenewalRollback({ deadline: Date.now() + 20_000 });
      await audit('SUCCESS', { phase: r.phase, checked: r.checked, blockers: r.blockers.length });
      return NextResponse.json({ success: true, result: r });
    }
    if (action === 'rollback-finalize') {
      const acknowledgeNotified = body?.acknowledgeNotified === true;
      const r = await svc.finalizeAnnualRenewalRollback({ adminId, acknowledgeNotified });
      await audit(r.ok ? 'SUCCESS' : 'FAILURE', r.ok ? { acknowledgeNotified, notified: r.result.notified } : { code: r.code, acknowledgeNotified });
      if (!r.ok) {
        const msg = r.code === 'NOT_IN_PROGRESS' ? 'Aucun retour arrière en cours.'
          : r.code === 'BLOCKED' ? 'Retour arrière non terminé : des envois sont en cours, à vérifier ou d’acceptation incertaine (voir « Éléments à résoudre »).'
            : 'Des échéances ont déjà reçu le rappel Verebona : confirmez l’arbitrage (Stripe peut envoyer son propre rappel après réactivation).';
        return NextResponse.json({ code: r.code, message: msg, result: r.result ?? null }, { status: 409 });
      }
      return NextResponse.json({ success: true, result: r.result });
    }
    if (action === 'coverage') {
      const key = typeof body?.key === 'string' ? body.key.slice(0, 300) : '';
      const decision = body?.decision === 'STRIPE_CONFIRMED' || body?.decision === 'SEND_VEREBONA' ? body.decision : null;
      if (!key || !decision) return bad('Échéance et décision (STRIPE_CONFIRMED ou SEND_VEREBONA) attendues.');
      const r = await svc.resolveCoverageUncertain({ key, decision, adminId });
      await audit(r.ok ? 'SUCCESS' : 'FAILURE', r.ok ? { key, decision, outcome: r.outcome, jobId: r.jobId ?? null } : { key, decision, code: r.code, reason: r.reason ?? null });
      if (!r.ok) {
        return bad(r.code === 'NOT_ELIGIBLE' ? `Rappel impossible : ${r.reason ?? 'abonnement non éligible'}.`
          : r.code === 'SWITCH_NOT_DECLARED' ? 'Bascule non déclarée (ou retour aux rappels Stripe) : aucun rappel Verebona ne peut être préparé.'
            : 'Échéance introuvable ou déjà traitée.', 409, r.code);
      }
      return NextResponse.json({ success: true, outcome: r.outcome, jobId: r.jobId ?? null });
    }
    if (action === 'job') {
      const { EMAIL_JOB_DECISIONS, decideUncertainEmailJob } = await import('@/services/email/transactional-email-jobs.service');
      const jobId = Number(body?.jobId);
      const decision = EMAIL_JOB_DECISIONS.find((d) => d === body?.decision);
      if (!Number.isInteger(jobId) || jobId <= 0 || !decision) return bad('Demande et décision (RECHECK, CONFIRM_SENT, REISSUE ou ABANDON) attendues.');
      const r = await decideUncertainEmailJob(jobId, decision);
      await audit(r.ok ? 'SUCCESS' : 'FAILURE', r.ok ? { decision, status: r.status } : { decision, code: r.code }, jobId);
      if (!r.ok) {
        return bad(r.code === 'NEUTRALIZED'
          ? 'Demande neutralisée par le retour aux rappels Stripe : aucune réémission (« Vérifier de nouveau », « Trouvé chez Resend » ou « Abandonner »).'
          : 'Demande introuvable ou plus en « acceptation incertaine ».', 409, r.code);
      }
      return NextResponse.json({ success: true, status: r.status });
    }
    return bad('Action attendue : declare, rollback, rollback-check, rollback-finalize, coverage ou job.');
  } catch (error) {
    console.error('[admin/communications/annual-renewal] POST :', (error as Error)?.message ?? error);
    await audit('FAILURE', { code: 'ANNUAL_RENEWAL_OPERATION_FAILED' });
    return NextResponse.json({ code: 'ANNUAL_RENEWAL_OPERATION_FAILED', message: 'Opération non effectuée (Stripe ou base indisponible) : réessayez.' }, { status: 500 });
  }
}
