/**
 * Calcul du montant remboursable — CDC 6 §3.2, §9.3 et §9.4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE MODULE EST PUR
 *
 * Un remboursement mal calculé coûte de l'argent dans un sens, ou expose à un
 * litige dans l'autre. C'est exactement le genre de règle qu'on ne veut pas
 * découvrir fausse en production.
 *
 * Ce fichier ne connaît donc ni Stripe, ni la base : il prend une liste de
 * paiements et rend une liste de remboursements à effectuer. Toute la
 * complexité du §9.3 y est vérifiable sans appeler quoi que ce soit.
 *
 * ── LES QUATRE RÈGLES QU'IL APPLIQUE ──────────────────────────────────────
 *
 * 1. REMBOURSEMENT INTÉGRAL (§3.2). Aucun prorata d'utilisation, aucun frais
 *    de dossier, aucune pénalité. Le consommateur récupère ce qu'il a payé.
 *
 * 2. LES FRAIS STRIPE NE SONT JAMAIS DÉDUITS (§9.4). Stripe ne restitue pas
 *    toujours sa commission à Verebona ; c'est une perte pour l'entreprise,
 *    pas une retenue sur le consommateur.
 *
 * 3. LE PLAFOND EST LE MONTANT ENCAISSÉ (§9.3). « Le montant final ne peut
 *    jamais dépasser le montant total effectivement encaissé. » Les paiements
 *    échoués, non capturés ou déjà remboursés en sont exclus.
 *
 * 4. LES REMBOURSEMENTS PARTIELS ANTÉRIEURS SONT DÉDUITS. Un geste commercial
 *    déjà accordé ne se rembourse pas deux fois.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Un paiement tel que Stripe le rapporte, réduit à ce qui compte ici. */
export interface PaymentRecord {
  /** Identifiant du PaymentIntent ou de la charge (§9.4). */
  id: string;
  /** Montant encaissé, en centimes. */
  amount: number;
  /** Déjà remboursé sur ce paiement, en centimes. */
  amountRefunded: number;
  currency: string;
  /** Le paiement a-t-il été effectivement capturé ? */
  captured: boolean;
  /** Statut Stripe : succeeded, pending, failed… */
  status: string;
  /** Horodatage, pour ne retenir que les paiements postérieurs au contrat. */
  createdAt: Date;
}

export interface RefundInstruction {
  paymentId: string;
  /** Montant à rembourser sur ce paiement, en centimes. */
  amount: number;
  currency: string;
  /** Clé d'idempotence propre à la demande ET au paiement (§9.4). */
  idempotencyKey: string;
}

export interface RefundPlan {
  instructions: RefundInstruction[];
  /** Total à rembourser, en centimes. */
  totalAmount: number;
  currency: string;
  /** Paiements écartés, avec leur motif — journalisé, jamais deviné. */
  excluded: Array<{ paymentId: string; reason: string }>;
}

/** Statuts Stripe correspondant à un encaissement réel. */
const CAPTURED_STATUSES = new Set(['succeeded']);

/**
 * Un paiement est-il remboursable ?
 *
 * Exporté pour être testé cas par cas : c'est le point où une erreur
 * produirait un remboursement supérieur à l'encaissement.
 */
export function isRefundable(
  payment: PaymentRecord,
  contractConcludedAt: Date,
): { refundable: true } | { refundable: false; reason: string } {
  if (!CAPTURED_STATUSES.has(payment.status)) {
    return { refundable: false, reason: `statut ${payment.status} — non encaissé` };
  }
  if (!payment.captured) {
    return { refundable: false, reason: 'autorisé mais non capturé' };
  }
  if (payment.amount <= 0) {
    return { refundable: false, reason: 'montant nul' };
  }
  if (payment.amountRefunded >= payment.amount) {
    return { refundable: false, reason: 'déjà intégralement remboursé' };
  }
  // §9.3 : « tous les paiements réussis liés au contrat DEPUIS
  // contract_concluded_at ». Un paiement antérieur relève d'un contrat
  // précédent, qui n'est pas celui qu'on rétracte.
  //
  // Tolérance d'une minute : l'horodatage Stripe et celui enregistré par
  // Verebona ne sont pas posés au même instant, et le paiement initial se
  // situe naturellement à la frontière.
  if (payment.createdAt.getTime() < contractConcludedAt.getTime() - 60_000) {
    return { refundable: false, reason: 'antérieur à la conclusion du contrat' };
  }
  return { refundable: true };
}

/**
 * Construit le plan de remboursement.
 *
 * @param requestReference référence publique de la demande, qui entre dans la
 *   clé d'idempotence : deux demandes distinctes sur le même paiement — cas
 *   théorique mais possible après une nouvelle souscription — ne doivent pas
 *   partager la même clé, sinon Stripe rejouerait le premier remboursement.
 */
export function buildRefundPlan(
  payments: PaymentRecord[],
  contractConcludedAt: Date,
  requestReference: string,
): RefundPlan {
  const instructions: RefundInstruction[] = [];
  const excluded: Array<{ paymentId: string; reason: string }> = [];
  let totalAmount = 0;
  let currency = 'eur';

  for (const payment of payments) {
    const verdict = isRefundable(payment, contractConcludedAt);
    if (!verdict.refundable) {
      excluded.push({ paymentId: payment.id, reason: verdict.reason });
      continue;
    }

    // Complément : ce qui reste dû après un remboursement partiel antérieur.
    const amount = payment.amount - payment.amountRefunded;
    currency = payment.currency;

    instructions.push({
      paymentId: payment.id,
      amount,
      currency: payment.currency,
      idempotencyKey: `withdrawal_${requestReference}_${payment.id}`,
    });
    totalAmount += amount;
  }

  return { instructions, totalAmount, currency, excluded };
}

/**
 * Traduit un statut de remboursement Stripe en état applicatif.
 *
 * Les neuf situations du §9.5 se ramènent à trois issues : c'est réglé, c'est
 * en route, ou il faut intervenir. Distinguer davantage n'aiderait personne —
 * mais confondre « en attente » et « échoué » ferait soit relancer un
 * remboursement déjà en cours, soit abandonner un consommateur sans argent.
 */
export type RefundOutcome = 'settled' | 'in_flight' | 'needs_attention';

export function classifyRefundStatus(status: string): RefundOutcome {
  switch (status) {
    case 'succeeded':
      return 'settled';
    case 'pending':
    case 'processing':
      return 'in_flight';
    case 'requires_action':
    case 'failed':
    case 'canceled':
      return 'needs_attention';
    default:
      // Un statut inconnu appelle un examen : Stripe en ajoute au fil du
      // temps, et le supposer bénin ferait clore des demandes non réglées.
      return 'needs_attention';
  }
}

/**
 * Statut global d'une demande à partir de ses remboursements.
 *
 * Une demande n'est `completed` que si TOUT est réglé : l'annulation et la
 * totalité des remboursements. Un seul remboursement en attente la maintient
 * en `processing` — le consommateur n'a pas encore été intégralement remboursé.
 */
export function aggregateStatus(
  cancellationStatus: string,
  refundStatuses: string[],
  expectedRefundCount: number,
): 'processing' | 'completed' | 'failed' {
  if (cancellationStatus === 'failed') return 'failed';

  const outcomes = refundStatuses.map(classifyRefundStatus);
  if (outcomes.some((o) => o === 'needs_attention')) return 'failed';

  const settled = outcomes.filter((o) => o === 'settled').length;
  const cancellationDone =
    cancellationStatus === 'cancelled' || cancellationStatus === 'not_applicable';

  if (cancellationDone && settled === expectedRefundCount) return 'completed';
  return 'processing';
}
