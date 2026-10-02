/**
 * Primitive d'écriture UNIQUE de l'agenda — CDC 15 T4-09, SVC-07, §12
 * « AgendaWriteService unifié », T4-07, T4-08 (lot 14, volet B).
 *
 *   upsertAgendaItem(input, opts)           création ou mise à jour d'UN élément ;
 *   removeAgendaItemsFromSource({ … })      retrait des éléments automatiques
 *                                           d'une source qui ne sont plus produits.
 *
 * Appelée par l'agenda MANUEL (`AgendaWriteService`) et par l'agenda
 * AUTOMATIQUE (`agenda-persistence`) — seul chemin d'écriture depuis le lot
 * 16b-2 (commutateur AI_T4_EFFECTS et écritures historiques retirés). Un même événement
 * décrit par la même entrée donne le même état, à l'origine près : mêmes
 * validations, mêmes liens (bien, cible, documents), même nature et type
 * métier, mêmes effets (recopie « achat » D-13, notification D-14,
 * proposition de statut du bien D-15).
 *
 * L'entrée décrit l'ÉVÉNEMENT (origine, nature, type métier, catégorie,
 * date, titre, récurrence, sources, clé) ; `agendaItemValues` la traduit en
 * colonnes `agenda_items`, à l'identique des deux chemins historiques
 * (vérifié par les tests de parité). Le moteur de ligne (transaction, liens,
 * colonnes 0223, effets d'après validation) est `write-agenda-item.ts`.
 *
 * CLÉ FONCTIONNELLE (T4-08) : un élément AUTOMATIQUE porte
 * `functionalKey` — fournie, ou calculée depuis la source principale, la
 * cible, le type métier, le champ d'origine et `occurrenceIndex`. Une
 * création dont la clé existe déjà MET À JOUR l'élément (ou le
 * laisse, s'il a été modifié par l'utilisateur : `protected`).
 *
 * « MODIFIÉ PAR L'UTILISATEUR » : notion existante réutilisée —
 * `is_automatic_modified` (édition du titre, de la date, de la description,
 * confirmation d'une prévision) ou `manual_status` posé. Un tel élément n'est
 * jamais mis à jour ni retiré par la synchronisation (§14.6).
 */
import { pgClient } from '@/db';
import type { HomeCategory } from '@/services/ai/agenda/types';
import { validateTemporalConstraints } from './AgendaDomainService';
import { agendaFunctionalColumnsReady } from './agenda-columns';
import { computeAgendaFunctionalKey, isUserTouched, resolveEventSemantics, type AgendaEventNature } from './agenda-functional-key';
import type { AgendaSourceRef } from './agenda-source-links';
import {
  writeAgendaItem, AgendaValidationError,
  type AgendaItemValues, type AgendaItemLinks, type WriteAgendaItemResult, type WriteAgendaItemOptions,
} from './write-agenda-item';

export type { AgendaSourceRef, AgendaSourceRole } from './agenda-source-links';
export type AgendaOrigin = 'MANUAL' | 'AUTOMATIC';

/** Colonnes propres à un chemin (agenda manuel, T4), hors description de l'événement. */
export interface AgendaItemDetails {
  createdByUserId?: number | null;
  description?: string | null;
  startTime?: string | null;
  endDate?: string | null;
  endTime?: string | null;
  manualStatus?: 'realise' | 'annule' | null;
  requiresQualification?: boolean;
  /** Mise à jour : l'élément automatique a été modifié par l'utilisateur. */
  isAutomaticModified?: boolean;
  /** Historique : un appelant du chemin manuel peut marquer l'élément automatique. */
  isAutomatic?: boolean;
  originType?: string;
  originRefType?: string | null;
  originRefId?: number | null;
  /** Occurrence T4 (0158) : nature, provenance de la date, série. `null` = valeurs par défaut. */
  occurrence?: { nature?: 'FORECAST' | 'CONFIRMED'; dateSource?: string | null; seriesKey?: string | null } | null;
  /** Colonnes additionnelles d'une mise à jour (confirmation d'une prévision…). */
  extra?: Partial<AgendaItemValues>;
}

export interface AgendaUpsertInput {
  /** Mise à jour de cet élément ; absent = création (ou mise à jour par clé). */
  itemId?: number;
  accountId: number;
  /** Bien de l'élément (lien `agenda_asset_links`). */
  assetId: number | null;
  /** Cible fine optionnelle : pièce ou équipement du bien. */
  target?: { type: 'ROOM' | 'EQUIPMENT'; id: number } | null;
  origin: AgendaOrigin;
  /** HISTORICAL | DEADLINE ; à défaut déduite du registre (champ d'origine, type métier). */
  nature?: AgendaEventNature | null;
  /** Type métier de l'EVENT_CATALOG du registre. */
  businessType?: string | null;
  category?: HomeCategory | null;
  /** Date (`AAAA-MM-JJ`). */
  date?: string | null;
  title?: string;
  /** Règle de récurrence de la série (`recurrence_json`). */
  recurrence?: Record<string, unknown> | null;
  /** Documents de l'élément : source, pièce jointe, preuve. */
  sources?: AgendaSourceRef[];
  /** Clé fonctionnelle (automatique) ; calculée si absente et `occurrenceIndex` fourni. */
  functionalKey?: string | null;
  originFieldKey?: string | null;
  /** Occurrence dans la source : `single`, date de l'occurrence, ou rang. */
  occurrenceIndex?: string | number | null;
  /**
   * Cible de la CLÉ si elle diffère de `target` (cible T1 : équipement, pièce).
   * Pièce = sous-structure depuis D-G (lot 20) : `target` et clé coïncident.
   */
  keyTarget?: { type: string; id: number } | null;
  details?: AgendaItemDetails;
  /**
   * Liaisons complètes (agenda manuel : plusieurs biens, documents, pièces,
   * équipements) ; remplacent `assetId` / `target` / documents ATTACHMENT.
   */
  links?: AgendaItemLinks;
}

export interface AgendaUpsertOptions {
  actorUserId?: number | null;
  /** Contrôles de dates et de cohérence des liens (agenda manuel). */
  validate?: boolean;
  /** Notification de création (biens liés) ; HISTORICAL jamais (D-14). */
  notify?: boolean;
  /** Recopie « achat » (D-13) ; voir `writeAgendaItem`. */
  purchaseSync?: WriteAgendaItemOptions['purchaseSync'];
  /** Liaisons remplacées (état complet) ou ajoutées. Défaut : manuel `replace`, automatique `add`. */
  linkMode?: 'replace' | 'add';
  /** Transaction englobante (résolution d'une carte À traiter). */
  client?: WriteAgendaItemOptions['client'];
  /** Mise à jour automatique gardée (voir `writeAgendaItem`) ; défaut : vrai pour une mise à jour AUTOMATIQUE par clé. */
  onlyIfUntouched?: boolean;
}

export type AgendaUpsertResult = WriteAgendaItemResult & {
  /** Élément de même clé modifié par l'utilisateur : rien n'a été écrit. */
  protected?: boolean;
};

const defini = <T>(v: T | undefined): v is T => v !== undefined;

/** Source principale (document qui a produit l'élément automatique). */
export const primarySource = (input: Pick<AgendaUpsertInput, 'sources'>): AgendaSourceRef | undefined =>
  input.sources?.find((s) => s.role === 'SOURCE');

/**
 * Colonnes `agenda_items` d'une entrée — pure, testée (parité avec les deux
 * chemins historiques). Création : colonnes complètes du chemin ; mise à
 * jour (`itemId`) : seulement ce que l'entrée fournit, plus `updatedAt`.
 */
export function agendaItemValues(input: AgendaUpsertInput): Partial<AgendaItemValues> {
  const d = input.details ?? {};
  const src = primarySource(input);
  if (input.itemId === undefined) {
    if (input.origin === 'MANUAL') {
      return {
        createdByUserId: d.createdByUserId ?? null,
        title: input.title ?? '',
        description: d.description ?? null,
        startDate: input.date ?? null,
        startTime: d.startTime ?? null,
        endDate: d.endDate ?? null,
        endTime: d.endTime ?? null,
        manualStatus: d.manualStatus ?? null,
        isAutomatic: d.isAutomatic ?? false,
        isAutomaticModified: false,
        requiresQualification: d.requiresQualification ?? false,
        originType: d.originType ?? 'manual',
        originRefType: d.originRefType ?? null,
        originRefId: d.originRefId ?? null,
        originFieldKey: input.originFieldKey ?? null,
        homeCategory: input.category ?? null,
      };
    }
    return {
      title: input.title ?? '',
      ...(defini(d.description) ? { description: d.description } : {}),
      startDate: input.date ?? null,
      homeCategory: input.category ?? null,
      isAutomatic: true,
      isAutomaticModified: false,
      requiresQualification: d.requiresQualification ?? false,
      // `asset_field` lorsque l'échéance découle d'un champ de fiche,
      // `qualified_document` lorsqu'elle est lue directement dans un document.
      originType: d.originType ?? (input.originFieldKey ? 'asset_field' : 'qualified_document'),
      originFieldKey: input.originFieldKey ?? null,
      // Conservation de la source (§4.4.4).
      originRefType: defini(d.originRefType) ? d.originRefType : (src ? 'asset_file' : null),
      originRefId: defini(d.originRefId) ? d.originRefId : (src?.fileId ?? null),
      ...(defini(d.occurrence) ? {
        occurrenceNature: d.occurrence?.nature ?? 'CONFIRMED',
        dateSource: d.occurrence?.dateSource ?? 'EXPLICIT_DATE',
        seriesKey: d.occurrence?.seriesKey ?? null,
        recurrenceJson: (input.recurrence ?? null) as never,
      } : {}),
    };
  }
  // Mise à jour : ce qui est fourni, rien d'autre.
  const v: Partial<AgendaItemValues> = {};
  if (defini(input.title)) v.title = input.title;
  if (defini(input.date)) v.startDate = input.date;
  if (defini(input.category)) v.homeCategory = input.category;
  if (defini(input.originFieldKey) && input.origin === 'AUTOMATIC') v.originFieldKey = input.originFieldKey;
  if (defini(d.description)) v.description = d.description;
  if (defini(d.startTime)) v.startTime = d.startTime;
  if (defini(d.endDate)) v.endDate = d.endDate;
  if (defini(d.endTime)) v.endTime = d.endTime;
  if (defini(d.manualStatus)) v.manualStatus = d.manualStatus;
  if (defini(d.requiresQualification)) v.requiresQualification = d.requiresQualification;
  if (defini(d.isAutomaticModified)) v.isAutomaticModified = d.isAutomaticModified;
  if (defini(d.originRefType)) v.originRefType = d.originRefType;
  if (defini(d.originRefId)) v.originRefId = d.originRefId;
  if (!defini(d.originRefType) && input.origin === 'AUTOMATIC' && defini(input.sources) && input.sources.every((s) => s.role !== 'PROOF')) {
    // Mise à jour automatique : la source est celle de la dernière décision.
    v.originRefType = src ? 'asset_file' : null;
    v.originRefId = src?.fileId ?? null;
  }
  return { ...v, ...(d.extra ?? {}), updatedAt: new Date() };
}

/** Liaisons de l'élément : explicites (manuel), sinon bien + cible. */
export function agendaItemLinks(input: AgendaUpsertInput): AgendaItemLinks | undefined {
  if (input.links) return input.links;
  if (input.itemId !== undefined && input.assetId === null && !input.target) return undefined;
  return {
    assetIds: input.assetId ? [input.assetId] : [],
    substructureIds: input.target?.type === 'ROOM' ? [input.target.id] : [],
    equipmentIds: input.target?.type === 'EQUIPMENT' ? [input.target.id] : [],
  };
}

/** Clé fonctionnelle d'un élément automatique (fournie, ou calculée). */
export function functionalKeyFor(input: AgendaUpsertInput): string | null {
  if (input.origin !== 'AUTOMATIC') return null;
  if (input.functionalKey) return input.functionalKey;
  const src = primarySource(input);
  if (!src || input.occurrenceIndex == null) return null;
  const target = input.keyTarget ?? input.target ?? (input.assetId ? { type: 'ASSET' as const, id: input.assetId } : null);
  if (!target) return null;
  const sem = resolveEventSemantics({ originFieldKey: input.originFieldKey, businessType: input.businessType, nature: input.nature });
  return computeAgendaFunctionalKey({
    sourceFileId: src.fileId, target, businessType: sem.businessType,
    originFieldKey: input.originFieldKey ?? null, occurrence: String(input.occurrenceIndex),
  });
}

/** Élément automatique existant de même clé (0223 présente). */
async function itemByKey(accountId: number, key: string) {
  const rows = (await pgClient.unsafe(
    `SELECT id, is_automatic AS "isAutomatic", is_automatic_modified AS "isAutomaticModified", manual_status AS "manualStatus"
       FROM agenda_items WHERE account_id = $1 AND functional_key = $2 AND is_automatic LIMIT 1`,
    [accountId, key] as never[],
  )) as unknown as Array<{ id: number; isAutomatic: boolean; isAutomaticModified: boolean; manualStatus: string | null }>;
  return rows[0] ? { ...rows[0], id: Number(rows[0].id) } : null;
}

/**
 * Crée ou met à jour un élément d'agenda (voir l'en-tête). Lève
 * `AgendaValidationError` sur une entrée invalide — rien n'est écrit.
 */
export async function upsertAgendaItem(input: AgendaUpsertInput, opts: AgendaUpsertOptions = {}): Promise<AgendaUpsertResult> {
  // Colonnes 0223 présentes : clé fonctionnelle, nature, liens source (T4).
  const effets = await agendaFunctionalColumnsReady();
  const creation = input.itemId === undefined;
  if (creation && !input.title?.trim()) throw new AgendaValidationError('Validation : titre requis');

  // Validation commune : les dates de l'élément automatique suivent
  // les mêmes règles que celles de l'agenda manuel.
  if (effets && input.origin === 'AUTOMATIC' && !opts.validate) {
    const erreurs = validateTemporalConstraints({ startDate: input.date ?? undefined });
    if (erreurs.length) throw new AgendaValidationError(`Validation temporelle : ${erreurs.map((e) => e.message).join(', ')}`);
  }

  const functionalKey = functionalKeyFor(input);
  let itemId = input.itemId;
  if (creation && effets && functionalKey) {
    const existant = await itemByKey(input.accountId, functionalKey);
    if (existant) {
      if (isUserTouched(existant)) {
        return {
          id: existant.id, created: false, protected: true, functionalKey,
          ...resolveEventSemantics({ originFieldKey: input.originFieldKey, businessType: input.businessType, nature: input.nature }),
        };
      }
      itemId = existant.id;
    }
  }
  const entree: AgendaUpsertInput = itemId !== input.itemId ? { ...input, itemId } : input;

  const write = () => writeAgendaItem({
    itemId,
    values: agendaItemValues(entree),
    links: agendaItemLinks(entree),
    sources: input.sources ?? [],
    semantics: { businessType: input.businessType ?? null, nature: input.nature ?? null },
    functionalKey,
  }, {
    accountId: input.accountId,
    actorUserId: opts.actorUserId ?? null,
    channel: input.origin === 'MANUAL' ? 'MANUAL' : 'T4',
    linkMode: opts.linkMode ?? (input.origin === 'MANUAL' ? 'replace' : 'add'),
    validate: opts.validate,
    notify: opts.notify,
    purchaseSync: opts.purchaseSync,
    client: opts.client,
    // Une mise à jour automatique n'écrase jamais un geste de l'utilisateur,
    // même concurrent (WHERE gardé).
    onlyIfUntouched: opts.onlyIfUntouched ?? (itemId !== undefined && itemId !== input.itemId && input.origin === 'AUTOMATIC'),
  });

  try {
    const res = await write();
    // R5 : une carte AGENDA-PROPOSAL de même clé (dates ambiguës, source non
    // autoritaire) est sans objet dès que l'élément existe. Ne fait jamais
    // échouer l'écriture.
    if (effets && functionalKey) {
      try {
        const { closeObsoleteAgendaProposals } = await import('@/services/to-process/agenda-proposal-cards');
        const { db } = await import('@/db');
        await closeObsoleteAgendaProposals((opts.client ?? db) as never, input.accountId, functionalKey);
      } catch (err) {
        console.error(`[agenda] cartes AGENDA-PROPOSAL de ${functionalKey} :`, (err as Error).message);
      }
    }
    return res;
  } catch (e) {
    // Course sur la clé (index unique partiel) : l'élément vient d'être créé
    // par un autre passage — mise à jour.
    if (creation && effets && functionalKey && itemId === undefined && /agenda_items_functional_key_uidx/.test(String((e as Error).message) + String((e as { cause?: Error }).cause?.message ?? ''))) {
      const existant = await itemByKey(input.accountId, functionalKey);
      if (existant && !isUserTouched(existant)) return upsertAgendaItem({ ...input, itemId: existant.id }, opts);
    }
    throw e;
  }
}

export interface RemoveFromSourceResult {
  /** Éléments retirés, ou qui le seraient (analyse incomplète). */
  removed: number[];
  dryRun: boolean;
  /** Pourquoi rien n'a été retiré, le cas échéant. */
  skipped?: 'COLUMNS_MISSING' | 'ANALYSIS_INCOMPLETE';
}

/**
 * Retire les éléments AUTOMATIQUES d'une source dont la clé n'est plus
 * produite (T4-08). Jamais un élément modifié par l'utilisateur.
 *
 *  · source : `origin_ref` = document, ou lien SOURCE du service de liaison ;
 *  · conservés : clé dans `keepKeys`, identifiant dans `keepIds` ;
 *  · `assetId` : restreint aux éléments rattachés à ce bien (une source
 *    multi-biens n'est synchronisée que pour le bien réanalysé) ;
 *  · `analysisComplete` : l'analyse qui a produit `keepKeys` est COMPLÈTE
 *    (contenu exploitable, ni extraction partielle, ni repli, ni troncature,
 *    ni source injoignable — voir `analysis-completeness.ts`). Faux ou
 *    absent : rien n'est retiré, le plan est journalisé — une réanalyse vide
 *    ou dégradée ne vide jamais l'agenda ;
 *  · retrait TRACÉ (`agenda_item_removals`, rattrapable) — voir
 *    `agenda-removal-trace.ts`.
 */
export async function removeAgendaItemsFromSource(p: {
  accountId: number;
  sourceFileId: number;
  keepKeys: string[];
  keepIds?: number[];
  assetId?: number | null;
  analysisComplete?: boolean;
}): Promise<RemoveFromSourceResult> {
  if (!(await agendaFunctionalColumnsReady())) return { removed: [], dryRun: true, skipped: 'COLUMNS_MISSING' };
  const rows = (await pgClient.unsafe(
    `SELECT i.id, i.functional_key AS "functionalKey", i.is_automatic AS "isAutomatic",
            i.is_automatic_modified AS "isAutomaticModified", i.manual_status AS "manualStatus"
       FROM agenda_items i
      WHERE i.account_id = $1 AND i.is_automatic
        AND ((i.origin_ref_type = 'asset_file' AND i.origin_ref_id = $2)
             OR EXISTS (SELECT 1 FROM agenda_item_sources s
                         WHERE s.agenda_item_id = i.id AND s.asset_file_id = $2 AND s.effect_type = 'linked'
                           AND s.source_role = 'SOURCE'))
        AND ($3::int IS NULL OR EXISTS (SELECT 1 FROM agenda_asset_links l WHERE l.agenda_item_id = i.id AND l.asset_id = $3))`,
    [p.accountId, p.sourceFileId, p.assetId ?? null] as never[],
  ).catch(async (e: Error) => {
    // Colonnes `source_role` absentes : origine seule.
    if (!/source_role/.test(e.message)) throw e;
    return pgClient.unsafe(
      `SELECT i.id, i.functional_key AS "functionalKey", i.is_automatic AS "isAutomatic",
              i.is_automatic_modified AS "isAutomaticModified", i.manual_status AS "manualStatus"
         FROM agenda_items i
        WHERE i.account_id = $1 AND i.is_automatic AND i.origin_ref_type = 'asset_file' AND i.origin_ref_id = $2
          AND ($3::int IS NULL OR EXISTS (SELECT 1 FROM agenda_asset_links l WHERE l.agenda_item_id = i.id AND l.asset_id = $3))`,
      [p.accountId, p.sourceFileId, p.assetId ?? null] as never[],
    );
  })) as unknown as Array<{ id: number; functionalKey: string | null; isAutomatic: boolean; isAutomaticModified: boolean; manualStatus: string | null }>;

  const cles = new Set(p.keepKeys);
  const ids = new Set(p.keepIds ?? []);
  const retires = rows
    .map((r) => ({ ...r, id: Number(r.id) }))
    .filter((r) => !isUserTouched(r) && !ids.has(r.id) && !(r.functionalKey && cles.has(r.functionalKey)))
    .map((r) => r.id);

  const journal = (extra: Record<string, unknown>) => console.info(JSON.stringify({
    event: 't4.source_remove', accountId: p.accountId, sourceFileId: p.sourceFileId, assetId: p.assetId ?? null, ...extra,
  }));
  if (p.analysisComplete !== true) {
    journal({ wouldRemove: retires, dryRun: true, skipped: 'ANALYSIS_INCOMPLETE' });
    return { removed: retires, dryRun: true, skipped: 'ANALYSIS_INCOMPLETE' };
  }
  const { removeAgendaItemsTraced } = await import('./agenda-removal-trace');
  const removed = await removeAgendaItemsTraced(pgClient, {
    accountId: p.accountId, ids: retires, reason: 'SOURCE_SYNC', sourceFileId: p.sourceFileId, assetId: p.assetId ?? null,
  });
  if (removed.length) journal({ removed, dryRun: false });
  return { removed, dryRun: false };
}
