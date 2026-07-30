/**
 * POST /api/admin/withdrawals/{reference}/actions — CDC 6 §16, §17 et §18.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUNE ACTION NE RÉÉCRIT L'HISTOIRE
 *
 * Le §18 l'exige : « les corrections administratives doivent être ajoutées
 * sous forme d'événements complémentaires ». Chaque action ci-dessous écrit
 * donc un événement AVANT de modifier l'état courant, et n'efface jamais
 * l'événement précédent.
 *
 * Un motif est obligatoire pour toute action qui change le sort de la demande.
 * Un administrateur qui rejette une rétractation engage Verebona : sans motif
 * consigné, la décision serait indéfendable.
 *
 * ── CE QUI N'EST PAS PROPOSÉ ──────────────────────────────────────────────
 *
 * Aucune action ne permet de modifier la déclaration, son horodatage ou ses
 * instantanés. Le déclencheur de la migration 0117 l'interdirait de toute
 * façon, mais l'interface ne doit pas même le suggérer : une demande de
 * rétractation est un acte juridique unilatéral, elle ne se corrige pas.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db, ensureMigrations } from '@/db';
import { withdrawalRequests } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getByPublicReference } from '@/services/withdrawal/withdrawal.service';
import { recordWithdrawalEvent } from '@/services/withdrawal/withdrawal-journal.service';
import { processWithdrawal } from '@/services/withdrawal/withdrawal-processor.service';

type Action = 'retry' | 'note' | 'manual_refund' | 'reject' | 'force_review';

const ACTIONS_REQUIRING_REASON: Action[] = ['manual_refund', 'reject', 'force_review'];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ reference: string }> },
) {
  let adminId: number;
  try {
    adminId = await SessionService.requireAdmin(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  const { reference } = await params;
  await ensureMigrations();

  const request = await getByPublicReference(reference);
  if (!request) {
    return NextResponse.json({ error: 'Demande introuvable.', code: 'NOT_FOUND' }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Corps de requête invalide.', code: 'BAD_REQUEST' }, { status: 400 });
  }

  const action = body.action as Action;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

  if (ACTIONS_REQUIRING_REASON.includes(action) && reason.length < 5) {
    return NextResponse.json(
      {
        error: 'Un motif est obligatoire pour cette action. Il sera consigné au journal.',
        code: 'REASON_REQUIRED',
      },
      { status: 400 },
    );
  }

  switch (action) {
    // ── Relance du traitement (§17.1) ──────────────────────────────────────
    case 'retry': {
      await recordWithdrawalEvent({
        publicReference: reference,
        eventType: 'ADMIN_RETRY',
        actorUserId: adminId,
        summary: `Relance manuelle du traitement${reason ? ` — ${reason}` : ''}.`,
      });
      const result = await processWithdrawal(reference);
      return NextResponse.json({ action, result });
    }

    // ── Remboursement effectué hors Stripe (§17.3) ─────────────────────────
    // « Prévoir une voie de remboursement alternative conforme » : virement,
    // chèque. L'opération n'a pas lieu ici, elle y est CONSIGNÉE.
    case 'manual_refund': {
      const amount = Number(body.amount);
      if (!Number.isInteger(amount) || amount <= 0) {
        return NextResponse.json(
          { error: 'Montant invalide (centimes, entier positif).', code: 'INVALID_AMOUNT' },
          { status: 400 },
        );
      }
      const total = request.amountRefunded + amount;
      if (request.amountExpected !== null && total > request.amountExpected) {
        // La contrainte en base le refuserait ; l'expliquer ici évite un 500.
        return NextResponse.json(
          {
            error: `Le total remboursé (${total}) dépasserait le montant attendu (${request.amountExpected}).`,
            code: 'AMOUNT_EXCEEDS_EXPECTED',
          },
          { status: 400 },
        );
      }

      await recordWithdrawalEvent({
        publicReference: reference,
        eventType: 'ADMIN_MANUAL_REFUND',
        actorUserId: adminId,
        summary: `Remboursement hors Stripe de ${amount} centimes consigné — ${reason}`,
        payload: { amount, method: body.method ?? 'non précisé' },
      });

      const completed =
        request.amountExpected !== null &&
        total >= request.amountExpected &&
        ['cancelled', 'not_applicable'].includes(request.cancellationStatus);

      await db
        .update(withdrawalRequests)
        .set({
          amountRefunded: total,
          status: completed ? 'completed' : request.status,
          failureCode: null,
          failureDetails: null,
        })
        .where(eq(withdrawalRequests.publicReference, reference));

      return NextResponse.json({ action, amountRefunded: total, completed });
    }

    // ── Refus après examen (§5.5) ──────────────────────────────────────────
    // Le seul chemin vers `rejected`. Il n'est jamais automatique : « aucun
    // motif de refus définitif n'est affiché avant examen ».
    case 'reject': {
      await recordWithdrawalEvent({
        publicReference: reference,
        eventType: 'ADMIN_REJECTED',
        actorUserId: adminId,
        result: 'info',
        summary: `Demande non retenue après examen — ${reason}`,
      });
      await db
        .update(withdrawalRequests)
        .set({ status: 'rejected' })
        .where(eq(withdrawalRequests.publicReference, reference));
      return NextResponse.json({ action, status: 'rejected' });
    }

    // ── Mise en examen manuel (§17.5) ──────────────────────────────────────
    // Notamment pour un paiement contesté : « ne pas refuser automatiquement
    // la rétractation, éviter un double remboursement, passer en examen ».
    case 'force_review': {
      await recordWithdrawalEvent({
        publicReference: reference,
        eventType: 'ADMIN_STATUS_CHANGED',
        actorUserId: adminId,
        summary: `Passage en examen manuel — ${reason}`,
        payload: { from: request.status, to: 'manual_review' },
      });
      await db
        .update(withdrawalRequests)
        .set({ status: 'manual_review' })
        .where(eq(withdrawalRequests.publicReference, reference));
      return NextResponse.json({ action, status: 'manual_review' });
    }

    // ── Note libre ─────────────────────────────────────────────────────────
    case 'note': {
      if (!reason) {
        return NextResponse.json({ error: 'Note vide.', code: 'EMPTY_NOTE' }, { status: 400 });
      }
      await recordWithdrawalEvent({
        publicReference: reference,
        eventType: 'ADMIN_NOTE',
        actorUserId: adminId,
        result: 'info',
        summary: reason,
      });
      return NextResponse.json({ action, recorded: true });
    }

    default:
      return NextResponse.json({ error: 'Action inconnue.', code: 'UNKNOWN_ACTION' }, { status: 400 });
  }
}
