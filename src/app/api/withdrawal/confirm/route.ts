/**
 * POST /api/withdrawal/confirm — CDC 6 §7.4 et §12.4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'ORDRE DES OPÉRATIONS EST LE CŒUR DE CETTE ROUTE
 *
 *   1. authentifier — session, ou jeton public vérifié ;
 *   2. recalculer l'éligibilité (§12.4) — l'état a pu changer depuis
 *      l'affichage du récapitulatif ;
 *   3. écrire la déclaration, avec son horodatage et ses instantanés ;
 *   4. répondre au consommateur avec sa référence ;
 *   5. envoyer l'accusé de réception.
 *
 * Le §7.4 exige que « la déclaration soit considérée comme reçue,
 * indépendamment du résultat immédiat des appels Stripe » : la déclaration
 * est écrite et l'accusé envoyé AVANT tout appel Stripe.
 *
 * LOT 32 (décisions PO du 07/10/2026, Q1/Q2) : traitement IMMÉDIAT. Juste
 * après l'accusé (qui est aussi l'e-mail d'au revoir), `processWithdrawal`
 * coupe les accès, annule l'abonnement, rembourse intégralement et supprime
 * le compte. La réponse attend ce traitement dans une limite de temps
 * (`PROCESSING_BUDGET_MS`) ; au-delà, il continue en arrière-plan et le
 * balayage planifié le reprend en cas d'échec — sans action manuelle.
 * Plus d'examen manuel : une éligibilité négative est refusée avec son motif
 * (409), une éligibilité indéterminable (panne) est refusée temporairement
 * (503, « réessayez ») — jamais de suppression de compte sur un doute.
 *
 * La protection CSRF exigée au §12.4 est assurée par le middleware, qui
 * contrôle l'origine de toute requête mutante.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { evaluateEligibility, ineligibilityMessage } from '@/services/withdrawal/eligibility.service';
import { buildSummary } from '@/services/withdrawal/summary.service';
import { findByIdempotencyKey, recordDeclaration, WithdrawalError } from '@/services/withdrawal/withdrawal.service';
import {
  resolveVerificationToken,
  consumeVerificationToken,
  recordFailedAttempt,
} from '@/services/withdrawal/public-verification.service';
import { sendWithdrawalReceipt } from '@/services/withdrawal/receipt.service';
import { processWithdrawal } from '@/services/withdrawal/withdrawal-processor.service';

/** Temps d'attente du traitement immédiat avant de répondre (le reste continue en arrière-plan). */
const PROCESSING_BUDGET_MS = 20_000;

interface Caller {
  userId: number;
  accountId: number;
  channel: 'authenticated' | 'public';
  tokenId?: number;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}

export async function POST(req: NextRequest) {
  await ensureMigrations();

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Corps de requête invalide.', code: 'BAD_REQUEST' }, { status: 400 });
  }

  const publicToken = typeof body.token === 'string' ? body.token : null;
  let caller: Caller;

  // Double soumission (double clic, rechargement) : la déclaration existe déjà
  // sous cette clé — restituée telle quelle, même si le premier envoi a déjà
  // supprimé le compte (lot 32). La clé est tirée au hasard par la page ;
  // la réponse ne contient que la référence et l'horodatage.
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null;
  const deja = await findByIdempotencyKey(idempotencyKey);
  if (deja) {
    return NextResponse.json({
      publicReference: deja.publicReference,
      status: deja.status,
      requestedAt: deja.requestedAt.toISOString(),
      accountDeletion: 'immediate',
      alreadyRecorded: true,
    }, { status: 200 });
  }

  if (publicToken) {
    const resolved = await resolveVerificationToken(publicToken);
    if ('failure' in resolved) {
      await recordFailedAttempt(publicToken);
      return NextResponse.json(
        {
          error: 'Ce lien de vérification n’est plus valable. Demandez-en un nouveau.',
          code: resolved.failure,
        },
        { status: 400 },
      );
    }
    caller = {
      userId: resolved.identity.userId,
      accountId: resolved.identity.accountId,
      channel: 'public',
      tokenId: resolved.identity.tokenId,
      firstName: resolved.identity.firstName,
      lastName: resolved.identity.lastName,
      email: resolved.identity.email,
    };
  } else {
    let session;
    try {
      session = await SessionService.getSession(req);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    if (!session.currentAccountId) {
      return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });
    }
    caller = {
      userId: session.userId,
      accountId: session.currentAccountId,
      channel: 'authenticated',
    };
  }

  // §12.4 : l'éligibilité est RECALCULÉE, jamais reprise du récapitulatif.
  // Entre l'affichage et la confirmation, le délai a pu expirer ou une
  // première demande avoir été enregistrée dans un autre onglet.
  const eligibility = await evaluateEligibility(caller.userId, caller.accountId);

  // Lot 26 : hors délai, la déclaration est REFUSÉE (409), plus enregistrée en
  // examen manuel. L'expiration du délai n'est pas une anomalie (§5.5 vise
  // l'éligibilité indéterminable, qui reste enregistrée) : c'est un fait
  // calculé, par la même fonction que l'affichage (`isWithdrawalWindowOpen`).
  if (eligibility.verdict === 'ineligible' && eligibility.reason === 'DEADLINE_PASSED') {
    return NextResponse.json(
      { error: ineligibilityMessage('DEADLINE_PASSED'), code: 'WITHDRAWAL_WINDOW_CLOSED' },
      { status: 409 },
    );
  }

  // Double soumission (autre onglet, double clic) : la demande existe déjà,
  // elle est restituée telle quelle — aucune seconde déclaration.
  if (eligibility.verdict === 'ineligible' && eligibility.reason === 'ALREADY_WITHDRAWN' && eligibility.existingRequest) {
    return NextResponse.json({
      publicReference: eligibility.existingRequest.publicReference,
      status: eligibility.existingRequest.status,
      requestedAt: eligibility.existingRequest.requestedAt.toISOString(),
      accountDeletion: 'immediate',
      alreadyRecorded: true,
    }, { status: 200 });
  }

  // Lot 32 (PO-Q2) : plus d'examen manuel. Inéligible → motif (409).
  if (eligibility.verdict === 'ineligible') {
    return NextResponse.json(
      { error: ineligibilityMessage(eligibility.reason ?? 'NO_PAID_CONTRACT'), code: `WITHDRAWAL_${eligibility.reason ?? 'INELIGIBLE'}` },
      { status: 409 },
    );
  }
  // Indéterminable (panne de lecture) → rien n'est enregistré ni supprimé.
  if (eligibility.verdict !== 'eligible') {
    console.error('[withdrawal] éligibilité indéterminable :', eligibility.diagnostic ?? 'motif inconnu');
    return NextResponse.json(
      {
        error: 'Votre demande ne peut pas être traitée pour le moment. Réessayez dans quelques minutes ; ' +
          'si le problème persiste, écrivez-nous : votre droit reste préservé.',
        code: 'WITHDRAWAL_TEMPORARILY_UNAVAILABLE',
      },
      { status: 503 },
    );
  }
  const summary = await buildSummary(eligibility, {
    userId: caller.userId,
    firstName: caller.firstName,
    lastName: caller.lastName,
    email: caller.email,
  });

  const firstName = String(body.firstName ?? summary.firstName ?? '').trim();
  const lastName = String(body.lastName ?? summary.lastName ?? '').trim();
  const receiptEmail = String(body.receiptEmail ?? summary.email ?? '').trim();

  if (!firstName || !lastName || !receiptEmail) {
    return NextResponse.json(
      { error: 'Nom, prénom et adresse de réception sont nécessaires.', code: 'MISSING_IDENTITY' },
      { status: 400 },
    );
  }

  try {
    const declaration = await recordDeclaration({
      userId: caller.userId,
      accountId: caller.accountId,
      channel: caller.channel,
      firstName,
      lastName,
      receiptEmail,
      eligibility,
      displayedSummary: summary as unknown as Record<string, unknown>,
      amountExpected: summary.amountExpected,
      idempotencyKey,
    });

    // Le jeton n'est consommé qu'ici : le consommateur a pu relire et revenir
    // en arrière autant qu'il le souhaitait avant de confirmer.
    if (caller.tokenId) await consumeVerificationToken(caller.tokenId);

    // Accusé de réception (§8). Son échec ne remet pas la déclaration en
    // cause : le §18 des CGVU et le §10 d'ici disent la même chose — la
    // preuve reste valide, le message est retenté.
    if (!declaration.alreadyRecorded) {
      await sendWithdrawalReceipt({
        publicReference: declaration.publicReference,
        to: receiptEmail,
        userId: caller.userId,
        firstName,
        lastName,
        requestedAt: declaration.requestedAt,
        summary,
      });
    }

    // ── Traitement IMMÉDIAT, APRÈS l'accusé de réception (lot 32) ─────────
    //
    // Accès coupés, annulation, remboursement intégral, suppression du
    // compte. Attendu au plus `PROCESSING_BUDGET_MS` : la réponse ne dépend
    // pas de Stripe (§7.4) — passé ce délai, le traitement se poursuit et le
    // balayage reprend tout échec.
    let processing: 'done' | 'pending' = 'pending';
    if (declaration.status === 'received' || declaration.status === 'processing' || declaration.status === 'failed') {
      const traitement = processWithdrawal(declaration.publicReference)
        .then(() => 'done' as const)
        .catch((e) => {
          console.error(
            `[withdrawal] traitement immédiat de ${declaration.publicReference} :`,
            (e as Error).message,
          );
          return 'pending' as const;
        });
      processing = await Promise.race([
        traitement,
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), PROCESSING_BUDGET_MS).unref?.()),
      ]);
    }

    return NextResponse.json(
      {
        publicReference: declaration.publicReference,
        status: declaration.status,
        // Enregistré en UTC, affiché en heure de Paris par le client (§7.4).
        requestedAt: declaration.requestedAt.toISOString(),
        // Lot 32 : compte supprimé immédiatement (plus de délai d'export).
        accountDeletion: 'immediate',
        processing,
        alreadyRecorded: declaration.alreadyRecorded,
      },
      { status: declaration.alreadyRecorded ? 200 : 201 },
    );
  } catch (e) {
    if (e instanceof WithdrawalError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 409 });
    }
    console.error('[withdrawal] confirmation impossible :', (e as Error).message);
    return NextResponse.json(
      { error: 'Une erreur interne est survenue.', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
