/**
 * Adaptateurs de récupération — CDC §13.4, §13.5, §25.6.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUN ADAPTATEUR N'ÉTAIT ENREGISTRÉ
 *
 * `getEnabledAdapters()` lisait un tableau que personne n'alimentait.
 * `retrieve()` retombait donc systématiquement sur son repli minimal : une
 * recherche par NOM DE BIEN, et rien d'autre.
 *
 * Autrement dit, l'assistant ne pouvait pas trouver un document, une échéance
 * ni un équipement. Il répondait — mais uniquement sur ce que le nom d'un bien
 * pouvait dire.
 *
 * Ces adaptateurs reprennent les recherches de `src/services/ai/assistant/
 * tools/read-tools.ts`, écrites et jamais branchées : cette implémentation
 * n'est appelée par aucune route.
 *
 * ── LE PÉRIMÈTRE EST VÉRIFIÉ DEUX FOIS ────────────────────────────────────
 *
 * Chaque requête filtre sur `account_id`, ET chaque ligne rendue est
 * recontrôlée avant d'être servie. La double vérification n'est pas une
 * redondance : une jointure mal écrite peut ramener une ligne hors périmètre
 * sans que la clause `WHERE` paraisse fautive.
 *
 * C'est le §13.2 — « le périmètre compte est appliqué à CHAQUE requête » — et
 * la conséquence d'un manquement serait qu'un utilisateur lise les documents
 * d'un autre.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import { assets, assetFiles, agendaItems, equipments, rooms } from '@/db/schema';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import type { RetrievalAdapter, RetrievalQuery } from './retrieval-adapter-registry';
import type { RetrievedSource } from '../types/sources';

/** Erreur levée si une ligne échappe au périmètre du compte. */
export class AccountScopeViolation extends Error {
  constructor(adapter: string, detail: string) {
    super(`[${adapter}] fuite de périmètre : ${detail}`);
    this.name = 'AccountScopeViolation';
  }
}

/**
 * Recontrôle chaque ligne avant de la servir.
 *
 * Une requête peut être juste et son résultat faux : jointure sur une table
 * non filtrée, sous-requête oubliée. Ce contrôle échoue bruyamment plutôt que
 * de laisser passer.
 */
function verifierPerimetre<T extends { accountId?: number | null }>(
  adaptateur: string,
  lignes: T[],
  accountId: number,
): T[] {
  for (const l of lignes) {
    if (l.accountId != null && l.accountId !== accountId) {
      throw new AccountScopeViolation(
        adaptateur,
        `ligne du compte ${l.accountId} alors que le contexte est ${accountId}`,
      );
    }
  }
  return lignes;
}

/** Motif de recherche insensible à la casse. */
function motif(q: string): string {
  return `%${q.trim()}%`;
}

/** Extrait borné : le contrat impose 1 500 caractères au plus (§17.7). */
function extrait(parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(' · ').slice(0, 1500);
}

/* ── Biens ─────────────────────────────────────────────────────────────── */

export const assetsAdapter: RetrievalAdapter = {
  code: 'structured',
  enabled: true,

  async search(q: RetrievalQuery): Promise<RetrievedSource[]> {
    const conditions = [eq(assets.accountId, q.accountId), isNull(assets.deletedAt)];

    if (q.normalizedQuery.trim()) {
      // `unaccent` est installée par la migration 0060 : sans elle, « énergie »
      // ne trouverait pas « energie », ce que tout utilisateur tape.
      const m = motif(q.normalizedQuery);
      conditions.push(
        or(
          sql`unaccent(lower(coalesce(${assets.name}, ''))) LIKE unaccent(lower(${m}))`,
          sql`unaccent(lower(coalesce(${assets.city}, ''))) LIKE unaccent(lower(${m}))`,
          sql`unaccent(lower(coalesce(${assets.category}, ''))) LIKE unaccent(lower(${m}))`,
        )!,
      );
    }

    const lignes = await db
      .select({
        id: assets.id, accountId: assets.accountId, name: assets.name,
        category: assets.category, city: assets.city, status: assets.status,
      })
      .from(assets)
      .where(and(...conditions))
      .orderBy(assets.name)
      .limit(q.limit);

    verifierPerimetre('assets', lignes, q.accountId);

    return lignes.map((l) => ({
      id: `asset_${l.id}`,
      type: 'asset_field' as const,
      title: l.name,
      content: extrait([l.category, l.city, l.status]),
      meta: { assetId: l.id },
      // Un bien nommé exactement comme la requête prime sur une correspondance
      // partielle sur la ville.
      relevanceScore:
        l.name?.toLowerCase() === q.normalizedQuery.trim().toLowerCase() ? 0.95 : 0.6,
    }));
  },
};

/* ── Documents ─────────────────────────────────────────────────────────── */

export const documentsAdapter: RetrievalAdapter = {
  code: 'full_text',
  enabled: true,

  async search(q: RetrievalQuery): Promise<RetrievedSource[]> {
    const conditions = [eq(assetFiles.accountId, q.accountId), isNull(assetFiles.deletedAt)];

    const assetId = q.entityFilters.assetId;
    if (typeof assetId === 'number') conditions.push(eq(assetFiles.assetId, assetId));

    const documentType = q.entityFilters.documentType;
    if (typeof documentType === 'string') {
      conditions.push(eq(assetFiles.documentType, documentType));
    }

    if (q.normalizedQuery.trim()) {
      const m = motif(q.normalizedQuery);
      conditions.push(
        or(
          ilike(assetFiles.retainedTitle, m),
          ilike(assetFiles.originalFilename, m),
          ilike(assetFiles.supplier, m),
          // La description porte souvent le texte extrait : c'est là que se
          // trouve la réponse à « quel est le montant de ma facture ».
          ilike(assetFiles.description, m),
        )!,
      );
    }

    const lignes = await db
      .select({
        id: assetFiles.id, accountId: assetFiles.accountId,
        title: assetFiles.retainedTitle, filename: assetFiles.originalFilename,
        documentType: assetFiles.documentType, documentDate: assetFiles.documentDate,
        supplier: assetFiles.supplier, description: assetFiles.description,
        assetId: assetFiles.assetId,
      })
      .from(assetFiles)
      .where(and(...conditions))
      // Le plus récent d'abord : sur un même type de document, c'est presque
      // toujours celui qui fait foi.
      .orderBy(desc(assetFiles.documentDate))
      .limit(q.limit);

    verifierPerimetre('documents', lignes, q.accountId);

    return lignes.map((l) => ({
      id: `doc_${l.id}`,
      type: 'document' as const,
      title: l.title ?? l.filename ?? `Document ${l.id}`,
      content: extrait([l.documentType, l.supplier, l.documentDate, l.description]),
      meta: { documentId: l.id, assetId: l.assetId },
      relevanceScore: 0.7,
    }));
  },
};

/* ── Échéances ─────────────────────────────────────────────────────────── */

export const agendaAdapter: RetrievalAdapter = {
  code: 'structured',
  enabled: true,

  async search(q: RetrievalQuery): Promise<RetrievedSource[]> {
    const conditions = [eq(agendaItems.accountId, q.accountId)];

    if (q.normalizedQuery.trim()) {
      const m = motif(q.normalizedQuery);
      conditions.push(
        or(ilike(agendaItems.title, m), ilike(agendaItems.description, m))!,
      );
    }

    const lignes = await db
      .select({
        id: agendaItems.id, accountId: agendaItems.accountId,
        title: agendaItems.title, description: agendaItems.description,
        // Les colonnes sont `startDate` et `manualStatus`, non `dueDate` et
        // `status` : le nommage diffère de celui des outils d'origine.
        startDate: agendaItems.startDate, manualStatus: agendaItems.manualStatus,
      })
      .from(agendaItems)
      .where(and(...conditions))
      // Par échéance croissante : ce qui arrive bientôt intéresse davantage
      // que ce qui est passé.
      .orderBy(agendaItems.startDate)
      .limit(q.limit);

    verifierPerimetre('agenda', lignes, q.accountId);

    return lignes.map((l) => ({
      id: `agenda_${l.id}`,
      type: 'agenda_item' as const,
      title: l.title,
      content: extrait([l.startDate, l.manualStatus, l.description]),
      meta: { agendaItemId: l.id },
      relevanceScore: 0.65,
    }));
  },
};

/* ── Équipements et pièces ─────────────────────────────────────────────── */

export const equipmentsAdapter: RetrievalAdapter = {
  code: 'structured',
  enabled: true,

  async search(q: RetrievalQuery): Promise<RetrievedSource[]> {
    if (!q.normalizedQuery.trim()) return [];

    const m = motif(q.normalizedQuery);

    // Les équipements ne portent pas `account_id` : ils dépendent d'un bien.
    // La jointure EST le contrôle de périmètre — d'où sa présence explicite
    // dans la clause, et non dans un filtre applicatif.
    const lignes = await db
      .select({
        id: equipments.id,
        accountId: assets.accountId,
        name: equipments.name,
        type: equipments.type,
        assetId: equipments.assetId,
        assetName: assets.name,
      })
      .from(equipments)
      .innerJoin(assets, eq(equipments.assetId, assets.id))
      .where(
        and(
          eq(assets.accountId, q.accountId),
          isNull(assets.deletedAt),
          or(ilike(equipments.name, m), ilike(equipments.type, m))!,
        ),
      )
      .limit(q.limit);

    verifierPerimetre('equipments', lignes, q.accountId);

    return lignes.map((l) => ({
      id: `equipment_${l.id}`,
      type: 'asset_field' as const,
      title: l.name,
      content: extrait([l.type, l.assetName ? `dans ${l.assetName}` : null]),
      meta: { equipmentId: l.id, assetId: l.assetId },
      relevanceScore: 0.55,
    }));
  },
};

/* ── Pièces ────────────────────────────────────────────────────────────── */

export const roomsAdapter: RetrievalAdapter = {
  code: 'structured',
  enabled: true,

  async search(q: RetrievalQuery): Promise<RetrievedSource[]> {
    if (!q.normalizedQuery.trim()) return [];

    const lignes = await db
      .select({
        id: rooms.id, accountId: assets.accountId, name: rooms.name, assetId: rooms.assetId,
        assetName: assets.name,
      })
      .from(rooms)
      .innerJoin(assets, eq(rooms.assetId, assets.id))
      .where(
        and(
          eq(assets.accountId, q.accountId),
          isNull(assets.deletedAt),
          ilike(rooms.name, motif(q.normalizedQuery)),
        ),
      )
      .limit(q.limit);

    verifierPerimetre('rooms', lignes, q.accountId);

    return lignes.map((l) => ({
      id: `room_${l.id}`,
      type: 'asset_field' as const,
      title: l.name,
      content: extrait([l.assetName ? `dans ${l.assetName}` : null]),
      meta: { roomId: l.id, assetId: l.assetId },
      relevanceScore: 0.5,
    }));
  },
};

/** Les cinq adaptateurs, dans l'ordre d'enregistrement. */
export const ADAPTATEURS: RetrievalAdapter[] = [
  assetsAdapter,
  documentsAdapter,
  agendaAdapter,
  equipmentsAdapter,
  roomsAdapter,
];
