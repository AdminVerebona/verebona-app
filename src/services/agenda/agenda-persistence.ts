/**
 * Persistance des décisions d'agenda — pont entre l'usage IA n°4 et le schéma
 * `agenda_items` existant.
 *
 * Ce module est appelé par `instrumentation.ts` au moment du câblage. Il est
 * volontairement séparé de `agenda-intelligence.service.ts` : le moteur de
 * décision reste une logique pure, testable sans base de données, et c'est ici
 * que sont traduites les particularités du schéma.
 *
 * ⚠️ TROIS ÉCARTS ENTRE LE MODÈLE DE L'USAGE 4 ET LA TABLE EXISTANTE
 *
 *   1. `agenda_items` n'a PAS de colonne `asset_id`. Le rattachement à un bien
 *      passe par la table de liaison `agenda_asset_links`.
 *   2. La date d'échéance est `start_date`, pas `due_date`.
 *   3. Le statut est `manual_status`, contraint à 'realise' | 'annule' | NULL.
 *
 * La traduction est faite ici, une fois, plutôt que dispersée dans le moteur.
 */
import { db } from '@/db';
import { agendaItems, agendaAssetLinks } from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import type { AgendaDecision, ExistingAgendaItem, HomeCategory } from '@/services/ai/agenda';

/**
 * Événements existants d'un bien, dans le format attendu par le moteur.
 *
 * Le filtre porte sur `account_id` ET sur la liaison au bien : un événement
 * d'un autre compte ne peut pas remonter, même en cas d'identifiant erroné.
 */
export async function loadExistingAgendaItems(
  accountId: number,
  assetId: number,
): Promise<ExistingAgendaItem[]> {
  const rows = await db
    .select({
      id: agendaItems.id,
      title: agendaItems.title,
      startDate: agendaItems.startDate,
      homeCategory: agendaItems.homeCategory,
      manualStatus: agendaItems.manualStatus,
      isAutomatic: agendaItems.isAutomatic,
      isAutomaticModified: agendaItems.isAutomaticModified,
      originFieldKey: agendaItems.originFieldKey,
    })
    .from(agendaItems)
    .innerJoin(agendaAssetLinks, eq(agendaAssetLinks.agendaItemId, agendaItems.id))
    .where(and(
      eq(agendaItems.accountId, accountId),
      eq(agendaAssetLinks.assetId, assetId),
    ))
    .limit(500);

  return rows
    // Un événement sans date n'entre pas dans la comparaison de doublons.
    .filter((r): r is typeof r & { startDate: string } => Boolean(r.startDate))
    .map((r) => ({
      id: r.id,
      title: r.title,
      date: r.startDate,
      category: (r.homeCategory as HomeCategory | null) ?? null,
      status: r.manualStatus,
      // Est « manuel » tout événement créé par un utilisateur, mais AUSSI tout
      // événement automatique qu'un utilisateur a modifié depuis : dans les deux
      // cas, un geste humain doit être protégé (CDC §4.4.4).
      manual: !r.isAutomatic || r.isAutomaticModified,
      originFieldKey: r.originFieldKey,
    }));
}

/**
 * Applique les décisions du moteur.
 *
 * Chaque décision est isolée : l'échec de l'une ne compromet pas les autres.
 * C'est l'exigence du §11.4 — « les tâches non critiques échouent sans bloquer
 * le document principal ».
 */
export async function persistAgendaDecisions(
  decisions: AgendaDecision[],
  accountId: number,
  assetId: number,
): Promise<void> {
  for (const decision of decisions) {
    try {
      switch (decision.action) {
        case 'create':
          await createItem(decision, accountId, assetId, false);
          break;

        case 'propose':
          // Preuve insuffisante : l'événement est créé mais demande une
          // qualification par l'utilisateur avant d'être tenu pour acquis.
          await createItem(decision, accountId, assetId, true);
          break;

        case 'update':
          await updateItem(decision, accountId);
          break;

        case 'create_conflict':
          await createConflict(decision, accountId, assetId);
          break;

        case 'skip_duplicate':
          // Un doublon certain n'est jamais recréé (§4.4.4). Rien à faire.
          break;
      }
    } catch (e) {
      console.error(
        `[agenda-persistence] décision « ${decision.action} » sur « ${decision.title} » :`,
        (e as Error).message,
      );
    }
  }
}

async function createItem(
  decision: AgendaDecision,
  accountId: number,
  assetId: number,
  requiresQualification: boolean,
): Promise<void> {
  const [item] = await db.insert(agendaItems).values({
    accountId,
    title: decision.title,
    startDate: decision.date,
    homeCategory: decision.category,
    isAutomatic: true,
    isAutomaticModified: false,
    requiresQualification,
    // `asset_field` lorsque l'échéance découle d'un champ de fiche,
    // `qualified_document` lorsqu'elle est lue directement dans un document.
    originType: decision.originFieldKey ? 'asset_field' : 'qualified_document',
    originFieldKey: decision.originFieldKey ?? null,
    // Conservation de la source, exigée par le §4.4.4 : « toute mise à jour
    // automatique conserve sa source ».
    originRefType: decision.sourceFileId ? 'asset_file' : null,
    originRefId: decision.sourceFileId ?? null,
  }).returning({ id: agendaItems.id });

  await linkToAsset(item.id, assetId);
}

async function updateItem(decision: AgendaDecision, accountId: number): Promise<void> {
  if (!decision.existingItemId) return;

  // Relecture de sécurité : entre la décision et son application, l'utilisateur
  // a pu intervenir. Un événement devenu manuel n'est plus modifiable.
  const [current] = await db
    .select({
      isAutomatic: agendaItems.isAutomatic,
      isAutomaticModified: agendaItems.isAutomaticModified,
    })
    .from(agendaItems)
    .where(and(
      eq(agendaItems.id, decision.existingItemId),
      eq(agendaItems.accountId, accountId),
    ))
    .limit(1);

  if (!current) return;
  if (!current.isAutomatic || current.isAutomaticModified) {
    console.info(
      `[agenda-persistence] événement ${decision.existingItemId} devenu manuel — mise à jour annulée`,
    );
    return;
  }

  await db.update(agendaItems)
    .set({
      title: decision.title,
      startDate: decision.date,
      homeCategory: decision.category,
      originRefType: decision.sourceFileId ? 'asset_file' : null,
      originRefId: decision.sourceFileId ?? null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(agendaItems.id, decision.existingItemId),
      eq(agendaItems.accountId, accountId),
    ));
}

/**
 * Contradiction avec un événement créé ou modifié par un utilisateur.
 *
 * L'événement existant n'est PAS touché (§4.4.4). La proposition est créée à
 * côté, marquée `requiresQualification`, ce qui la fait apparaître dans
 * « À traiter » : l'utilisateur tranche lui-même entre les deux.
 */
async function createConflict(
  decision: AgendaDecision,
  accountId: number,
  assetId: number,
): Promise<void> {
  const [item] = await db.insert(agendaItems).values({
    accountId,
    title: decision.title,
    description:
      `Cette échéance a été détectée dans un document mais diverge d'un événement ` +
      `que vous avez saisi ou modifié` +
      (decision.existingItemId ? ` (événement n° ${decision.existingItemId})` : '') +
      `. Aucun de vos événements n'a été modifié.`,
    startDate: decision.date,
    homeCategory: decision.category,
    isAutomatic: true,
    isAutomaticModified: false,
    requiresQualification: true,
    originType: decision.originFieldKey ? 'asset_field' : 'qualified_document',
    originFieldKey: decision.originFieldKey ?? null,
    originRefType: decision.sourceFileId ? 'asset_file' : null,
    originRefId: decision.sourceFileId ?? null,
  }).returning({ id: agendaItems.id });

  await linkToAsset(item.id, assetId);
}

/** Rattache l'événement au bien. L'index d'unicité rend l'opération idempotente. */
async function linkToAsset(agendaItemId: number, assetId: number): Promise<void> {
  await db.insert(agendaAssetLinks)
    .values({ agendaItemId, assetId })
    .onConflictDoNothing();
}

/**
 * Suppression des événements automatiques rattachés à un document réanalysé.
 * Utilisé lors d'une réanalyse : les événements MANUELS sont préservés.
 */
export async function removeAutomaticItemsFromSource(
  accountId: number,
  sourceFileId: number,
): Promise<number> {
  const rows = await db
    .select({ id: agendaItems.id })
    .from(agendaItems)
    .where(and(
      eq(agendaItems.accountId, accountId),
      eq(agendaItems.originRefType, 'asset_file'),
      eq(agendaItems.originRefId, sourceFileId),
      eq(agendaItems.isAutomatic, true),
      eq(agendaItems.isAutomaticModified, false),
    ));

  if (rows.length === 0) return 0;

  await db.delete(agendaItems).where(inArray(agendaItems.id, rows.map((r) => r.id)));
  return rows.length;
}
