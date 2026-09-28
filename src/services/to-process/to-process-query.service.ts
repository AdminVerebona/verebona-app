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
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  assetFiles, assets, equipments, supplierReviewItems, suppliers, toProcessActions,
} from '@/db/schema';
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
  /**
   * Fournisseur réellement visé (cible SUPPLIER). `targetId` peut être celui
   * d'une revue fournisseur sans fournisseur rattaché (`supplierId ?? revue.id`
   * côté producteur) : seul cet identifiant résolu peut ouvrir la fiche
   * `/fournisseurs/[id]`. `null` : aucun fournisseur identifié.
   */
  supplierId?: number | null;
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
  options: { orderMode?: OrderMode; filters?: ToProcessFilters; limit?: number } = {},
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

  // Lecture bornée (CDC Mascotte NFR-001) : seules les N premières actions
  // « Par priorité » sont lues. L'ordre SQL reproduit `comparePriorityMode`
  // (priorité, puis ancienneté) pour que la borne garde les MÊMES actions
  // que la file complète. Sans objet si le filtre « bien » (appliqué après
  // hydratation) ou l'ordre « Par action » sont demandés.
  const borne = options.limit && orderMode === 'BY_PRIORITY' && !filters.assetIds?.length
    ? Math.max(1, Math.floor(options.limit))
    : null;
  const lecture = db.select().from(toProcessActions).where(and(...conditions));

  const [rows, [totalRow]] = await Promise.all([
    borne
      ? lecture
        .orderBy(
          sql`CASE ${toProcessActions.priority} WHEN 'DO_FIRST' THEN 0 WHEN 'DO_NEXT' THEN 1 ELSE 2 END`,
          asc(toProcessActions.activeSince),
          asc(toProcessActions.id),
        )
        .limit(borne)
      : lecture,
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

  const supplierTargets = byType.get('SUPPLIER');
  if (supplierTargets?.length) {
    for (const [cle, ctx] of await hydrateSupplierTargets(accountId, [...new Set(supplierTargets)])) {
      contexts.set(cle, ctx);
    }
  }

  return contexts;
}

/**
 * Cibles SUPPLIER — CDC Mascotte ATP-005 / ATP-03.
 *
 * Le producteur SUPPLIER-IDENTITY pose `targetId = supplierId ?? revue.id` :
 * l'identifiant est celui d'un fournisseur OU d'une revue sans fournisseur.
 * On ne devine pas : on retrouve la revue ouverte qui a produit l'action.
 *   1. une revue ouverte porte ce fournisseur → c'est lui ;
 *   2. sinon une revue ouverte sans fournisseur porte cet id → aucun
 *      fournisseur à ouvrir (`supplierId: null`, repli côté client) ;
 *   3. sinon (action historique sans revue) → le fournisseur de ce numéro,
 *      s'il existe dans le compte.
 * Dans tous les cas le fournisseur retenu doit appartenir au compte et ne pas
 * être supprimé.
 */
async function hydrateSupplierTargets(
  accountId: number,
  ids: number[],
): Promise<Map<string, ActionTargetContext>> {
  const revues = await db
    .select({
      id: supplierReviewItems.id,
      supplierId: supplierReviewItems.supplierId,
      detectedName: supplierReviewItems.detectedName,
    })
    .from(supplierReviewItems)
    .where(
      and(
        eq(supplierReviewItems.accountId, accountId),
        eq(supplierReviewItems.status, 'open'),
        or(inArray(supplierReviewItems.supplierId, ids), inArray(supplierReviewItems.id, ids)),
      ),
    );

  const { candidats } = resolveSupplierContexts(ids, revues, []);
  const connus = candidats.length
    ? await db
      .select({ id: suppliers.id, name: suppliers.name })
      .from(suppliers)
      .where(
        and(
          eq(suppliers.accountId, accountId),
          inArray(suppliers.id, candidats),
          ne(suppliers.status, 'deleted'),
        ),
      )
    : [];
  return resolveSupplierContexts(ids, revues, connus).contexts;
}

/**
 * Partie pure de la résolution SUPPLIER (voir `hydrateSupplierTargets`).
 * `candidats` : identifiants qui PEUVENT être des fournisseurs (à vérifier en
 * base) ; `contexts` : contexte par cible, une fois les fournisseurs connus
 * du compte (`connus`) fournis.
 */
export function resolveSupplierContexts(
  ids: number[],
  revues: Array<{ id: number; supplierId: number | null; detectedName: string | null }>,
  connus: Array<{ id: number; name: string }>,
): { candidats: number[]; contexts: Map<string, ActionTargetContext> } {
  const parFournisseur = new Map<number, string | null>();
  const revueSansFournisseur = new Map<number, string | null>();
  for (const r of revues) {
    if (r.supplierId != null && ids.includes(r.supplierId)) parFournisseur.set(r.supplierId, r.detectedName);
    if (r.supplierId == null && ids.includes(r.id)) revueSansFournisseur.set(r.id, r.detectedName);
  }
  // Une revue ouverte sans fournisseur a produit l'action : son id n'est PAS
  // celui d'un fournisseur, même si un fournisseur porte ce numéro.
  const candidats = ids.filter((id) => parFournisseur.has(id) || !revueSansFournisseur.has(id));
  const noms = new Map(connus.filter((f) => candidats.includes(f.id)).map((f) => [f.id, f.name]));

  const contexts = new Map<string, ActionTargetContext>();
  for (const id of ids) {
    if (noms.has(id)) {
      contexts.set(`SUPPLIER:${id}`, { label: noms.get(id)!, supplierId: id });
    } else {
      const detecte = parFournisseur.get(id) ?? revueSansFournisseur.get(id) ?? null;
      if (detecte) contexts.set(`SUPPLIER:${id}`, { label: detecte, supplierId: null });
    }
  }
  return { candidats, contexts };
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
