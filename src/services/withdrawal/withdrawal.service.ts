/**
 * Enregistrement d'une déclaration de rétractation — CDC 6 §7.4, §11, §12.4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA DÉCLARATION EST REÇUE AVANT TOUT APPEL À STRIPE
 *
 * Le §7.4 est explicite : « la déclaration est considérée comme reçue,
 * indépendamment du résultat immédiat des appels Stripe ». Le §3.3 le redit :
 * « la demande reste juridiquement enregistrée même si Stripe ou un autre
 * prestataire est temporairement indisponible ».
 *
 * L'ordre des opérations en découle, et il n'est pas négociable :
 *
 *   1. écrire la déclaration, avec son horodatage et ses instantanés ;
 *   2. renvoyer la référence au consommateur ;
 *   3. envoyer l'accusé de réception ;
 *   4. seulement ensuite, annuler l'abonnement et rembourser.
 *
 * Faire l'inverse — annuler d'abord, enregistrer ensuite — ferait perdre la
 * déclaration si Stripe répondait mal, alors que le consommateur a exercé son
 * droit. L'exercice d'un droit ne dépend pas de la disponibilité d'un
 * prestataire de paiement.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * LOT 32 — TRAITEMENT IMMÉDIAT, SUPPRESSION IMMÉDIATE (décisions PO Q1, Q2)
 *
 * Seule une déclaration ÉLIGIBLE est enregistrée (statut `received`) : plus
 * d'examen manuel. Elle est traitée sur-le-champ par `processWithdrawal` —
 * accès coupés, abonnement annulé, remboursement intégral, compte supprimé,
 * e-mail d'au revoir — et reprise automatiquement par le balayage en cas
 * d'échec Stripe. Plus de délai d'export : `data_deletion_scheduled_at` vaut
 * l'instant de la déclaration, `data_export_deadline_at` reste vide.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash, randomBytes } from 'crypto';
import { db } from '@/db';
import { withdrawalRequests } from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { recordWithdrawalEvent } from './withdrawal-journal.service';
import {
  ACTIVE_WITHDRAWAL_STATUSES,
  type ContractSummary,
  type EligibilityResult,
} from './eligibility.service';

export type WithdrawalChannel = 'authenticated' | 'public' | 'email' | 'postal' | 'support';
export type WithdrawalStatus =
  | 'received' | 'manual_review' | 'processing' | 'completed' | 'failed' | 'rejected';

/**
 * Référence communiquée au consommateur.
 *
 * Format `RET-AAAAMMJJ-XXXXXX`. La partie aléatoire est tirée d'un générateur
 * cryptographique et non d'un compteur : une référence séquentielle
 * révélerait le volume de rétractations, et permettrait de deviner celle d'un
 * autre consommateur.
 */
export function generatePublicReference(now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  // Alphabet sans I, O, 0, 1 : la référence est lue au téléphone.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  let suffix = '';
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `RET-${date}-${suffix}`;
}

/** Empreinte d'un jeton. Le jeton en clair n'est jamais stocké. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface DeclarationInput {
  userId: number | null;
  accountId: number | null;
  channel: WithdrawalChannel;
  firstName: string;
  lastName: string;
  receiptEmail: string;
  /** Résultat de l'évaluation, qui détermine le statut initial. */
  eligibility: EligibilityResult;
  /** Ce qui a été affiché à l'écran au moment de la confirmation (§11). */
  displayedSummary?: Record<string, unknown>;
  /** Montant estimé affiché, en centimes. */
  amountExpected?: number | null;
  /** Clé fournie par l'appelant pour neutraliser une double soumission. */
  idempotencyKey?: string | null;
  now?: Date;
}

export interface DeclarationResult {
  publicReference: string;
  status: WithdrawalStatus;
  requestedAt: Date;
  /** `true` si la déclaration existait déjà (double soumission). */
  alreadyRecorded: boolean;
}

export class WithdrawalError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WithdrawalError';
  }
}

/**
 * Statut initial d'une déclaration (pure).
 *
 * Lot 32 (PO-Q2) : plus d'examen manuel. Seule une déclaration éligible est
 * enregistrée, et elle part aussitôt en traitement (`received`). Une
 * éligibilité indéterminée ou négative n'est PAS enregistrée (`null`) :
 * l'appelant répond « réessayez » (503) ou le motif (409). `manual_review`
 * ne subsiste que pour les demandes historiques.
 */
export function initialStatus(verdict: EligibilityResult['verdict']): WithdrawalStatus | null {
  return verdict === 'eligible' ? 'received' : null;
}

/**
 * Enregistre la déclaration.
 *
 * Idempotent par la base : deux requêtes simultanées portant la même clé ne
 * créent qu'une déclaration. Un contrôle préalable par `SELECT` ne suffirait
 * pas — les deux le passeraient.
 */
export async function recordDeclaration(
  input: DeclarationInput,
): Promise<DeclarationResult> {
  const now = input.now ?? new Date();
  const contract = input.eligibility.contract;
  const status = initialStatus(input.eligibility.verdict);
  if (!status || !contract) {
    throw new WithdrawalError(
      'NOT_ELIGIBLE',
      "L'éligibilité n'est pas établie : la déclaration n'est pas enregistrée.",
    );
  }

  const declarationSnapshot = {
    // Ce que le consommateur a déclaré, mot pour mot.
    firstName: input.firstName,
    lastName: input.lastName,
    receiptEmail: input.receiptEmail,
    channel: input.channel,
    declaredAt: now.toISOString(),
    // Et ce qui lui a été montré avant qu'il ne confirme.
    displayedSummary: input.displayedSummary ?? null,
  };

  const contractSnapshot = contract ? snapshotContract(contract) : null;

  const inserted = await db
    .insert(withdrawalRequests)
    .values({
      publicReference: generatePublicReference(now),
      userId: input.userId,
      accountId: input.accountId,
      subscriptionIdInternal: contract?.subscriptionIdInternal ?? null,
      stripeSubscriptionId: contract?.stripeSubscriptionId ?? null,
      contractConcludedAt: contract?.contractConcludedAt ?? null,
      withdrawalDeadlineAt: contract?.withdrawalDeadlineAt ?? null,
      requestedAt: now,
      confirmedAt: now,
      channel: input.channel,
      status,
      consumerFirstName: input.firstName,
      consumerLastName: input.lastName,
      receiptEmail: input.receiptEmail,
      declarationSnapshotJson: JSON.stringify(declarationSnapshot),
      contractSnapshotJson: contractSnapshot ? JSON.stringify(contractSnapshot) : null,
      amountExpected: input.amountExpected ?? null,
      currency: 'eur',
      cancellationStatus: contract?.stripeSubscriptionId ? 'pending' : 'not_applicable',
      // Lot 32 : suppression immédiate, aucun délai d'export.
      dataExportDeadlineAt: null,
      dataDeletionScheduledAt: now,
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted.length > 0) {
    const row = inserted[0];
    console.info(
      `[withdrawal] déclaration ${row.publicReference} enregistrée ` +
      `(compte ${input.accountId}, canal ${input.channel}, statut ${status}).`,
    );

    // §18 : contenu de la déclaration, date et heure de confirmation, méthode
    // d'authentification, contrat, date limite calculée.
    await recordWithdrawalEvent({
      publicReference: row.publicReference,
      eventType: 'DECLARATION_RECEIVED',
      actor: 'consumer',
      actorUserId: input.userId,
      summary: `Déclaration reçue via le parcours ${input.channel} (statut ${status}).`,
      payload: {
        channel: input.channel,
        eligibilityVerdict: input.eligibility.verdict,
        ineligibilityReason: input.eligibility.reason ?? null,
        declaration: declarationSnapshot,
        contract: contractSnapshot,
      },
      occurredAt: now,
    });
    return {
      publicReference: row.publicReference,
      status: row.status as WithdrawalStatus,
      requestedAt: row.requestedAt,
      alreadyRecorded: false,
    };
  }

  // Conflit : soit la clé d'idempotence, soit une demande déjà active pour ce
  // contrat. Dans les deux cas, on retourne la déclaration existante — le §7.4
  // exige que « le bouton ne puisse plus déclencher une seconde demande ».
  const existing = await findActiveRequest({
    accountId: input.accountId,
    idempotencyKey: input.idempotencyKey ?? null,
  });

  if (!existing) {
    throw new WithdrawalError(
      'DECLARATION_FAILED',
      "La déclaration n'a pas pu être enregistrée et aucune demande existante n'a été retrouvée.",
    );
  }

  return {
    publicReference: existing.publicReference,
    status: existing.status as WithdrawalStatus,
    requestedAt: existing.requestedAt,
    alreadyRecorded: true,
  };
}

/** Instantané du contrat, tel qu'affiché (§11). */
function snapshotContract(contract: ContractSummary): Record<string, unknown> {
  return {
    accountId: contract.accountId,
    subscriptionIdInternal: contract.subscriptionIdInternal,
    stripeSubscriptionId: contract.stripeSubscriptionId,
    planCode: contract.planCode,
    billingPeriod: contract.billingPeriod,
    contractConcludedAt: contract.contractConcludedAt.toISOString(),
    paidAt: contract.paidAt.toISOString(),
    withdrawalDeadlineAt: contract.withdrawalDeadlineAt.toISOString(),
    deadlineDeferred: contract.deadlineDeferred,
    deadlineDeferralReason: contract.deadlineDeferralReason ?? null,
  };
}

async function findActiveRequest(params: {
  accountId: number | null;
  idempotencyKey: string | null;
}) {
  if (params.idempotencyKey) {
    const [byKey] = await db
      .select()
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.idempotencyKey, params.idempotencyKey))
      .limit(1);
    if (byKey) return byKey;
  }
  if (params.accountId === null) return null;

  const [byAccount] = await db
    .select()
    .from(withdrawalRequests)
    .where(
      and(
        eq(withdrawalRequests.accountId, params.accountId),
        inArray(withdrawalRequests.status, [...ACTIVE_WITHDRAWAL_STATUSES]),
      ),
    )
    .limit(1);
  return byAccount ?? null;
}

/**
 * Demande déjà enregistrée sous cette clé d'idempotence (double soumission).
 * Lot 32 : lue AVANT l'éligibilité — le premier envoi a pu supprimer le
 * compte entre-temps, et le second doit retrouver la déclaration, pas
 * conclure à une panne.
 */
export async function findByIdempotencyKey(idempotencyKey: string | null | undefined) {
  if (!idempotencyKey) return null;
  const [row] = await db
    .select()
    .from(withdrawalRequests)
    .where(eq(withdrawalRequests.idempotencyKey, idempotencyKey))
    .limit(1);
  return row ?? null;
}

/** Demande par référence publique (journal, BO). */
export async function getByPublicReference(publicReference: string) {
  const [row] = await db
    .select()
    .from(withdrawalRequests)
    .where(eq(withdrawalRequests.publicReference, publicReference))
    .limit(1);
  return row ?? null;
}

/** Marque l'accusé de réception comme envoyé (§8). */
export async function markReceiptSent(publicReference: string, at: Date = new Date()) {
  await db
    .update(withdrawalRequests)
    .set({ receiptSentAt: at })
    .where(eq(withdrawalRequests.publicReference, publicReference));

  await recordWithdrawalEvent({
    publicReference,
    eventType: 'RECEIPT_SENT',
    summary: 'Accusé de réception remis au consommateur.',
    occurredAt: at,
  });
}
