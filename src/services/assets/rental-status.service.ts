/**
 * Attribut « Bien mis en location » — CDC V2.0 §6.1, §6.3, §12.2, RENT-01.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « NON » N'EST PAS UNE RÉPONSE, C'EST UNE ABSENCE DE RÉPONSE
 *
 * Le §6.1 pose deux règles qui paraissent redondantes et ne le sont pas :
 *
 *   · « Valeur par défaut : Non » ;
 *   · « Le "Non" par défaut est une valeur système, pas une validation
 *     explicite de l'utilisateur. »
 *
 * Sans la seconde, un booléen suffirait — et tous les biens du parc seraient
 * protégés dès la migration, puisque tous porteraient « Non ». L'IA ne pourrait
 * plus jamais renseigner l'attribut, ce qui est l'inverse exact de l'intention.
 *
 * `isRentedUserValidated` porte donc la différence entre « l'utilisateur a
 * répondu Non » et « personne n'a rien dit ». C'est cette colonne, et non la
 * valeur, qui décide si l'IA peut écrire.
 *
 * ── TROIS ÉTATS, PAS DEUX ─────────────────────────────────────────────────
 *
 *   NON_RENSEIGNE   isRented = false, non validé   → l'IA peut écrire à ≥ 90 %
 *   NON             isRented = false, validé       → protégé, arbitrage seulement
 *   OUI             isRented = true                → Rubrique locative visible
 *
 * L'interface n'affiche que deux boutons : le §6.1 ne demande pas de montrer
 * le troisième état, seulement de ne pas le confondre avec une réponse.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { assets } from '@/db/schema';
import type { ActionProposal, ValueOrigin } from '@/services/to-process/action-model';
import { decide } from '@/services/to-process/decision-engine';
import {
  resolveActionsForData,
  upsertAction,
} from '@/services/to-process/to-process-action.service';

/** Clé de la donnée, alignée sur la règle ASSET-RENTED du catalogue §10. */
export const RENTAL_FIELD_KEY = 'isRented';

export type RentalState = 'NON_RENSEIGNE' | 'NON' | 'OUI';

export interface RentalStatus {
  isRented: boolean;
  userValidated: boolean;
  origin: ValueOrigin | null;
  state: RentalState;
}

/**
 * Le champ est-il proposé pour ce bien ?
 *
 * §6.1 : « Le champ est disponible uniquement pour les biens immobiliers en
 * V2. » La restriction porte sur la famille, jamais sur le sous-type : un
 * garage ou un local commercial se louent aussi.
 */
export function isRentalAttributeApplicable(category: string | null | undefined): boolean {
  return category === 'IMMOBILIER';
}

export function toRentalState(isRented: boolean, userValidated: boolean): RentalState {
  if (isRented) return 'OUI';
  return userValidated ? 'NON' : 'NON_RENSEIGNE';
}

export async function getRentalStatus(
  accountId: number,
  assetId: number,
): Promise<RentalStatus | null> {
  const [row] = await db
    .select({
      isRented: assets.isRented,
      userValidated: assets.isRentedUserValidated,
      origin: assets.isRentedOrigin,
      category: assets.category,
    })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.accountId, accountId)))
    .limit(1);

  if (!row) return null;

  return {
    isRented: row.isRented,
    userValidated: row.userValidated,
    origin: row.origin as ValueOrigin,
    state: toRentalState(row.isRented, row.userValidated),
  };
}

/**
 * Réponse explicite de l'utilisateur.
 *
 * §6.1 : « Si l'utilisateur choisit explicitement Oui ou Non, la valeur devient
 * protégée. » Répondre « Non » n'est donc pas un geste neutre : il ferme la
 * question, là où le « Non » système la laissait ouverte.
 *
 * L'enregistrement résout l'action correspondante (§5.3) : la question ne doit
 * pas rester dans « À traiter » après y avoir répondu ailleurs.
 */
export async function setRentalStatusByUser(
  accountId: number,
  assetId: number,
  isRented: boolean,
): Promise<RentalStatus | null> {
  const updated = await db
    .update(assets)
    .set({
      isRented,
      isRentedOrigin: 'USER',
      isRentedUserValidated: true,
      isRentedUpdatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(assets.id, assetId), eq(assets.accountId, accountId)))
    .returning({ id: assets.id });

  if (updated.length === 0) return null;

  await resolveActionsForData(
    accountId, 'ASSET', assetId, RENTAL_FIELD_KEY, 'USER_COMPLETED',
  );

  return {
    isRented,
    userValidated: true,
    origin: 'USER',
    state: toRentalState(isRented, true),
  };
}

export interface RentalProposalResult {
  applied: boolean;
  arbitrated: boolean;
  reason: string;
}

/**
 * Proposition issue du traitement d'optimisation.
 *
 * §6.1 : « L'attribut suit les mêmes règles IA que les autres données : ≥ 90 %
 * permet une mise à jour automatique si la valeur n'est pas protégée ; < 90 %
 * avec proposition crée "À arbitrer". »
 *
 * Le seuil et la protection ne sont pas réimplémentés ici : `decide()` les
 * porte déjà (§11.3). Les redire produirait un second jeu de règles sur la
 * même donnée, et le jour où les deux divergeraient, personne ne saurait
 * lequel fait foi.
 *
 * ── CAS DU BAIL ENTRANT (§6.3) ────────────────────────────────────────────
 *
 * Un bail nouvellement classé en « Gestion locative » est précisément la
 * preuve forte que le §6.3 attend : il arrive ici sous forme de proposition,
 * et suit le chemin commun. Aucun traitement particulier n'est nécessaire.
 */
export async function applyRentalProposal(
  accountId: number,
  assetId: number,
  proposal: { value: boolean; confidence: number; evidenceIds?: string[] },
): Promise<RentalProposalResult> {
  const status = await getRentalStatus(accountId, assetId);
  if (!status) return { applied: false, arbitrated: false, reason: 'Bien introuvable.' };

  const proposals: ActionProposal[] = [
    {
      value: proposal.value,
      label: proposal.value ? 'Oui' : 'Non',
      confidence: proposal.confidence,
      evidenceIds: proposal.evidenceIds,
    },
  ];

  const verdict = decide({
    targetType: 'ASSET',
    key: RENTAL_FIELD_KEY,
    // La valeur courante n'est « présente » que si elle a été validée : le
    // « Non » système est traité comme une absence, faute de quoi le moteur
    // refuserait d'écrire sur un champ que personne n'a jamais renseigné.
    currentValue: status.userValidated ? status.isRented : null,
    currentOrigin: status.origin,
    userValidated: status.userValidated,
    proposals,
  });

  if (verdict.decision === 'APPLY' || verdict.decision === 'UPDATE') {
    await db
      .update(assets)
      .set({
        isRented: verdict.valueToWrite === true,
        isRentedOrigin: 'RECONCILIATION',
        isRentedUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(assets.id, assetId), eq(assets.accountId, accountId)));

    await resolveActionsForData(
      accountId, 'ASSET', assetId, RENTAL_FIELD_KEY, 'OBSOLETE',
    );
    return { applied: true, arbitrated: false, reason: verdict.explanation };
  }

  if (verdict.decision === 'ARBITRATE') {
    await upsertAction({
      accountId,
      targetType: 'ASSET',
      targetId: assetId,
      fieldKey: RENTAL_FIELD_KEY,
      actionKind: 'ARBITRATE',
      ruleCode: 'ASSET-RENTED',
      proposals: verdict.proposals ?? proposals,
    });
    return { applied: false, arbitrated: true, reason: verdict.explanation };
  }

  return { applied: false, arbitrated: false, reason: verdict.explanation };
}
