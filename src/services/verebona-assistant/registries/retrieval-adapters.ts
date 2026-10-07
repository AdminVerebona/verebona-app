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
import { assets, assetFiles, agendaItems, equipments, substructures, toProcessActions } from '@/db/schema';
import { and, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { documentCodesMatchingWord } from '@/lib/referential/document-codes';
import type { DocumentAnalysisFilter } from '../core/query-terms';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { likePatterns, likePatternsTolerants, nearMatchRatio, normalizeWord, termMatchRatio, type QueryTerm } from '../core/query-terms';
import { dansPeriode } from '../core/query-period';
import { ANALYSIS_STATUS_LABELS, documentAnalysisStatus } from '../core/document-status';
import type { RetrievalAdapter, RetrievalQuery } from './retrieval-adapter-registry';
import type { RetrievedSource } from '../types/sources';
import { normalizedSql, searchExprMode } from '../core/search-sql';
import { assistantAssetStatusCondition } from '../core/asset-availability';

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

/**
 * Condition « au moins un terme » sur plusieurs colonnes (§11.2, §13.5) :
 * chaque terme est cherché par sa racine, ses synonymes et un préfixe (fautes
 * en fin de mot), insensible à la casse ET aux accents (`unaccent`, migration
 * 0060). Le classement fin est fait ensuite par `termMatchRatio`.
 *
 * DÉCISION V1 — RECHERCHE LEXICALE (CDC BO IA T2-008, Centre d'aide §4) :
 * le niveau « recherche sémantique si utile et disponible » n'est pas activé
 * en V1 ; aucune empreinte vectorielle n'est calculée. C'est ici que le
 * niveau sémantique viendrait s'ajouter. En attendant, la recherche reste
 * lexicale, servie par des index GIN trigrammes (migration 0208) :
 * `verebona_unaccent_lower(col)` est l'expression EXACTE de ces index — ne
 * pas la remplacer par `unaccent(lower(...))`, sinon l'index n'est plus
 * utilisé (même résultat, parcours complet du compte). `normalizedSql`
 * (core/search-sql.ts) ne s'en écarte que si la fonction est absente.
 */
async function conditionTermes(colonnes: Array<SQL | AnyPgColumn>, termes: QueryTerm[], tolerant = false): Promise<SQL | undefined> {
  if (termes.length === 0) return undefined;
  // Repli si la fonction de la migration 0208 est absente (search-sql.ts).
  const mode = await searchExprMode();
  const parts: SQL[] = [];
  for (const t of termes) {
    // Seconde passe « résultats proches » (§11.4) : motifs élargis.
    for (const motifLike of tolerant ? likePatternsTolerants(t) : likePatterns(t)) {
      for (const c of colonnes) parts.push(sql`${normalizedSql(mode, c)} LIKE ${normalizedSql(mode, motifLike)}`);
    }
  }
  return parts.length ? or(...parts) : undefined;
}

/**
 * Score composite (§13.7) : part des termes retrouvés, bonus si le bien est
 * celui désigné, bonus de récence, de période et de type demandés. Sans
 * terme (liste), score neutre.
 *
 * Résultats proches (§11.4, `q.tolerant`) : correspondance approximative,
 * score plafonné à 0,5 — un résultat proche ne passe jamais pour un
 * résultat exact.
 */
function scorer(q: RetrievalQuery, texte: string, bonus = 0): number | null {
  const termes = q.terms ?? [];
  if (termes.length === 0) return Math.max(0, Math.min(1, 0.6 + bonus));
  if (q.tolerant) {
    const approx = nearMatchRatio(termes, texte);
    return approx > 0 ? Math.min(0.5, Math.round((0.2 + 0.3 * approx + bonus) * 1000) / 1000) : null;
  }
  const ratio = termMatchRatio(termes, texte);
  if (ratio <= 0) return null;
  return Math.max(0, Math.min(1, Math.round((0.4 + 0.55 * ratio + bonus) * 1000) / 1000));
}

/**
 * Période demandée (§13.7) : +0,08 pour un élément daté DANS la période,
 * −0,08 pour un élément daté hors période. Sans date connue, neutre : on ne
 * pénalise pas ce qu'on ne sait pas dater.
 */
export function bonusPeriode(q: Pick<RetrievalQuery, 'period'>, date: string | null | undefined): number {
  const dedans = dansPeriode(date, q.period);
  return dedans === null ? 0 : dedans ? 0.08 : -0.08;
}

/**
 * Type de document demandé (§13.7) : +0,08 quand le type du document
 * (`document_type`, code du référentiel) contient la racine demandée
 * (« facture » → FACTURE, FACTURE_TRAVAUX…).
 */
export function bonusType(q: Pick<RetrievalQuery, 'documentTypes'>, documentType: string | null | undefined): number {
  const demandes = q.documentTypes ?? [];
  if (demandes.length === 0 || !documentType) return 0;
  const type = normalizeWord(documentType).replace(/[^a-z0-9]+/g, ' ');
  return demandes.some((d) => type.includes(d)) ? 0.08 : 0;
}

/** Bonus de récence : un document de moins d'un an prime à pertinence égale. */
function bonusRecence(date: string | null | undefined): number {
  if (!date) return 0;
  const t = Date.parse(date);
  return Number.isFinite(t) && Date.now() - t < 365 * 86400_000 ? 0.03 : 0;
}

/** Extrait borné : le contrat impose 1 500 caractères au plus (§17.7). */
function extrait(parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(' · ').slice(0, 1500);
}

export { documentAnalysisStatus, ANALYSIS_STATUS_LABELS, type DocumentAnalysisStatus } from '../core/document-status';

/* ── Biens ─────────────────────────────────────────────────────────────── */

export const assetsAdapter: RetrievalAdapter = {
  code: 'structured',
  enabled: true,
  name: 'assets',
  sourceTypes: ['asset_field'],

  async search(q: RetrievalQuery): Promise<RetrievedSource[]> {
    // Ticket 14 : biens archivés / transmis exclus (règle unique `asset-availability`).
    const conditions = [eq(assets.accountId, q.accountId), isNull(assets.deletedAt), assistantAssetStatusCondition(assets.status)];
    const termes = q.terms ?? [];
    const cond = await conditionTermes([assets.name, assets.city, assets.category, assets.subtype, assets.registrationNumber], termes, q.tolerant);
    if (cond) conditions.push(cond);

    const lignes = await db
      .select({
        id: assets.id, accountId: assets.accountId, name: assets.name,
        category: assets.category, subtype: assets.subtype, city: assets.city, status: assets.status,
        registrationNumber: assets.registrationNumber,
      })
      .from(assets)
      .where(and(...conditions))
      .orderBy(assets.name)
      .limit(q.limit);

    verifierPerimetre('assets', lignes, q.accountId);

    return lignes.flatMap((l) => {
      const designe = q.entityFilters.assetId === l.id ? 0.05 : 0;
      const exact = termes.length > 0 && normalizeWord(l.name ?? '') === termes.map((t) => t.raw).join(' ') ? 0.2 : 0;
      const score = scorer(q, [l.name, l.city, l.category, l.subtype, l.registrationNumber].filter(Boolean).join(' '), designe + exact);
      if (score == null) return [];
      return [{
        id: `asset_${l.id}`,
        type: 'asset_field' as const,
        title: l.name,
        content: extrait([l.category, l.subtype, l.city, l.status]),
        meta: { assetId: l.id, subtitle: extrait([l.subtype ?? l.category, l.city]) || null },
        relevanceScore: score,
      }];
    });
  },
};

/* ── Documents ─────────────────────────────────────────────────────────── */

export const documentsAdapter: RetrievalAdapter = {
  code: 'full_text',
  enabled: true,
  name: 'documents',
  sourceTypes: ['document', 'document_extraction'],

  async search(q: RetrievalQuery): Promise<RetrievedSource[]> {
    return searchDocumentsCanonical(q);
  },
};

/* ── Échéances ─────────────────────────────────────────────────────────── */

export const agendaAdapter: RetrievalAdapter = {
  code: 'structured',
  enabled: true,
  name: 'agenda',
  sourceTypes: ['agenda_item'],

  async search(q: RetrievalQuery): Promise<RetrievedSource[]> {
    const conditions = [eq(agendaItems.accountId, q.accountId)];
    const termes = q.terms ?? [];
    const cond = await conditionTermes([agendaItems.title, agendaItems.description], termes, q.tolerant);
    if (cond) conditions.push(cond);
    // CDC 15 T2-16 : bien ciblé → échéances LIÉES à ce bien
    // (`agenda_asset_links`), jamais celles d'un autre bien.
    const assetCible = typeof q.entityFilters.assetId === 'number' ? q.entityFilters.assetId : null;
    if (assetCible !== null) {
      conditions.push(sql`EXISTS (SELECT 1 FROM agenda_asset_links l WHERE l.agenda_item_id = ${agendaItems.id} AND l.asset_id = ${assetCible})`);
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

    return lignes.flatMap((l) => {
      const date = l.startDate ? String(l.startDate).slice(0, 10) : null;
      const score = scorer(q, [l.title, l.description].filter(Boolean).join(' '), bonusPeriode(q, date));
      if (score == null) return [];
      return [{
        id: `agenda_${l.id}`,
        type: 'agenda_item' as const,
        title: l.title,
        content: extrait([date, l.manualStatus, l.description]),
        meta: (assetCible !== null ? { agendaItemId: l.id, date, assetId: assetCible } : { agendaItemId: l.id, date }) as Record<string, string | number | null>,
        relevanceScore: score,
      }];
    });
  },
};

/* ── Équipements et pièces ─────────────────────────────────────────────── */

export const equipmentsAdapter: RetrievalAdapter = {
  code: 'structured',
  enabled: true,
  name: 'equipments',
  sourceTypes: ['asset_field'],

  async search(q: RetrievalQuery): Promise<RetrievedSource[]> {
    const termes = q.terms ?? [];
    const cond = await conditionTermes([equipments.name, equipments.type], termes, q.tolerant);
    if (!cond) return [];

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
      .where(and(eq(assets.accountId, q.accountId), isNull(assets.deletedAt), assistantAssetStatusCondition(assets.status),
        isNull(equipments.archivedAt), cond, ...filtreBien(q, equipments.assetId)))
      .limit(q.limit);

    verifierPerimetre('equipments', lignes, q.accountId);

    return lignes.flatMap((l) => {
      const score = scorer(q, [l.name, l.type].filter(Boolean).join(' '), -0.05);
      if (score == null) return [];
      return [{
        id: `equipment_${l.id}`,
        type: 'asset_field' as const,
        title: l.name,
        content: extrait([l.type, l.assetName ? `dans ${l.assetName}` : null]),
        meta: { equipmentId: l.id, assetId: l.assetId, assetName: l.assetName ?? null },
        relevanceScore: score,
      }];
    });
  },
};

/* ── Pièces ────────────────────────────────────────────────────────────── */
// Pièce = SOUS-STRUCTURE (décision PO D-G, lot 20) : `roomId` = `substructures.id`,
// celui qu'ouvre le tiroir de la pièce (`/api/substructures/[id]`).

export const roomsAdapter: RetrievalAdapter = {
  code: 'structured',
  enabled: true,
  name: 'rooms',
  sourceTypes: ['asset_field'],

  async search(q: RetrievalQuery): Promise<RetrievedSource[]> {
    const termes = q.terms ?? [];
    const cond = await conditionTermes([substructures.name], termes, q.tolerant);
    if (!cond) return [];

    const lignes = await db
      .select({
        id: substructures.id, accountId: assets.accountId, name: substructures.name, assetId: substructures.assetId,
        assetName: assets.name,
      })
      .from(substructures)
      .innerJoin(assets, eq(substructures.assetId, assets.id))
      .where(and(eq(assets.accountId, q.accountId), isNull(assets.deletedAt), assistantAssetStatusCondition(assets.status), cond, ...filtreBien(q, substructures.assetId)))
      .limit(q.limit);

    verifierPerimetre('rooms', lignes, q.accountId);

    return lignes.flatMap((l) => {
      const score = scorer(q, l.name ?? '', -0.1);
      if (score == null) return [];
      return [{
        id: `room_${l.id}`,
        type: 'asset_field' as const,
        title: l.name,
        content: extrait([l.assetName ? `dans ${l.assetName}` : null]),
        meta: { roomId: l.id, assetId: l.assetId, assetName: l.assetName ?? null },
        relevanceScore: score,
      }];
    });
  },
};

/* ── Fournisseurs (§11.1, §12.1) ──────────────────────────────────────── */

export const suppliersAdapter: RetrievalAdapter = {
  code: 'structured',
  enabled: true,
  name: 'suppliers',
  sourceTypes: ['supplier'],

  async search(q: RetrievalQuery): Promise<RetrievedSource[]> {
    return searchSuppliersCanonical(q);
  },
};

/* ── « À traiter » (§11.1, §12.1, §12.2) ─────────────────────────────── */

const PRIORITES: Record<string, string> = { DO_FIRST: 'À faire en premier', DO_NEXT: 'À faire ensuite', CAN_WAIT: 'Peut attendre' };

export const toProcessAdapter: RetrievalAdapter = {
  code: 'structured',
  enabled: true,
  name: 'to_process',
  sourceTypes: ['to_process_item'],

  async search(q: RetrievalQuery): Promise<RetrievedSource[]> {
    const termes = q.terms ?? [];
    const cond = await conditionTermes([toProcessActions.question], termes);
    // Liste complète (bornée) pour « que dois-je traiter ? » ; sinon
    // seulement les éléments dont la question correspond.
    // « Qu'est-ce qui manque ? » (§9.2 ACCOUNT_MISSING_INFORMATION) : les
    // informations à compléter SONT les éléments « À traiter » en attente.
    const liste = q.intent === 'ACCOUNT_TO_PROCESS' || q.intent === 'ACCOUNT_MISSING_INFORMATION';
    if (!cond && !liste) return [];
    const conditions = [eq(toProcessActions.accountId, q.accountId), isNull(toProcessActions.resolvedAt)];
    if (cond && !liste) conditions.push(cond);
    // CDC 15 T2-17 : bien ciblé → éléments DE ce bien —
    // le bien lui-même, ses équipements, ses documents (lien N-N ou
    // colonnes) et ses échéances (`agenda_asset_links`).
    const bienCible = typeof q.entityFilters.assetId === 'number' ? q.entityFilters.assetId : null;
    if (bienCible !== null) conditions.push(toProcessDuBien(bienCible));

    const lignes = await db
      .select({
        id: toProcessActions.id, accountId: toProcessActions.accountId,
        question: toProcessActions.question, priority: toProcessActions.priority,
        dueDate: toProcessActions.dueDate, targetType: toProcessActions.targetType,
      })
      .from(toProcessActions)
      .where(and(...conditions))
      .orderBy(sql`CASE ${toProcessActions.priority} WHEN 'DO_FIRST' THEN 0 WHEN 'DO_NEXT' THEN 1 ELSE 2 END`, toProcessActions.dueDate)
      .limit(q.limit);

    verifierPerimetre('to_process', lignes, q.accountId);

    return lignes.flatMap((l) => {
      const score = liste ? Math.max(0.7, scorer(q, l.question) ?? 0.7) : scorer(q, l.question);
      if (score == null) return [];
      const date = l.dueDate ? new Date(l.dueDate as unknown as string).toISOString().slice(0, 10) : null;
      return [{
        id: `todo_${l.id}`,
        type: 'to_process_item' as const,
        title: l.question,
        content: extrait([PRIORITES[l.priority] ?? null, date ? `échéance ${date}` : null]),
        meta: { toProcessId: l.id, date, subtitle: PRIORITES[l.priority] ?? null },
        relevanceScore: score,
      }];
    });
  },
};

/** Élément « À traiter » rattaché à un bien, quelle que soit sa cible (T2-17). */
function toProcessDuBien(assetId: number): SQL {
  const t = toProcessActions;
  return sql`(
    (${t.targetType} = 'ASSET' AND ${t.targetId} = ${assetId})
    OR (${t.targetType} = 'EQUIPMENT' AND EXISTS (SELECT 1 FROM equipments e WHERE e.id = ${t.targetId} AND e.asset_id = ${assetId}))
    OR (${t.targetType} = 'DOCUMENT' AND EXISTS (SELECT 1 FROM asset_files f WHERE f.id = ${t.targetId} AND f.account_id = ${t.accountId}
          AND (f.asset_id = ${assetId} OR f.linked_asset_id = ${assetId}
               OR EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = f.account_id AND l.file_id = f.id
                           AND l.status = 'ACTIVE' AND l.asset_id = ${assetId}))))
    OR (${t.targetType} = 'AGENDA_ITEM' AND EXISTS (SELECT 1 FROM agenda_asset_links l WHERE l.agenda_item_id = ${t.targetId} AND l.asset_id = ${assetId}))
  )`;
}

/* ── Règles d'offre (T2-06) ─────────────────────────────────────────────── */

/**
 * Sources `product_rule` de l'offre effective du compte (fournisseur de X,
 * `ProductRuleProvider`). Interrogé seulement quand l'intention attend des
 * règles d'offre (T2-07) : jamais sur une recherche.
 */
export const productRulesAdapter: RetrievalAdapter = {
  code: 'structured',
  enabled: true,
  name: 'product_rules',
  sourceTypes: ['product_rule'],

  async search(q: RetrievalQuery): Promise<RetrievedSource[]> {
    const { ProductRuleProvider } = await import('../canonical/product-rules');
    return (await ProductRuleProvider.sources(q.accountId)).slice(0, q.limit);
  },
};

/** Les adaptateurs, dans l'ordre d'enregistrement. */
export const ADAPTATEURS: RetrievalAdapter[] = [
  assetsAdapter,
  documentsAdapter,
  agendaAdapter,
  equipmentsAdapter,
  roomsAdapter,
  suppliersAdapter,
  toProcessAdapter,
  productRulesAdapter,
];

/* ══════════════════════════════════════════════════════════════════════════
 * LECTURE CANONIQUE (lot 15 ; seule lecture depuis le lot 16b-2)
 * ══════════════════════════════════════════════════════════════════════════ */

/** Bien ciblé appliqué aux adaptateurs relationnels (T2-17). */
function filtreBien(q: RetrievalQuery, col: AnyPgColumn): SQL[] {
  const id = q.entityFilters.assetId;
  return typeof id === 'number' ? [eq(col, id)] : [];
}

const plainT = (s: string) => normalizeWord(s).replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Codes de type documentaire désignés par une racine (« facture », « devis »),
 * pure et testée. Lot 30 : délégué au résolveur documentaire unique
 * (`documentCodesMatchingWord` : catalogue métier, référentiel V2, types V1).
 */
export function documentTypeCodesFor(stem: string): string[] {
  return documentCodesMatchingWord(stem);
}

/** États `analysis_state` d'un statut d'analyse demandé (T2-14). */
const ETATS_ANALYSE: Record<Exclude<DocumentAnalysisFilter, 'NOT_ANALYZED'>, string[]> = {
  IN_ANALYSIS: ['UPLOADING', 'UPLOADED', 'ANALYZING'],
  ANALYSIS_FAILED: ['ANALYSIS_FAILED'],
  TO_VALIDATE: ['VALIDATION_REQUIRED', 'CONFLICT_DETECTED'],
  ANALYZED: ['ANALYZED'],
};
const TOUS_ETATS = Object.values(ETATS_ANALYSE).flat();

/** Liens actifs d'un document vers un bien (N-N, X-01). */
const lienActif = (assetId: number | null) => assetId === null
  ? sql`EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = ${assetFiles.accountId} AND l.file_id = ${assetFiles.id}
          AND l.status = 'ACTIVE' AND l.asset_id IS NOT NULL)`
  : sql`EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = ${assetFiles.accountId} AND l.file_id = ${assetFiles.id}
          AND l.status = 'ACTIVE' AND l.asset_id = ${assetId})`;

/**
 * Documents, mode canonique — T2-13, T2-14, T2-18, T2-21.
 *
 *   · type demandé = FILTRE : code du référentiel V2, type historique ou, pour
 *     un document non typé, le mot dans son titre (jamais un simple bonus) ;
 *   · bien ciblé : lien N-N actif (`document_asset_links`) ou colonnes
 *     historiques ;
 *   · rattaché / non rattaché : EXACT — aucun lien actif vers un bien ET
 *     colonnes `asset_id` / `linked_asset_id` vides ;
 *   · statut d'analyse, fournisseur (fiche de la page ou nom désigné) ;
 *   · document de la page ou du fil : bonus (il reste un résultat possible,
 *     pas un filtre : « retrouve la facture EDF » depuis un autre document).
 */
async function searchDocumentsCanonical(q: RetrievalQuery): Promise<RetrievedSource[]> {
  const conditions: SQL[] = [eq(assetFiles.accountId, q.accountId), isNull(assetFiles.deletedAt)];
  const f = q.documentFilters ?? {};

  const assetId = typeof q.entityFilters.assetId === 'number' ? q.entityFilters.assetId : null;
  if (assetId !== null) {
    conditions.push(or(lienActif(assetId), eq(assetFiles.assetId, assetId), eq(assetFiles.linkedAssetId, assetId))!);
  }
  if (f.link === 'unlinked') {
    conditions.push(isNull(assetFiles.assetId), isNull(assetFiles.linkedAssetId), sql`NOT ${lienActif(null)}`);
  } else if (f.link === 'linked') {
    conditions.push(or(lienActif(null), sql`${assetFiles.assetId} IS NOT NULL`, sql`${assetFiles.linkedAssetId} IS NOT NULL`)!);
  }
  if (f.analysis?.length) {
    const parts: SQL[] = [];
    const etats = f.analysis.flatMap((a) => (a === 'NOT_ANALYZED' ? [] : ETATS_ANALYSE[a]));
    if (etats.length) parts.push(sql`upper(coalesce(${assetFiles.analysisState}, '')) IN (${sql.join(etats.map((e) => sql`${e}`), sql`, `)})`);
    if (f.analysis.includes('NOT_ANALYZED')) {
      parts.push(sql`upper(coalesce(${assetFiles.analysisState}, '')) NOT IN (${sql.join(TOUS_ETATS.map((e) => sql`${e}`), sql`, `)})`);
    }
    conditions.push(or(...parts)!);
  }
  const supplierId = typeof q.entityFilters.supplierId === 'number' ? q.entityFilters.supplierId : null;
  if (supplierId !== null) {
    conditions.push(or(
      sql`EXISTS (SELECT 1 FROM document_suppliers ds WHERE ds.document_id = ${assetFiles.id} AND ds.supplier_id = ${supplierId})`,
      sql`lower(${assetFiles.supplier}) = (SELECT lower(s.name) FROM suppliers s WHERE s.id = ${supplierId} AND s.account_id = ${q.accountId})`,
    )!);
  }
  const mode = await searchExprMode();
  if (f.supplierName) {
    conditions.push(sql`${normalizedSql(mode, assetFiles.supplier)} LIKE ${normalizedSql(mode, `%${plainT(f.supplierName)}%`)}`);
  }

  // Type demandé : FILTRE (T2-13). Les racines de type quittent les termes.
  const types = q.documentTypeFilter ?? [];
  if (types.length || q.documentTypeCodes?.length) {
    const codes = [...new Set([...types.flatMap(documentTypeCodesFor), ...(q.documentTypeCodes ?? [])])];
    const parts: SQL[] = [];
    if (codes.length) {
      const liste = sql.join(codes.map((c) => sql`${c}`), sql`, `);
      parts.push(sql`upper(coalesce(${assetFiles.documentTypeCode}, '')) IN (${liste})`);
      parts.push(sql`upper(coalesce(${assetFiles.documentType}, '')) IN (${liste})`);
    }
    for (const t of types) {
      const motif = `%${t}%`;
      parts.push(sql`${normalizedSql(mode, assetFiles.documentType)} LIKE ${normalizedSql(mode, motif)}`);
      // Document non typé : le mot dans son titre ou son nom de fichier.
      parts.push(sql`(${assetFiles.documentTypeCode} IS NULL AND ${assetFiles.documentType} IS NULL AND (
        ${normalizedSql(mode, assetFiles.retainedTitle)} LIKE ${normalizedSql(mode, motif)}
        OR ${normalizedSql(mode, assetFiles.originalFilename)} LIKE ${normalizedSql(mode, motif)}))`);
    }
    conditions.push(or(...parts)!);
  }
  const typeStems = new Set(types.flatMap((t) => [t, t.replace(/s$/, '')]));
  const termes = (q.terms ?? []).filter((t) => t.exact || !(typeStems.has(t.stem) || typeStems.has(t.raw)));
  const qq: RetrievalQuery = { ...q, terms: termes };

  const cond = await conditionTermes([
    assetFiles.retainedTitle, assetFiles.originalFilename, assetFiles.supplier,
    assetFiles.description, assetFiles.documentType, assetFiles.documentTypeCode, assetFiles.extractedText,
  ], termes, q.tolerant);
  if (cond) conditions.push(cond);

  const lignes = await db
    .select({
      id: assetFiles.id, accountId: assetFiles.accountId,
      title: assetFiles.retainedTitle, filename: assetFiles.originalFilename,
      documentType: assetFiles.documentType, documentTypeCode: assetFiles.documentTypeCode, documentDate: assetFiles.documentDate,
      supplier: assetFiles.supplier, description: assetFiles.description,
      assetId: assetFiles.assetId, linkedAssetId: assetFiles.linkedAssetId, assetName: assets.name,
      analysisState: assetFiles.analysisState,
      contentHash: assetFiles.sha256Hash, size: assetFiles.size, groupedIntoFileId: assetFiles.groupedIntoFileId,
      textHead: sql<string | null>`left(${assetFiles.extractedText}, 4000)`,
    })
    .from(assetFiles)
    .leftJoin(assets, eq(assets.id, sql`coalesce(${assetFiles.assetId}, ${assetFiles.linkedAssetId})`))
    .where(and(...conditions))
    .orderBy(sql`${assetFiles.documentDate} DESC NULLS LAST`, desc(assetFiles.id))
    .limit(q.limit);

  verifierPerimetre('documents', lignes, q.accountId);

  const cible = typeof q.entityFilters.documentId === 'number' ? q.entityFilters.documentId : null;
  const titresIndices = (q.hints?.documentTitles ?? []).map(plainT).filter((t) => t.length >= 3);
  return lignes.flatMap((l) => {
    const titre = l.title ?? l.filename ?? `Document ${l.id}`;
    const bonus = (assetId !== null ? 0.05 : 0) + (cible === l.id ? 0.1 : 0)
      + (titresIndices.some((h) => plainT(`${titre} ${l.filename ?? ''}`).includes(h)) ? 0.05 : 0)
      + bonusRecence(l.documentDate) + bonusPeriode(q, l.documentDate);
    const score = scorer(qq, [titre, l.filename, l.supplier, l.documentType, l.documentTypeCode, l.description, l.textHead].filter(Boolean).join(' '), bonus);
    if (score == null) return [];
    const statut = documentAnalysisStatus(l.analysisState);
    return [{
      id: `doc_${l.id}`,
      type: 'document' as const,
      title: titre,
      content: extrait([l.documentTypeCode ?? l.documentType, l.supplier, l.documentDate, l.description]),
      meta: {
        documentId: l.id, assetId: l.assetId ?? l.linkedAssetId ?? null, assetName: l.assetName ?? null,
        date: l.documentDate ?? null, analysisStatus: statut,
        statusLabel: ANALYSIS_STATUS_LABELS[statut],
        documentType: l.documentTypeCode ?? l.documentType ?? null,
        supplier: l.supplier ?? null,
        contentHash: l.contentHash ?? null, size: l.size ?? null,
        logicalFileId: l.groupedIntoFileId ?? l.id,
      },
      relevanceScore: score,
    }];
  });
}

/** Mots génériques d'une recherche de fournisseurs : une famille, pas un nom. */
const MOTS_FOURNISSEUR = new Set(['fournisseur', 'artisan', 'prestataire', 'entreprise', 'societe', 'garage', 'intervenant', 'intervenu', 'intervenue']);

/**
 * Fournisseurs, mode canonique — T2-05 : UNE entrée par fournisseur, qu'il
 * soit connu par sa fiche, par les documents ou par les interventions
 * (fournisseur de données de X, `listSuppliersDeduplicated`).
 */
async function searchSuppliersCanonical(q: RetrievalQuery): Promise<RetrievedSource[]> {
  const termes = (q.terms ?? []).filter((t) => !MOTS_FOURNISSEUR.has(t.stem));
  const indices = (q.hints?.supplierNames ?? []).map(plainT).filter(Boolean);
  if (termes.length === 0 && indices.length === 0 && q.intent !== 'ACCOUNT_SEARCH_SUPPLIER') return [];
  const { listSuppliersDeduplicated, supplierSource } = await import('../canonical/suppliers');
  const mots = [...new Set([...termes.flatMap((t) => [t.raw, ...t.variants]), ...indices])];
  const liste = await listSuppliersDeduplicated(q.accountId, { terms: mots, limit: Math.min(q.limit, 100) });
  const qq: RetrievalQuery = { ...q, terms: termes };
  return liste.flatMap((e, i) => {
    const src = supplierSource(e, i);
    const score = termes.length ? scorer(qq, `${e.name} ${e.city ?? ''}`) : 0.7;
    if (score == null) return [];
    return [{ ...src, relevanceScore: score }];
  });
}
