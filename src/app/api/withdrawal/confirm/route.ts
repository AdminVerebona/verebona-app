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
 * L'annulation Stripe et le remboursement n'interviennent PAS ici. Le §7.4
 * exige que « la déclaration soit considérée comme reçue, indépendamment du
 * résultat immédiat des appels Stripe » : les y placer ferait dépendre
 * l'enregistrement d'un droit de la disponibilité d'un prestataire. Ils sont
 * déclenchés en aval, sur l'état `received`.
 *
 * La protection CSRF exigée au §12.4 est assurée par le middleware, qui
 * contrôle l'origine de toute requête mutante.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { evaluateEligibility } from '@/services/withdrawal/eligibility.service';
import { buildSummary } from '@/services/withdrawal/summary.service';
import { recordDeclaration, WithdrawalError } from '@/services/withdrawal/withdrawal.service';
import {
  resolveVerificationToken,
  consumeVerificationToken,
  recordFailedAttempt,
} from '@/services/withdrawal/public-verification.service';
import { sendWithdrawalReceipt } from '@/services/withdrawal/receipt.service';
import { processWithdrawal } from '@/services/withdrawal/withdrawal-processor.service';

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
      idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null,
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

    // ── Traitement Stripe, APRÈS l'accusé de réception ──────────────────
    //
    // Déclenché sans attendre le résultat : la réponse au consommateur ne doit
    // pas dépendre de la disponibilité de Stripe (§7.4). Un échec laisse la
    // demande en `failed`, et le balayage quotidien la reprendra (§10).
    //
    // Seules les demandes éligibles sont traitées : une demande en
    // `manual_review` attend un examen humain, on n'annule pas un abonnement
    // sur une éligibilité incertaine.
    if (!declaration.alreadyRecorded && declaration.status === 'received') {
      void processWithdrawal(declaration.publicReference).catch((e) => {
        console.error(
          `[withdrawal] traitement différé de ${declaration.publicReference} :`,
          (e as Error).message,
        );
      });
    }

    return NextResponse.json(
      {
        publicReference: declaration.publicReference,
        status: declaration.status,
        // Enregistré en UTC, affiché en heure de Paris par le client (§7.4).
        requestedAt: declaration.requestedAt.toISOString(),
        dataExportDeadlineAt: declaration.dataExportDeadlineAt.toISOString(),
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
