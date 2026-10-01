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
import { createHash } from 'crypto';
import { db, pgClient } from '@/db';
import { agendaItems, agendaAssetLinks, agendaOccurrenceEvents, assetFiles } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import type { AgendaDecision, ExistingAgendaItem, HomeCategory } from '@/services/ai/agenda';
import { t4EffectsMode, type RolloutMode } from '@/services/canonical/rollout';
import type { AgendaItemValues } from './write-agenda-item';
import { AGENDA_PROPOSAL_REASONS } from '@/services/to-process/agenda-proposal-cards';
import {
  upsertAgendaItem, removeAgendaItemsFromSource, agendaItemValues, functionalKeyFor, type AgendaUpsertInput, type AgendaSourceRef,
} from './agenda-write-primitive';
import { agendaFunctionalColumnsReady } from './agenda-columns';
import { statusReconciliationActive, parseSeriesRecurrence } from './agenda-status-sync';
import {
  planSourceSync, resolveEventSemantics, keyTarget, type SourceSyncPlan, type SourceItem, type SyncStep, type AgendaEventNature,
} from './agenda-functional-key';

/** Sémantique T4 recopiée du candidat (A, enabled) : nature et type métier. */
const semanticsOf = (d: AgendaDecision): { businessType: string | null; nature: AgendaEventNature | null } =>
  ({ businessType: d.businessType ?? null, nature: d.nature ?? null });

/** Document source principal d'une décision : `sourceFileId`, sinon la première source. */
const sourceOf = (d: AgendaDecision): number | null =>
  d.sourceFileId ?? d.sources?.find((x) => Number.isInteger(x.fileId) && x.fileId > 0)?.fileId ?? null;

/**
 * Sources de la décision (T4-07) : celles du candidat, avec rôle et preuve
 * (`evidenceId`) ; à défaut, le document source seul.
 */
export function decisionSources(d: AgendaDecision): AgendaSourceRef[] {
  const depuisCandidat = (d.sources ?? [])
    .filter((x) => Number.isInteger(x.fileId) && x.fileId > 0)
    .map((x) => ({ fileId: x.fileId, role: x.role ?? 'SOURCE', evidenceId: x.evidenceId ?? null }));
  if (depuisCandidat.length > 0) {
    // Une même source n'est citée qu'une fois ; le document principal en tête.
    const principal = d.sourceFileId ?? depuisCandidat[0].fileId;
    // Doublon : la première citation portant une preuve l'emporte.
    const parCle = new Map<string, AgendaSourceRef>();
    for (const x of depuisCandidat) {
      const k = `${x.fileId}|${x.role}`;
      const deja = parCle.get(k);
      if (!deja || (deja.evidenceId == null && x.evidenceId != null)) parCle.set(k, x);
    }
    const uniques = [...parCle.values()];
    return uniques.sort((a, b) => Number(b.fileId === principal) - Number(a.fileId === principal));
  }
  return d.sourceFileId ? [{ fileId: d.sourceFileId, role: 'SOURCE' }] : [];
}

/**
 * Cible fine de l'élément (lien agenda) : un ÉQUIPEMENT identifié. Une pièce
 * T1 (`rooms`) n'est pas une pièce de l'agenda (`substructures`) : elle
 * entre dans la clé, pas dans les liens.
 */
const agendaTargetOf = (d: AgendaDecision): AgendaUpsertInput['target'] =>
  d.target?.type === 'EQUIPMENT' && d.target.id != null ? { type: 'EQUIPMENT', id: d.target.id } : null;

export interface PersistAgendaOptions {
  /**
   * Document source des décisions (réanalyse). Fourni — ou commun à toutes
   * les décisions — il déclenche la synchronisation de la source (T4-08) en
   * AI_T4_EFFECTS=shadow/enabled, y compris avec ZÉRO décision (tous les
   * événements de la source ont disparu).
   */
  sourceFileId?: number | null;
  /**
   * L'analyse qui a produit les décisions est COMPLÈTE
   * (`analysis-completeness.ts`). Seule une analyse complète RETIRE les
   * éléments automatiques qu'elle ne produit plus ; absent = incomplète :
   * créations et mises à jour ont lieu, aucun retrait (journalisé).
   */
  analysisComplete?: boolean;
  /** Avertissements d'incomplétude (journal). */
  incompleteReasons?: string[];
  /** Force un mode (tests) ; défaut : `AI_T4_EFFECTS`. */
  mode?: RolloutMode;
}

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
      occurrenceNature: agendaItems.occurrenceNature,
      seriesKey: agendaItems.seriesKey,
      recurrenceJson: agendaItems.recurrenceJson,
    })
    .from(agendaItems)
    .innerJoin(agendaAssetLinks, eq(agendaAssetLinks.agendaItemId, agendaItems.id))
    .where(and(
      eq(agendaItems.accountId, accountId),
      eq(agendaAssetLinks.assetId, assetId),
    ))
    .limit(500);

  // Récurrence portée par une autre occurrence de la même série.
  const seriesRecurrence = new Map<string, unknown>();
  for (const r of rows) if (r.seriesKey && r.recurrenceJson && !seriesRecurrence.has(r.seriesKey)) seriesRecurrence.set(r.seriesKey, r.recurrenceJson);

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
      nature: (r.occurrenceNature as 'FORECAST' | 'CONFIRMED' | null) ?? 'CONFIRMED',
      seriesKey: r.seriesKey,
      // CDC 15 T4-13/T4-14 (lot 14) : type métier (champ d'origine au
      // registre) et récurrence de la série — preuves et fenêtre d'occurrence.
      businessType: resolveEventSemantics({ originFieldKey: r.originFieldKey }).businessType,
      recurrence: parseSeriesRecurrence(r.recurrenceJson ?? seriesRecurrence.get(r.seriesKey ?? ''), r.originFieldKey),
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
  opts: PersistAgendaOptions = {},
): Promise<void> {
  const mode = opts.mode ?? t4EffectsMode();
  // ══════════════════════════════════════════════════════════════════════
  // SYNCHRONISATION DE LA SOURCE (CDC 15 T4-08) — AI_T4_EFFECTS
  //   legacy   rien : chaque décision est appliquée comme avant ;
  //   shadow   plan calculé et journalisé (créations, mises à jour,
  //            retraits), sans effet sur l'écriture ;
  //   enabled  clé fonctionnelle : une décision créatrice met à jour
  //            l'élément de même clé (ou l'adopte), un élément modifié à la
  //            main n'est jamais touché, et les éléments automatiques de la
  //            source que plus rien ne produit sont retirés.
  // ══════════════════════════════════════════════════════════════════════
  const plan = mode === 'legacy' ? null : await planForSource(decisions, accountId, assetId, opts.sourceFileId, mode);
  const actif = mode === 'enabled' ? plan : null;
  // T4-10 (lot 14) : une classification à faire confirmer (`unknown` rendu
  // prudent, confiance insuffisante) est écrite dans `requires_qualification`
  // — sous AI_T4_EFFECTS=enabled ou T4 `master`, comme la décision de A.
  const qualification = decisions.some((d) => d.classification?.requiresQualification)
    && await statusReconciliationActive(mode);
  const qualifier = (d: AgendaDecision, base: boolean) => base || (qualification && d.classification?.requiresQualification === true);

  for (const [index, decision] of decisions.entries()) {
    const step = actif?.steps.find((x) => x.index === index);
    try {
      // CDC 15 T4-04 (enabled) : échéance d'une source non autoritaire →
      // carte « Ajouter à l'agenda ? », aucun élément créé ni mis à jour.
      if (mode === 'enabled' && decision.action === 'propose' && AGENDA_PROPOSAL_REASONS.has(decision.reasonCode)) {
        if (!step || step.kind === 'create') await proposeFromDecision(decision, accountId, assetId, step?.key ?? null);
        continue;
      }
      if (step && step.kind !== 'create' && (decision.action === 'create' || decision.action === 'propose' || decision.action === 'create_conflict')) {
        await applySyncStep(step, decision, accountId, qualification ? qualifier(decision, decision.action === 'propose') : undefined);
        continue;
      }
      const cle = step?.kind === 'create' ? step.key : null;
      switch (decision.action) {
        case 'create':
          await createItem(decision, accountId, assetId, qualifier(decision, false), cle, mode);
          break;

        case 'propose':
          // Preuve insuffisante : l'événement est créé mais demande une
          // qualification par l'utilisateur avant d'être tenu pour acquis.
          await createItem(decision, accountId, assetId, qualifier(decision, true), cle, mode);
          break;

        case 'update':
          // Seul un rapprochement CERTAIN ou un arbitrage confirmé autorise une
          // mise à jour : un rapprochement probable n'arrive jamais ici.
          if (decision.duplicate || /PROBABLE/.test(decision.reasonCode)) {
            console.warn(`[agenda-persistence] mise à jour refusée pour un rapprochement probable (${decision.reasonCode})`);
            await createDuplicateArbitration(decision, accountId, assetId);
            break;
          }
          await updateItem(decision, accountId, mode);
          break;

        case 'arbitrate_duplicate':
          await createDuplicateArbitration(decision, accountId, assetId);
          break;

        case 'create_conflict':
          await createConflict(decision, accountId, assetId, cle, mode);
          break;

        case 'skip_duplicate':
          // Un doublon certain n'est jamais recréé (§4.4.4). La consolidation
          // est tracée sur l'échéance existante : c'est l'indicateur
          // « consolidées » de l'écran T4 (T4-UI-06, SCR-05).
          await recordConsolidation(decision, accountId);
          break;

        case 'retire_forecast':
          await retireForecast(decision, accountId);
          break;

        case 'confirm_forecast':
          await confirmForecast(decision, accountId);
          break;
      }
    } catch (e) {
      console.error(
        `[agenda-persistence] décision « ${decision.action} » sur « ${decision.title} » :`,
        (e as Error).message,
      );
    }
  }

  // Retraits : éléments automatiques intacts de la source que plus rien ne produit.
  if (actif && actif.remove.length) {
    try {
      await removeAgendaItemsFromSource({
        accountId, sourceFileId: actif.sourceFileId, assetId, mode,
        keepKeys: actif.steps.map((x) => x.key), keepIds: actif.keep,
        analysisComplete: opts.analysisComplete === true,
      });
      if (opts.analysisComplete !== true) {
        console.info(JSON.stringify({
          event: 't4.source_sync_no_removal', accountId, assetId, sourceFileId: actif.sourceFileId,
          reasons: opts.incompleteReasons ?? ['UNKNOWN'], wouldRemove: actif.remove,
        }));
      }
    } catch (e) {
      console.error(`[agenda-persistence] retrait des éléments de la source ${actif.sourceFileId} :`, (e as Error).message);
    }
  }
}

/** Plan de synchronisation (T4-08), ou null si pas de source unique / 0223 absente. */
async function planForSource(
  decisions: AgendaDecision[],
  accountId: number,
  assetId: number,
  explicite: number | null | undefined,
  mode: RolloutMode,
): Promise<SourceSyncPlan | null> {
  const sources = new Set(decisions.map(sourceOf).filter((x): x is number => typeof x === 'number'));
  const sourceFileId = explicite ?? (sources.size === 1 ? [...sources][0] : null);
  if (!sourceFileId || (sources.size > 1 && !explicite)) return null;
  if (!(await agendaFunctionalColumnsReady())) return null;
  try {
    const items = await loadSourceItems(accountId, assetId, sourceFileId);
    const plan = planSourceSync({
      sourceFileId, assetId, items,
      decisions: decisions.map((d, index) => ({
        index, action: d.action, title: d.title, date: d.date, sourceFileId: sourceOf(d),
        originFieldKey: d.originFieldKey ?? null, existingItemId: d.existingItemId ?? null,
        seriesKey: d.occurrence?.seriesKey ?? null, ...semanticsOf(d),
        occurrenceIndex: d.occurrenceIndex ?? null, target: d.target ?? null,
      })),
    });
    console.info(JSON.stringify({
      event: 't4.source_sync', mode, accountId, assetId, sourceFileId,
      create: plan.steps.filter((x) => x.kind === 'create').length,
      update: plan.steps.filter((x) => x.kind === 'update').map((x) => (x as { itemId: number }).itemId),
      protected: plan.steps.filter((x) => x.kind === 'protected').map((x) => (x as { itemId: number }).itemId),
      remove: plan.remove, dryRun: mode !== 'enabled',
    }));
    return plan;
  } catch (e) {
    console.error(`[agenda-persistence] plan de synchronisation de la source ${sourceFileId} :`, (e as Error).message);
    return null;
  }
}

/** Éléments AUTOMATIQUES d'une source rattachés au bien (colonnes 0223 comprises). */
async function loadSourceItems(accountId: number, assetId: number, sourceFileId: number): Promise<SourceItem[]> {
  const rows = (await pgClient.unsafe(
    `SELECT i.id, i.functional_key AS "functionalKey", i.title, i.start_date::text AS "startDate",
            i.origin_field_key AS "originFieldKey", i.is_automatic AS "isAutomatic",
            i.is_automatic_modified AS "isAutomaticModified", i.manual_status AS "manualStatus"
       FROM agenda_items i
       JOIN agenda_asset_links l ON l.agenda_item_id = i.id AND l.asset_id = $3
      WHERE i.account_id = $1 AND i.origin_ref_type = 'asset_file' AND i.origin_ref_id = $2 AND i.is_automatic`,
    [accountId, sourceFileId, assetId] as never[],
  )) as unknown as SourceItem[];
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

/** Décision créatrice rattachée à un élément existant de même clé (T4-08, enabled). */
async function applySyncStep(step: SyncStep, decision: AgendaDecision, accountId: number, requiresQualification?: boolean): Promise<void> {
  if (step.kind === 'protected') {
    console.info(`[agenda-persistence] élément ${step.itemId} modifié à la main — synchronisation sans effet`);
    return;
  }
  if (step.kind !== 'update') return;
  // Une source qui n'autorise pas la création ne met pas non plus à jour un
  // élément existant (T4-04) : il reste tel quel.
  if (decision.mayCreateAgenda === false) {
    console.info(`[agenda-persistence] élément ${step.itemId} : source non autoritaire — synchronisation sans effet`);
    return;
  }
  const base = t4UpsertInput(decision, accountId, null, requiresQualification ?? false, step.key);
  await upsertAgendaItem({
    itemId: step.itemId, accountId, assetId: null, origin: 'AUTOMATIC',
    title: base.title, date: base.date, category: base.category, nature: base.nature, businessType: base.businessType,
    sources: base.sources, functionalKey: step.key,
    details: requiresQualification === undefined ? {} : { requiresQualification },
  }, { mode: 'enabled', onlyIfUntouched: true });
}

/**
 * Entrée de la primitive pour une décision T4 (CDC 15 T4-09) : même
 * description de l'événement que l'agenda manuel ; nature et type métier
 * explicites ou déduits du registre.
 */
export function t4UpsertInput(
  decision: AgendaDecision,
  accountId: number,
  assetId: number | null,
  requiresQualification: boolean,
  functionalKey: string | null,
): AgendaUpsertInput {
  const sem = resolveEventSemantics({ originFieldKey: decision.originFieldKey ?? null, ...semanticsOf(decision) });
  const principal = sourceOf(decision);
  return {
    accountId,
    assetId,
    target: agendaTargetOf(decision),
    origin: 'AUTOMATIC',
    nature: sem.nature,
    businessType: sem.businessType,
    category: decision.category,
    date: decision.date,
    title: decision.title,
    recurrence: (decision.occurrence?.recurrence ?? null) as Record<string, unknown> | null,
    sources: decisionSources(decision),
    functionalKey,
    originFieldKey: decision.originFieldKey ?? null,
    occurrenceIndex: decision.occurrenceIndex ?? null,
    // Cible de la clé : la même que le plan de synchronisation (`keyTarget`).
    ...(assetId ? { keyTarget: keyTarget(decision.target, assetId) } : {}),
    details: {
      requiresQualification,
      // Conservation de la source (§4.4.4) : le document principal.
      originRefType: principal ? 'asset_file' : null,
      originRefId: principal,
      // Nature et provenance de l'occurrence : une date calculée d'une
      // récurrence reste identifiable comme PRÉVISIONNELLE.
      occurrence: decision.occurrence
        ? { nature: decision.occurrence.nature, dateSource: decision.occurrence.dateSource, seriesKey: decision.occurrence.seriesKey }
        : null,
    },
  };
}

/**
 * Carte AGENDA-PROPOSAL d'une décision de source non autoritaire (T4-04).
 * Sans document source : comportement antérieur (élément à qualifier).
 */
async function proposeFromDecision(decision: AgendaDecision, accountId: number, assetId: number, planKey: string | null): Promise<void> {
  const input = t4UpsertInput(decision, accountId, assetId, true, planKey);
  const source = sourceOf(decision);
  if (!source) {
    await createItem(decision, accountId, assetId, true, planKey, 'enabled');
    return;
  }
  const { proposeAgendaCreation } = await import('@/services/to-process/agenda-proposal-cards');
  await proposeAgendaCreation({
    accountId,
    sourceFileId: source,
    functionalKey: planKey ?? functionalKeyFor(input),
    candidate: {
      title: decision.title, date: decision.date, category: decision.category,
      originFieldKey: decision.originFieldKey ?? null, nature: input.nature ?? null, businessType: input.businessType ?? null,
      assetId, target: input.target?.type === 'EQUIPMENT' ? { type: 'EQUIPMENT', id: input.target.id } : null,
      sources: input.sources ?? [], reasonCode: decision.reasonCode, documentType: decision.documentType ?? null,
      ...(decision.temporalCandidates?.length ? { alternatives: decision.temporalCandidates } : {}),
    },
  });
}

/** Valeurs d'un élément créé par T4 — identiques à l'historique (parité). */
export function t4InsertValues(decision: AgendaDecision, requiresQualification: boolean): AgendaItemValues {
  return agendaItemValues(t4UpsertInput(decision, 0, null, requiresQualification, null)) as AgendaItemValues;
}

async function createItem(
  decision: AgendaDecision,
  accountId: number,
  assetId: number,
  requiresQualification: boolean,
  functionalKey: string | null,
  mode: RolloutMode,
): Promise<void> {
  let itemId: number;
  if (mode === 'enabled') {
    // Primitive commune (CDC 15 T4-09) : mêmes validations, liens (bien,
    // source), nature, clé et effets (D-13, D-14, D-15) que l'agenda manuel.
    const res = await upsertAgendaItem(
      t4UpsertInput(decision, accountId, assetId, requiresQualification, functionalKey),
      { mode, notify: true, purchaseSync: {} },
    );
    if (res.protected || !res.created) return;
    itemId = res.id;
  } else {
    // legacy / shadow : écriture historique, à l'identique.
    const [item] = await db.insert(agendaItems).values({
      accountId, ...t4InsertValues(decision, requiresQualification),
    }).returning({ id: agendaItems.id });
    await linkToAsset(item.id, assetId);
    itemId = item.id;
  }

  if (decision.occurrence?.nature === 'FORECAST') {
    await recordOccurrenceEvent(itemId, accountId, 'FORECAST_CREATED', {
      date: decision.date, rule: decision.occurrence.recurrence?.rule, mode: decision.occurrence.recurrence?.mode,
      referenceDate: decision.occurrence.recurrence?.referenceDate, sourceFileId: decision.sourceFileId ?? null,
      seriesKey: decision.occurrence.seriesKey,
    });
  }
}

/** Rattache l'événement au bien (chemin historique). L'index d'unicité rend l'opération idempotente. */
async function linkToAsset(agendaItemId: number, assetId: number): Promise<void> {
  await db.insert(agendaAssetLinks)
    .values({ agendaItemId, assetId })
    .onConflictDoNothing();
}

/** Type d'événement d'une consolidation (doublon certain rattaché à l'existant). */
export const CONSOLIDATED_EVENT = 'DUPLICATE_CONSOLIDATED';

/**
 * Seul motif de `skip_duplicate` qui soit une VRAIE consolidation : le moteur
 * émet aussi `skip_duplicate` pour chaque occurrence de récurrence déjà
 * présente (`RECURRENCE_OCCURRENCE_EXISTS`, `RECURRENCE_OCCURRENCE_IN_PERIOD`,
 * `RECURRENCE_OCCURRENCE_USER_PROTECTED`) — ce n'est pas une consolidation,
 * c'est la série qui se retrouve elle-même.
 */
export const CONSOLIDATION_REASON = 'EXACT_DUPLICATE';

/**
 * T4-UI-06 : trace une consolidation — un doublon certain venu d'une AUTRE
 * source que celle de l'échéance existante — dans `agenda_occurrence_events`
 * (sans migration : `event_type` est libre).
 *
 * N'est PAS tracé :
 *   · un autre motif que `EXACT_DUPLICATE` (occurrences de récurrence) ;
 *   · une décision sans fichier source, ou sans échéance existante (doublon
 *     interne au lot, pas encore créé) ;
 *   · la réanalyse du document qui a créé l'échéance (même source) ;
 *   · un couple (échéance, fichier source) déjà tracé : réanalyser le second
 *     document ne compte pas une nouvelle consolidation.
 * Ne bloque jamais.
 */
export async function recordConsolidation(decision: AgendaDecision, accountId: number): Promise<boolean> {
  const id = decision.existingItemId;
  const sourceFileId = decision.sourceFileId;
  if (decision.reasonCode !== CONSOLIDATION_REASON) return false;
  if (!id || id <= 0 || !sourceFileId) return false;
  try {
    const [item] = await pgClient.unsafe<{ origin_ref_type: string | null; origin_ref_id: number | null; already: boolean }[]>(
      `SELECT i.origin_ref_type, i.origin_ref_id,
              EXISTS (SELECT 1 FROM agenda_occurrence_events e
                       WHERE e.agenda_item_id = i.id AND e.event_type = $3
                         AND e.detail_json ->> 'sourceFileId' = $4) AS already
         FROM agenda_items i
        WHERE i.id = $1 AND i.account_id = $2`,
      [id, accountId, CONSOLIDATED_EVENT, String(sourceFileId)],
    );
    if (!item || item.already) return false;
    if (item.origin_ref_type === 'asset_file' && Number(item.origin_ref_id) === sourceFileId) return false;
  } catch (e) {
    console.error('[agenda] contrôle de consolidation impossible :', (e as Error).message);
    return false;
  }
  await recordOccurrenceEvent(id, accountId, CONSOLIDATED_EVENT, {
    reasonCode: decision.reasonCode,
    date: decision.date,
    sourceFileId,
    originFieldKey: decision.originFieldKey ?? null,
    deterministic: decision.deterministic,
  });
  return true;
}

/** Trace d'une étape du cycle de vie d'une occurrence. Ne bloque jamais. */
export async function recordOccurrenceEvent(
  agendaItemId: number,
  accountId: number,
  eventType: string,
  detail: Record<string, unknown>,
  actorUserId: number | null = null,
): Promise<void> {
  await db.insert(agendaOccurrenceEvents)
    .values({ agendaItemId, accountId, eventType, detailJson: detail as never, actorUserId })
    .catch((e: Error) => console.error('[agenda] trace d’occurrence non enregistrée :', e.message));
}

/**
 * Une source confirme une occurrence prévisionnelle : la MÊME occurrence
 * devient CONFIRMED (date lue si elle diffère légèrement), sa date
 * prévisionnelle initiale et la source de confirmation sont conservées.
 * Une prévision modifiée par l'utilisateur garde sa date (le moteur n'envoie
 * ici que le cas « même date » ; une date différente passe par l'arbitrage).
 */
async function confirmForecast(decision: AgendaDecision, accountId: number): Promise<void> {
  if (!decision.existingItemId) return;
  const [cur] = await db.select().from(agendaItems)
    .where(and(eq(agendaItems.id, decision.existingItemId), eq(agendaItems.accountId, accountId))).limit(1);
  if (!cur || cur.occurrenceNature !== 'FORECAST') return;
  const protege = !cur.isAutomatic || cur.isAutomaticModified;
  const nouvelleDate = protege ? cur.startDate : decision.date;
  const now = new Date();
  await db.update(agendaItems).set({
    occurrenceNature: 'CONFIRMED',
    dateSource: 'EXPLICIT_DATE',
    forecastInitialDate: cur.forecastInitialDate ?? cur.startDate,
    startDate: nouvelleDate,
    confirmedAt: now,
    confirmationMode: 'SOURCE',
    confirmationSource: { sourceFileId: decision.sourceFileId ?? null, originFieldKey: decision.originFieldKey ?? null, date: decision.date } as never,
    originRefType: decision.sourceFileId ? 'asset_file' : cur.originRefType,
    originRefId: decision.sourceFileId ?? cur.originRefId,
    updatedAt: now,
  }).where(eq(agendaItems.id, cur.id));
  await recordOccurrenceEvent(cur.id, accountId, 'CONFIRMED', {
    forecastDate: cur.startDate, confirmedDate: nouvelleDate, sourceFileId: decision.sourceFileId ?? null, mode: 'SOURCE',
    rule: (cur.recurrenceJson as { rule?: string } | null)?.rule ?? null,
  });
  if (nouvelleDate !== cur.startDate) {
    await recordOccurrenceEvent(cur.id, accountId, 'DATE_CHANGED', { from: cur.startDate, to: nouvelleDate, reason: 'confirmation par la source' });
  }
}

/**
 * Fin explicite d'une récurrence : une prévision automatique au-delà de la
 * borne n'a plus d'objet. Annulée — jamais si l'utilisateur y a touché.
 */
async function retireForecast(decision: AgendaDecision, accountId: number): Promise<void> {
  if (!decision.existingItemId) return;
  await db.update(agendaItems)
    .set({ manualStatus: 'annule', updatedAt: new Date() })
    .where(and(
      eq(agendaItems.id, decision.existingItemId),
      eq(agendaItems.accountId, accountId),
      eq(agendaItems.occurrenceNature, 'FORECAST'),
      eq(agendaItems.isAutomatic, true),
      eq(agendaItems.isAutomaticModified, false),
    ));
}

async function updateItem(decision: AgendaDecision, accountId: number, mode: RolloutMode): Promise<void> {
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

  if (mode === 'enabled') {
    const base = t4UpsertInput(decision, accountId, null, false, null);
    await upsertAgendaItem({
      itemId: decision.existingItemId, accountId, assetId: null, origin: 'AUTOMATIC',
      title: base.title, date: base.date, category: base.category, nature: base.nature, businessType: base.businessType,
      sources: base.sources,
    }, { mode, onlyIfUntouched: true });
    return;
  }
  // legacy / shadow : écriture historique, à l'identique.
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
  functionalKey: string | null,
  mode: RolloutMode,
): Promise<void> {
  const description =
    `Cette échéance a été détectée dans un document mais diverge d'un événement ` +
    `que vous avez saisi ou modifié` +
    (decision.existingItemId ? ` (événement n° ${decision.existingItemId})` : '') +
    `. Aucun de vos événements n'a été modifié.`;
  if (mode === 'enabled') {
    const base = t4UpsertInput(decision, accountId, assetId, true, functionalKey);
    await upsertAgendaItem({ ...base, details: { description, requiresQualification: true } }, { mode, notify: true });
    return;
  }
  // legacy / shadow : écriture historique, à l'identique.
  const [item] = await db.insert(agendaItems).values({
    accountId,
    title: decision.title,
    description,
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

/** Clé du couple « événement existant + échéance détectée » (déduplication). */
export function duplicatePairKey(decision: Pick<AgendaDecision, 'title' | 'date' | 'sourceFileId' | 'originFieldKey'>): string {
  const t = decision.title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const raw = `${decision.sourceFileId ?? decision.originFieldKey ?? 'none'}|${t}|${decision.date}`;
  return `duplicate:${createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
}

/**
 * Rapprochement incertain → action « À arbitrer » (file commune).
 *
 * L'événement existant n'est PAS touché : ni titre, ni date, ni catégorie,
 * ni source ; la nouvelle échéance n'est PAS créée. Tout ce qu'il faut pour
 * trancher est porté par l'action (les deux événements, leurs dates, la
 * source, l'origine de l'existant, le motif, la similarité, l'écart), et
 * appliqué seulement au choix de l'utilisateur (resolve-action.service).
 *
 * Déduplication : une action par couple ; relancer T4 met à jour l'action
 * ouverte au lieu d'en créer une autre, et un couple déjà tranché par
 * l'utilisateur n'est pas reproposé tant que rien n'a changé.
 */
export async function createDuplicateArbitration(
  decision: AgendaDecision,
  accountId: number,
  assetId: number,
): Promise<void> {
  if (!decision.existingItemId) return;
  const relationKey = duplicatePairKey(decision);

  // Décision utilisateur déjà prise sur ce couple : conservée.
  const deja = (await pgClient.unsafe(
    `SELECT 1 FROM to_process_actions
      WHERE account_id = $1 AND target_type = 'AGENDA_ITEM' AND target_id = $2 AND relation_key = $3
        AND resolved_at IS NOT NULL AND resolution_reason = 'USER_ARBITRATED' LIMIT 1`,
    [accountId, decision.existingItemId, relationKey] as never[],
  )) as unknown as unknown[];
  if (deja.length) return;

  const [source] = decision.sourceFileId
    ? await db.select({ title: assetFiles.retainedTitle, name: assetFiles.originalFilename })
        .from(assetFiles).where(and(eq(assetFiles.id, decision.sourceFileId), eq(assetFiles.accountId, accountId))).limit(1)
    : [];
  const sourceLabel = source ? (source.title ?? source.name ?? 'document') : decision.originFieldKey ? 'fiche du bien' : 'analyse';
  const fr = (d: string) => d.split('-').reverse().join('/');
  const dup = decision.duplicate;

  const { upsertAction } = await import('@/services/to-process/to-process-action.service');
  await upsertAction({
    accountId,
    targetType: 'AGENDA_ITEM',
    targetId: decision.existingItemId,
    relationKey,
    actionKind: 'ARBITRATE',
    ruleCode: 'AGENDA-DUPLICATE',
    question:
      `« ${decision.title} » du ${fr(decision.date)} (${sourceLabel}) est-il le même événement que ` +
      `« ${dup?.existingTitle ?? 'l’événement existant'} » du ${dup ? fr(dup.existingDate) : '—'}` +
      `${dup?.existingManual ? ', que vous avez saisi ou modifié' : ''} ?`,
    proposals: [
      {
        value: 'SAME', label: 'Même échéance', confidence: dup?.similarity ?? 0.8,
        evidenceIds: decision.sourceFileId ? [`file_${decision.sourceFileId}`] : [],
        sourceContext: decision.sourceFileId ? { label: sourceLabel, targetType: 'DOCUMENT', targetId: decision.sourceFileId } : undefined,
      },
      { value: 'DIFFERENT', label: 'Échéances différentes', confidence: 1 - (dup?.similarity ?? 0.8) },
    ],
    dueDate: new Date(`${(dup?.existingDate ?? decision.date)}T00:00:00Z`),
    triggerContext: {
      candidate: {
        title: decision.title, date: decision.date, category: decision.category, confidence: decision.confidence,
        sourceFileId: decision.sourceFileId ?? null, originFieldKey: decision.originFieldKey ?? null, sourceLabel,
      },
      existing: {
        id: decision.existingItemId, title: dup?.existingTitle ?? null, date: dup?.existingDate ?? null,
        origin: dup?.existingManual ? 'manual' : 'automatic',
      },
      assetId,
      matchKind: 'probable',
      similarity: dup?.similarity ?? null,
      dayGap: dup?.dayGap ?? null,
      reason: dup?.reason ?? decision.reasonCode,
      t4Decision: decision.reasonCode,
    },
  });
}
