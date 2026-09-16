/**
 * Producteurs d'actions — CDC V2.0 §7.4, §10.3, §10.5.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS FAMILLES QUI N'AVAIENT PLUS DE SOURCE
 *
 * Le pont de réconciliation couvre les biens, le pipeline d'analyse couvre
 * les documents. Restaient trois problèmes que la V1 détectait et que rien ne
 * recréait en V2 : agenda sans date, équipement rattaché à aucun bien,
 * fournisseur à confirmer.
 *
 * La migration du lot 4 les reprenait UNE FOIS. Après quoi ils disparaissaient
 * définitivement : un équipement créé le lendemain de la bascule n'aurait
 * jamais remonté. Ce module est leur source permanente.
 *
 * ── UN BALAYAGE, PAS UN DÉCLENCHEUR ───────────────────────────────────────
 *
 * Ces trois problèmes ne naissent pas d'une analyse : ils naissent d'un état
 * de la base — une date absente, un rattachement manquant. Les détecter à
 * l'écriture supposerait d'instrumenter chaque endroit qui crée un événement
 * ou un équipement, et il suffirait d'en oublier un.
 *
 * Le balayage périodique accepte un délai (quelques heures) en échange d'une
 * garantie : aucun chemin de création ne peut lui échapper.
 *
 * ── LA FERMETURE COMPTE AUTANT QUE LA CRÉATION ────────────────────────────
 *
 * Chaque producteur ferme les actions dont le problème a disparu (§7.3,
 * « problème devenu sans objet »). Sans cela, une date saisie ailleurs
 * laisserait la carte en place, et l'utilisateur répondrait deux fois à la
 * même question.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  agendaItems,
  assets,
  equipments,
  supplierReviewItems,
  toProcessActions,
} from '@/db/schema';
import type { ActionProposal } from './action-model';
import { resolveActionsForData, upsertAction } from './to-process-action.service';

export interface ProducerReport {
  created: number;
  updated: number;
  closed: number;
}

const EMPTY: ProducerReport = { created: 0, updated: 0, closed: 0 };

function merge(...reports: ProducerReport[]): ProducerReport {
  return reports.reduce(
    (acc, r) => ({
      created: acc.created + r.created,
      updated: acc.updated + r.updated,
      closed: acc.closed + r.closed,
    }),
    { ...EMPTY },
  );
}

/**
 * Événements d'agenda sans date — règle DATA-AGENDA-DATE.
 *
 * Les événements marqués « réalisé » ou « annulé » sont écartés : réclamer la
 * date d'un événement clos est du bruit, et c'est exactement le genre de carte
 * qui décourage de consulter la page.
 */
export async function produceAgendaActions(accountId: number): Promise<ProducerReport> {
  const sansDate = await db
    .select({ id: agendaItems.id, title: agendaItems.title })
    .from(agendaItems)
    .where(
      and(
        eq(agendaItems.accountId, accountId),
        isNull(agendaItems.startDate),
        isNull(agendaItems.manualStatus),
      ),
    );

  const report = { ...EMPTY };

  for (const item of sansDate) {
    const result = await upsertAction({
      accountId,
      targetType: 'AGENDA_ITEM',
      targetId: item.id,
      fieldKey: 'date',
      actionKind: 'COMPLETE',
      ruleCode: 'DATA-AGENDA-DATE',
      question: `À quelle date « ${item.title} » a-t-il lieu ?`,
    });
    if (result.status === 'CREATED') report.created += 1;
    else if (result.status === 'UPDATED') report.updated += 1;
  }

  report.closed += await closeObsolete(
    accountId,
    'AGENDA_ITEM',
    'date',
    sansDate.map((i) => i.id),
  );

  return report;
}

/**
 * Équipements rattachés à un bien supprimé — règle LINK-EQUIP-ASSET.
 *
 * `equipments.asset_id` est NOT NULL et porte un `ON DELETE CASCADE` : un
 * équipement sans bien du tout ne peut pas exister. Le seul orphelin possible
 * est celui dont le bien a été supprimé en douceur — la ligne demeure, avec
 * `deleted_at` renseigné, et l'équipement reste accroché à un bien que
 * l'utilisateur ne voit plus nulle part.
 *
 * Le compte vient du bien : la table `equipments` n'en porte pas.
 */
export async function produceEquipmentActions(accountId: number): Promise<ProducerReport> {
  const orphelins = await db
    .select({ id: equipments.id, name: equipments.name })
    .from(equipments)
    .innerJoin(assets, eq(equipments.assetId, assets.id))
    .where(
      and(
        eq(assets.accountId, accountId),
        sql`${assets.deletedAt} IS NOT NULL`,
      ),
    );

  const report = { ...EMPTY };

  for (const equip of orphelins) {
    const result = await upsertAction({
      accountId,
      targetType: 'EQUIPMENT',
      targetId: equip.id,
      relationKey: 'assetId',
      actionKind: 'COMPLETE',
      ruleCode: 'LINK-EQUIP-ASSET',
      question: `À quel bien « ${equip.name} » appartient-il ?`,
    });
    if (result.status === 'CREATED') report.created += 1;
    else if (result.status === 'UPDATED') report.updated += 1;
  }

  report.closed += await closeObsolete(
    accountId,
    'EQUIPMENT',
    'assetId',
    orphelins.map((e) => e.id),
  );

  return report;
}

/**
 * Fournisseurs à confirmer — règle SUPPLIER-IDENTITY.
 *
 * Une revue ouverte devient un arbitrage dès qu'elle porte des candidats, et
 * rien du tout sinon : sans proposition, la carte serait une question à
 * laquelle l'utilisateur ne pourrait pas répondre depuis la file (ATP-05).
 */
export async function produceSupplierActions(accountId: number): Promise<ProducerReport> {
  const revues = await db
    .select({
      id: supplierReviewItems.id,
      supplierId: supplierReviewItems.supplierId,
      detectedName: supplierReviewItems.detectedName,
      currentValue: supplierReviewItems.currentValue,
      detectedValue: supplierReviewItems.detectedValue,
      candidateIds: supplierReviewItems.candidateSupplierIds,
    })
    .from(supplierReviewItems)
    .where(
      and(
        eq(supplierReviewItems.accountId, accountId),
        eq(supplierReviewItems.status, 'open'),
      ),
    );

  const report = { ...EMPTY };
  const traites: number[] = [];

  for (const revue of revues) {
    const proposals: ActionProposal[] = [];

    if (revue.detectedValue) {
      proposals.push({
        value: revue.detectedValue,
        label: revue.detectedValue,
        // Une valeur relevée sur un document n'a pas de score comparable au
        // seuil du §11.2 : 0 la maintient à l'arbitrage, jamais à l'écriture.
        confidence: 0,
      });
    }
    if (revue.currentValue) {
      proposals.push({
        value: revue.currentValue,
        label: revue.currentValue,
        confidence: 1,
        isCurrentValue: true,
      });
    }

    const result = await upsertAction({
      accountId,
      targetType: 'SUPPLIER',
      targetId: revue.supplierId ?? revue.id,
      fieldKey: 'identity',
      actionKind: 'ARBITRATE',
      ruleCode: 'SUPPLIER-IDENTITY',
      proposals,
      question: revue.detectedName
        ? `« ${revue.detectedName} » est-il un fournisseur déjà connu ?`
        : 'S’agit-il du même fournisseur ?',
    });

    // `SKIPPED` = arbitrage sans candidat affichable. L'action n'existe pas,
    // et l'identifiant ne doit donc pas figurer parmi ceux à conserver.
    if (result.status === 'CREATED') {
      report.created += 1;
      traites.push(revue.supplierId ?? revue.id);
    } else if (result.status === 'UPDATED') {
      report.updated += 1;
      traites.push(revue.supplierId ?? revue.id);
    }
  }

  report.closed += await closeObsolete(accountId, 'SUPPLIER', 'identity', traites);

  return report;
}

/**
 * Ferme les actions d'une règle dont l'objet n'est plus concerné.
 *
 * `encoreConcernes` liste les cibles qui posent toujours problème. Toute action
 * active de cette clé portant sur une autre cible est devenue sans objet : la
 * date a été saisie, le bien rattaché, la revue close.
 */
async function closeObsolete(
  accountId: number,
  targetType: 'AGENDA_ITEM' | 'EQUIPMENT' | 'SUPPLIER',
  dataKey: string,
  encoreConcernes: number[],
): Promise<number> {
  const actives = await db
    .select({ targetId: toProcessActions.targetId })
    .from(toProcessActions)
    .where(
      and(
        eq(toProcessActions.accountId, accountId),
        eq(toProcessActions.targetType, targetType),
        sql`COALESCE(${toProcessActions.fieldKey}, ${toProcessActions.relationKey}) = ${dataKey}`,
        isNull(toProcessActions.resolvedAt),
      ),
    );

  const concernes = new Set(encoreConcernes);
  const aFermer = [...new Set(actives.map((a) => a.targetId))].filter(
    (id) => !concernes.has(id),
  );

  let closed = 0;
  for (const targetId of aFermer) {
    closed += await resolveActionsForData(
      accountId,
      targetType,
      targetId,
      dataKey,
      'OBSOLETE',
    );
  }
  return closed;
}

/** Balaye les trois familles pour un compte. */
export async function produceAccountActions(accountId: number): Promise<ProducerReport> {
  const [agenda, equipements, fournisseurs] = await Promise.all([
    produceAgendaActions(accountId).catch(reportError('agenda', accountId)),
    produceEquipmentActions(accountId).catch(reportError('équipements', accountId)),
    produceSupplierActions(accountId).catch(reportError('fournisseurs', accountId)),
  ]);
  return merge(agenda, equipements, fournisseurs);
}

/**
 * Une famille en échec ne doit pas emporter les deux autres : le balayage est
 * rejoué périodiquement, et perdre un tour complet pour une requête fautive
 * coûterait plus que la famille manquée.
 */
function reportError(famille: string, accountId: number) {
  return (e: Error): ProducerReport => {
    console.error(
      `[to-process] production ${famille} impossible pour le compte ${accountId} :`,
      e.message,
    );
    return { ...EMPTY };
  };
}

/** Actions à fermer parce que leur cible a disparu (§7.3, TARGET_DELETED). */
export async function closeActionsForDeletedTargets(
  accountId: number,
): Promise<number> {
  const actions = await db
    .select({
      id: toProcessActions.id,
      targetType: toProcessActions.targetType,
      targetId: toProcessActions.targetId,
    })
    .from(toProcessActions)
    .where(
      and(
        eq(toProcessActions.accountId, accountId),
        eq(toProcessActions.targetType, 'AGENDA_ITEM'),
        isNull(toProcessActions.resolvedAt),
      ),
    );

  if (actions.length === 0) return 0;

  const existants = await db
    .select({ id: agendaItems.id })
    .from(agendaItems)
    .where(inArray(agendaItems.id, actions.map((a) => a.targetId)));

  const vivants = new Set(existants.map((e) => e.id));
  const disparus = actions.filter((a) => !vivants.has(a.targetId));

  for (const action of disparus) {
    await db
      .update(toProcessActions)
      .set({
        resolvedAt: new Date(),
        resolutionReason: 'TARGET_DELETED',
        updatedAt: new Date(),
      })
      .where(eq(toProcessActions.id, action.id));
  }

  return disparus.length;
}
