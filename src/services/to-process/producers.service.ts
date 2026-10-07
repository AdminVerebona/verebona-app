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
 * Lot 28 : quatrième famille, les DOCUMENTS (`produceDocumentActions`) —
 * réévaluation sans analyse des règles du pont documentaire générique
 * (rattachement à un bien, données requises), rattrapage des documents
 * existants compris ; et les cibles disparues incluent désormais documents
 * supprimés ou regroupés et biens supprimés.
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
  assetFiles,
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

/**
 * Documents — règles du pont générique (LINK-ASSET, DATA-*, lot 28).
 *
 * Réévalue, SANS analyse, les documents qui portent une action documentaire
 * active (fermeture si la donnée a été renseignée ailleurs) et ceux à qui
 * manque une donnée requise sans action ouverte (document sans bien, contrat
 * sans date de fin…). C'est aussi le rattrapage automatique des documents
 * déposés avant le lot 28 — borné par passage, repris au suivant.
 */
export async function produceDocumentActions(accountId: number, limit = 200): Promise<ProducerReport> {
  const { documentsToReevaluate, syncDocumentRulesFromState } = await import('./document-rule-bridge');
  const report = { ...EMPTY };
  for (const fileId of await documentsToReevaluate(accountId, limit)) {
    const r = await syncDocumentRulesFromState(accountId, fileId, { reason: 'OBSOLETE', create: true });
    report.created += r.created;
    report.updated += r.updated;
    report.closed += r.closed;
  }
  return report;
}

export interface AccountProductionReport extends ProducerReport {
  /** Familles en échec pour ce compte (le balayage continue). */
  errors: string[];
}

/** Balaye les familles nées d'un état de la base, pour un compte. */
export async function produceAccountActions(accountId: number): Promise<AccountProductionReport> {
  const errors: string[] = [];
  const [agenda, equipements, fournisseurs, documents] = await Promise.all([
    produceAgendaActions(accountId).catch(reportError('agenda', accountId, errors)),
    produceEquipmentActions(accountId).catch(reportError('équipements', accountId, errors)),
    produceSupplierActions(accountId).catch(reportError('fournisseurs', accountId, errors)),
    produceDocumentActions(accountId).catch(reportError('documents', accountId, errors)),
  ]);
  return { ...merge(agenda, equipements, fournisseurs, documents), errors };
}

/**
 * Une famille en échec ne doit pas emporter les autres : le balayage est
 * rejoué périodiquement, et perdre un tour complet pour une requête fautive
 * coûterait plus que la famille manquée. L'échec est COMPTÉ (trace du
 * balayage, BO Exploitation), jamais silencieux.
 */
function reportError(famille: string, accountId: number, errors: string[]) {
  return (e: Error): ProducerReport => {
    errors.push(`${famille} : ${e.message}`.slice(0, 300));
    console.error(
      `[to-process] production ${famille} impossible pour le compte ${accountId} :`,
      e.message,
    );
    return { ...EMPTY };
  };
}

/**
 * Actions à fermer parce que leur cible a disparu (§7.3, TARGET_DELETED) :
 * échéance supprimée, document supprimé ou regroupé dans un autre, bien
 * supprimé.
 */
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
        inArray(toProcessActions.targetType, ['AGENDA_ITEM', 'DOCUMENT', 'ASSET']),
        isNull(toProcessActions.resolvedAt),
      ),
    );

  if (actions.length === 0) return 0;

  const ids = (type: string) => [...new Set(actions.filter((a) => a.targetType === type).map((a) => a.targetId))];
  const vivants = new Set<string>();

  const agendaIds = ids('AGENDA_ITEM');
  if (agendaIds.length) {
    for (const e of await db.select({ id: agendaItems.id }).from(agendaItems).where(inArray(agendaItems.id, agendaIds))) {
      vivants.add(`AGENDA_ITEM:${e.id}`);
    }
  }
  const docIds = ids('DOCUMENT');
  if (docIds.length) {
    const docs = await db
      .select({ id: assetFiles.id })
      .from(assetFiles)
      .where(and(
        inArray(assetFiles.id, docIds), eq(assetFiles.accountId, accountId),
        isNull(assetFiles.deletedAt), isNull(assetFiles.groupedIntoFileId),
      ));
    for (const d of docs) vivants.add(`DOCUMENT:${d.id}`);
  }
  const assetIds = ids('ASSET');
  if (assetIds.length) {
    const biens = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(inArray(assets.id, assetIds), eq(assets.accountId, accountId), isNull(assets.deletedAt)));
    for (const b of biens) vivants.add(`ASSET:${b.id}`);
  }

  const disparus = actions.filter((a) => !vivants.has(`${a.targetType}:${a.targetId}`));
  if (disparus.length === 0) return 0;

  await db
    .update(toProcessActions)
    .set({
      resolvedAt: new Date(),
      resolutionReason: 'TARGET_DELETED',
      updatedAt: new Date(),
    })
    .where(and(inArray(toProcessActions.id, disparus.map((a) => a.id)), isNull(toProcessActions.resolvedAt)));

  return disparus.length;
}
