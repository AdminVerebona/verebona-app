/**
 * Lecture de la file « À traiter » — CDC V2.0 §8.1, §8.2, §8.8, §16.3.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ORDRE ET COMPTEURS CÔTÉ SERVEUR
 *
 * Le §16.3 l'impose : « Compteurs et regroupements côté serveur. » Ce n'est
 * pas qu'une question de performance. Le compteur de la pastille de navigation
 * et celui de l'en-tête de page proviendraient sinon de deux calculs
 * différents, et l'utilisateur verrait « 7 actions » dans le menu et six
 * cartes à l'écran. Un compteur en désaccord avec ce qu'il annonce est pire
 * qu'une absence de compteur.
 *
 * ── LE CONTEXTE EST HYDRATÉ ICI, EN DEUX REQUÊTES ─────────────────────────
 *
 * Une carte affiche le titre du document, sa miniature, le bien concerné
 * (§8.4). Les charger côté client demanderait un appel par carte ; les
 * charger action par action côté serveur demanderait N requêtes. Les cibles
 * sont donc regroupées par type et lues en une requête chacune.
 *
 * ── DEUX COMPTEURS, ET ILS NE DISENT PAS LA MÊME CHOSE ────────────────────
 *
 * §8.8 : « Les filtres ne changent pas le compteur de fond ; le compteur
 * affiché reflète les résultats filtrés. » `total` sert la pastille, `shown`
 * sert l'en-tête. Les confondre ferait disparaître le repère global dès qu'un
 * filtre est posé.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { assetFiles, assets, equipments, toProcessActions } from '@/db/schema';
import type {
  ActionKind,
  ActionPriority,
  ActionProposal,
  TargetType,
  ToProcessAction,
} from './action-model';
import { selectDisplayedProposals } from './action-model';
import { getRule } from './rules-catalog';
import { sortActions, type OrderMode } from './priority';

/** Contexte objet affiché sur la carte (§8.4). */
export interface ActionTargetContext {
  label: string;
  /** Miniature si document, sinon icône côté client. */
  mimeType?: string | null;
  publicId?: string | null;
  assetId?: number | null;
  assetName?: string | null;
}

export interface ToProcessActionView {
  publicId: string;
  targetType: TargetType;
  targetId: number;
  fieldKey: string | null;
  relationKey: string | null;
  actionKind: ActionKind;
  priority: ActionPriority;
  ruleCode: string;
  question: string;
  proposals: ActionProposal[];
  /** §7.4 — « Non applicable » n'apparaît jamais sur la carte, mais le drawer
   *  doit savoir s'il doit l'offrir. */
  allowNotApplicable: boolean;
  activeSince: string;
  target: ActionTargetContext;
}

export interface ToProcessFilters {
  targetType?: TargetType;
  actionKind?: ActionKind;
  priority?: ActionPriority;
  /** Filtre « bien » du §8.8 : sélection multiple. */
  assetIds?: number[];
}

export interface ToProcessPage {
  actions: ToProcessActionView[];
  /** Actions actives du compte, filtres ignorés — sert la pastille (§8.8). */
  total: number;
  /** Actions après filtrage — sert l'en-tête et la microcopie (§17.2). */
  shown: number;
  orderMode: OrderMode;
}

export async function getToProcessPage(
  accountId: number,
  options: { orderMode?: OrderMode; filters?: ToProcessFilters } = {},
): Promise<ToProcessPage> {
  // §8.2 : « Par priorité » est la vue par défaut à CHAQUE visite ; le choix
  // n'est pas mémorisé. Le défaut est donc posé ici et non lu d'une préférence.
  const orderMode: OrderMode = options.orderMode ?? 'BY_PRIORITY';
  const filters = options.filters ?? {};

  const conditions = [
    eq(toProcessActions.accountId, accountId),
    isNull(toProcessActions.resolvedAt),
  ];
  if (filters.targetType) conditions.push(eq(toProcessActions.targetType, filters.targetType));
  if (filters.actionKind) conditions.push(eq(toProcessActions.actionKind, filters.actionKind));
  if (filters.priority) conditions.push(eq(toProcessActions.priority, filters.priority));

  const [rows, [totalRow]] = await Promise.all([
    db.select().from(toProcessActions).where(and(...conditions)),
    db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(toProcessActions)
      .where(
        and(eq(toProcessActions.accountId, accountId), isNull(toProcessActions.resolvedAt)),
      ),
  ]);

  const contexts = await hydrateTargets(accountId, rows);

  let views: ToProcessActionView[] = rows.map((row) => {
    const proposals = (row.proposalsJson as ActionProposal[] | null) ?? [];
    return {
      publicId: row.publicId,
      targetType: row.targetType as TargetType,
      targetId: row.targetId,
      fieldKey: row.fieldKey,
      relationKey: row.relationKey,
      actionKind: row.actionKind as ActionKind,
      priority: row.priority as ActionPriority,
      ruleCode: row.ruleCode,
      question: row.question,
      proposals: selectDisplayedProposals(proposals),
      allowNotApplicable: getRule(row.ruleCode)?.allowNotApplicable ?? false,
      activeSince: row.activeSince.toISOString(),
      target: contexts.get(`${row.targetType}:${row.targetId}`) ?? {
        label: `#${row.targetId}`,
      },
    };
  });

  // Le filtre « bien » porte sur la CIBLE, pas sur l'action : une action
  // documentaire concerne le bien auquel le document est rattaché. Il ne peut
  // donc être appliqué qu'après hydratation.
  if (filters.assetIds?.length) {
    const wanted = new Set(filters.assetIds);
    views = views.filter(
      (v) =>
        (v.target.assetId != null && wanted.has(v.target.assetId)) ||
        (v.targetType === 'ASSET' && wanted.has(v.targetId)),
    );
  }

  const sorted = sortActions(
    views.map((v) => ({ ...v, activeSince: new Date(v.activeSince) })),
    orderMode,
  ).map((v) => ({ ...v, activeSince: v.activeSince.toISOString() }));

  return {
    actions: sorted,
    total: totalRow?.total ?? 0,
    shown: sorted.length,
    orderMode,
  };
}

/**
 * Charge le contexte des objets visés, une requête par type.
 *
 * Les cibles absentes ne produisent aucune entrée : l'action retombe sur un
 * libellé de repli. Ce cas ne devrait pas exister — la suppression d'un objet
 * ferme ses actions (`TARGET_DELETED`) — mais une carte sans titre reste
 * préférable à une page qui échoue entièrement pour une ligne orpheline.
 */
async function hydrateTargets(
  accountId: number,
  rows: Array<{ targetType: string; targetId: number }>,
): Promise<Map<string, ActionTargetContext>> {
  const byType = new Map<string, number[]>();
  for (const row of rows) {
    const bucket = byType.get(row.targetType) ?? [];
    bucket.push(row.targetId);
    byType.set(row.targetType, bucket);
  }

  const contexts = new Map<string, ActionTargetContext>();

  const documentIds = byType.get('DOCUMENT');
  if (documentIds?.length) {
    const docs = await db
      .select({
        id: assetFiles.id,
        publicId: assetFiles.publicId,
        title: assetFiles.retainedTitle,
        filename: assetFiles.originalFilename,
        fallback: assetFiles.filename,
        mimeType: assetFiles.mimeType,
        assetId: assetFiles.assetId,
        linkedAssetId: assetFiles.linkedAssetId,
        assetName: assets.name,
      })
      .from(assetFiles)
      .leftJoin(assets, eq(assetFiles.assetId, assets.id))
      .where(
        and(
          eq(assetFiles.accountId, accountId),
          inArray(assetFiles.id, [...new Set(documentIds)]),
        ),
      );

    for (const doc of docs) {
      contexts.set(`DOCUMENT:${doc.id}`, {
        // §4.3 : jamais le nom de fichier comme titre principal — mais un
        // repli vaut mieux qu'une carte anonyme.
        label: doc.title ?? doc.filename ?? doc.fallback ?? 'Document',
        mimeType: doc.mimeType,
        publicId: doc.publicId,
        assetId: doc.assetId ?? doc.linkedAssetId ?? null,
        assetName: doc.assetName,
      });
    }
  }

  const assetIds = byType.get('ASSET');
  if (assetIds?.length) {
    const rowsAssets = await db
      .select({ id: assets.id, name: assets.name, publicId: assets.publicId })
      .from(assets)
      .where(
        and(eq(assets.accountId, accountId), inArray(assets.id, [...new Set(assetIds)])),
      );
    for (const asset of rowsAssets) {
      contexts.set(`ASSET:${asset.id}`, {
        label: asset.name,
        publicId: asset.publicId,
        assetId: asset.id,
        assetName: asset.name,
      });
    }
  }

  const equipmentIds = byType.get('EQUIPMENT');
  if (equipmentIds?.length) {
    const rowsEquip = await db
      .select({ id: equipments.id, name: equipments.name, assetId: equipments.assetId })
      .from(equipments)
      .where(inArray(equipments.id, [...new Set(equipmentIds)]));
    for (const equip of rowsEquip) {
      contexts.set(`EQUIPMENT:${equip.id}`, {
        label: equip.name,
        assetId: equip.assetId,
      });
    }
  }

  return contexts;
}

/** Action unique, par son identifiant public. */
export async function findActionByPublicId(
  accountId: number,
  publicId: string,
): Promise<ToProcessAction | null> {
  const [row] = await db
    .select()
    .from(toProcessActions)
    .where(
      and(eq(toProcessActions.accountId, accountId), eq(toProcessActions.publicId, publicId)),
    )
    .limit(1);

  if (!row) return null;

  return {
    id: row.id,
    publicId: row.publicId,
    accountId: row.accountId,
    targetType: row.targetType as TargetType,
    targetId: row.targetId,
    fieldKey: row.fieldKey,
    relationKey: row.relationKey,
    actionKind: row.actionKind as ActionKind,
    ruleCode: row.ruleCode,
    priority: row.priority as ActionPriority,
    question: row.question,
    proposals: (row.proposalsJson as ActionProposal[] | null) ?? [],
    activeSince: row.activeSince,
    lastSeenAt: row.lastSeenAt,
    resolvedAt: row.resolvedAt,
    cycleNumber: row.cycleNumber,
    dueDate: row.dueDate,
  };
}
