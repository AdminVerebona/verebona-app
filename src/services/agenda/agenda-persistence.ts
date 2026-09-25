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
      occurrenceNature: agendaItems.occurrenceNature,
      seriesKey: agendaItems.seriesKey,
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
      nature: (r.occurrenceNature as 'FORECAST' | 'CONFIRMED' | null) ?? 'CONFIRMED',
      seriesKey: r.seriesKey,
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
          // Seul un rapprochement CERTAIN ou un arbitrage confirmé autorise une
          // mise à jour : un rapprochement probable n'arrive jamais ici.
          if (decision.duplicate || /PROBABLE/.test(decision.reasonCode)) {
            console.warn(`[agenda-persistence] mise à jour refusée pour un rapprochement probable (${decision.reasonCode})`);
            await createDuplicateArbitration(decision, accountId, assetId);
            break;
          }
          await updateItem(decision, accountId);
          break;

        case 'arbitrate_duplicate':
          await createDuplicateArbitration(decision, accountId, assetId);
          break;

        case 'create_conflict':
          await createConflict(decision, accountId, assetId);
          break;

        case 'skip_duplicate':
          // Un doublon certain n'est jamais recréé (§4.4.4). Rien à faire.
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
    // Nature et provenance de l'occurrence : une date calculée d'une
    // récurrence reste identifiable comme PRÉVISIONNELLE.
    occurrenceNature: decision.occurrence?.nature ?? 'CONFIRMED',
    dateSource: decision.occurrence?.dateSource ?? 'EXPLICIT_DATE',
    seriesKey: decision.occurrence?.seriesKey ?? null,
    recurrenceJson: (decision.occurrence?.recurrence ?? null) as never,
  }).returning({ id: agendaItems.id });

  await linkToAsset(item.id, assetId);

  if (decision.occurrence?.nature === 'FORECAST') {
    await recordOccurrenceEvent(item.id, accountId, 'FORECAST_CREATED', {
      date: decision.date, rule: decision.occurrence.recurrence?.rule, mode: decision.occurrence.recurrence?.mode,
      referenceDate: decision.occurrence.recurrence?.referenceDate, sourceFileId: decision.sourceFileId ?? null,
      seriesKey: decision.occurrence.seriesKey,
    });
  }
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
