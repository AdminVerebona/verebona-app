/**
 * Résolution d'une action — CDC V2.0 §8.5, §8.6, §12.2, §13.5.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUATRE ÉCRITURES, UNE SEULE TRANSACTION
 *
 * Le §13.5 est précis : « Une résolution directe d'arbitrage doit être
 * atomique : appliquer la valeur, marquer la validation utilisateur, résoudre
 * l'action et enregistrer la trace technique dans la même transaction
 * logique. »
 *
 * Chaque découplage produit un état faux et durable : valeur écrite sans
 * validation, et l'IA l'écrase au passage suivant ; action résolue sans
 * valeur, et la donnée manquante n'est plus réclamée par personne ; valeur
 * écrite sans résolution, et la carte redemande ce qui vient d'être répondu.
 *
 * ── UNE LISTE BLANCHE, PAS UNE ÉCRITURE GÉNÉRIQUE ─────────────────────────
 *
 * `FIELD_WRITERS` énumère les champs modifiables depuis une carte. Écrire
 * dynamiquement la colonne nommée par `fieldKey` serait plus court et
 * ouvrirait une écriture arbitraire en base depuis une requête HTTP : il
 * suffirait d'une action forgée pour viser `password_hash`.
 *
 * La liste blanche a un second mérite : un champ qui n'y figure pas ne peut
 * pas être résolu depuis la carte, ce qui force à passer par le drawer — le
 * comportement que le §8.5 prévoit pour « Autre ».
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { agendaAssetLinks, agendaItems, assetFiles, assets, toProcessActionEvents, toProcessActions } from '@/db/schema';
import { REFERENTIAL_VERSION, getDocumentType, getRubric } from '@/lib/referential/v2';
import { applyClassificationChange } from '@/services/documents/rubric-classification';
import type { ResolutionReason, TargetType } from './action-model';
import { getRule } from './rules-catalog';

/**
 * Client de base : la transaction en cours, ou `db` hors transaction.
 *
 * ⚠️ Les écrivains N'UTILISENT JAMAIS `db` directement : appelés dans
 * `db.transaction`, une écriture faite sur le client global partirait hors de
 * la transaction et survivrait à son annulation — exactement l'état partiel
 * que le §13.5 interdit.
 */
export type DbClient = Pick<typeof db, 'select' | 'update' | 'insert'>;

export interface FieldWriter {
  targetType: TargetType;
  fieldKey: string;
  /** Valeur refusée avant toute écriture — le modèle n'est pas seul à se tromper. */
  validate: (value: unknown) => boolean;
  write: (client: DbClient, targetId: number, accountId: number, value: unknown) => Promise<void>;
  /** Valeur actuelle, relue pour permettre l'annulation (§8.5). */
  read: (client: DbClient, targetId: number, accountId: number) => Promise<unknown>;
}

const FIELD_WRITERS: FieldWriter[] = [
  {
    targetType: 'DOCUMENT',
    fieldKey: 'rubricCode',
    validate: (v) => typeof v === 'string' && !!getRubric(v),
    read: async (client, id, accountId) => {
      const [row] = await client
        .select({ v: assetFiles.rubricCode })
        .from(assetFiles)
        .where(and(eq(assetFiles.id, id), eq(assetFiles.accountId, accountId)))
        .limit(1);
      return row?.v ?? null;
    },
    write: (client, id, accountId, value) =>
      writeDocumentClassification(client, id, accountId, { nextRubric: value as string }),
  },
  {
    targetType: 'DOCUMENT',
    fieldKey: 'documentTypeCode',
    // Le Type « Autre » est accepté ICI : le §5.2 le réserve à l'utilisateur,
    // et c'est précisément lui qui agit.
    validate: (v) => typeof v === 'string' && !!getDocumentType(v),
    read: async (client, id, accountId) => {
      const [row] = await client
        .select({ v: assetFiles.documentTypeCode })
        .from(assetFiles)
        .where(and(eq(assetFiles.id, id), eq(assetFiles.accountId, accountId)))
        .limit(1);
      return row?.v ?? null;
    },
    write: (client, id, accountId, value) =>
      writeDocumentClassification(client, id, accountId, { nextType: value as string }),
  },
];

export function findFieldWriter(
  targetType: TargetType,
  fieldKey: string | null,
): FieldWriter | null {
  if (!fieldKey) return null;
  return (
    FIELD_WRITERS.find((w) => w.targetType === targetType && w.fieldKey === fieldKey) ?? null
  );
}

/** Le champ est-il résoluble directement depuis la carte ? (§8.5) */
export function isResolvableFromCard(
  targetType: TargetType,
  fieldKey: string | null,
): boolean {
  return findFieldWriter(targetType, fieldKey) !== null;
}

async function writeDocumentClassification(
  client: DbClient,
  fileId: number,
  accountId: number,
  change: { nextRubric?: string; nextType?: string },
): Promise<void> {
  const [row] = await client
    .select({
      rubricCode: assetFiles.rubricCode,
      documentTypeCode: assetFiles.documentTypeCode,
      rubricOrigin: assetFiles.rubricOrigin,
      typeOrigin: assetFiles.typeOrigin,
      rubricUserValidated: assetFiles.rubricUserValidated,
      typeUserValidated: assetFiles.typeUserValidated,
    })
    .from(assetFiles)
    .where(and(eq(assetFiles.id, fileId), eq(assetFiles.accountId, accountId)))
    .limit(1);

  if (!row) throw new Error(`Document ${fileId} introuvable.`);

  // Passe par les règles de classement, jamais par une écriture directe : la
  // déduction de la Rubrique depuis le Type et le vidage d'un Type devenu
  // incompatible (§5.1) s'appliquent aussi quand l'utilisateur choisit.
  const outcome = applyClassificationChange({
    current: {
      rubricCode: row.rubricCode as never,
      documentTypeCode: row.documentTypeCode,
      rubricOrigin: row.rubricOrigin as never,
      typeOrigin: row.typeOrigin as never,
      rubricUserValidated: row.rubricUserValidated,
      typeUserValidated: row.typeUserValidated,
    },
    nextRubric: change.nextRubric as never,
    nextType: change.nextType,
    origin: 'USER',
  });

  await client
    .update(assetFiles)
    .set({
      rubricCode: outcome.result.rubricCode,
      documentTypeCode: outcome.result.documentTypeCode,
      rubricOrigin: outcome.result.rubricOrigin,
      typeOrigin: outcome.result.typeOrigin,
      rubricUserValidated: outcome.result.rubricUserValidated,
      typeUserValidated: outcome.result.typeUserValidated,
      classificationReferentialVersion: REFERENTIAL_VERSION,
      classificationUpdatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(assetFiles.id, fileId), eq(assetFiles.accountId, accountId)));
}

export interface ResolveResult {
  ok: boolean;
  /** Valeur précédente, à conserver côté client pour l'annulation (§8.5). */
  previousValue: unknown;
  error?: 'NOT_FOUND' | 'ALREADY_RESOLVED' | 'FIELD_NOT_RESOLVABLE' | 'INVALID_VALUE';
}

export interface ResolveOptions {
  /** Utilisateur qui arbitre, pour la trace. */
  userId?: number | null;
  /**
   * Point d'injection de diagnostic : appelé DANS la transaction, après
   * l'écriture du champ et avant la résolution de l'action et la trace. Une
   * exception levée ici doit tout annuler (critère de recette §13.5).
   */
  onAfterFieldWrite?: () => void | Promise<void>;
}

/**
 * Applique une proposition retenue depuis la carte.
 *
 * §8.5 : « Cliquer sur une proposition applique immédiatement la valeur et
 * résout l'action, sans écran de confirmation supplémentaire. »
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE TRANSACTION, POUR DE VRAI (§13.5)
 *
 * `db.transaction()` était bien ouverte, mais l'écrivain et la fermeture de
 * l'action écrivaient sur le client global `db` : hors transaction. Une
 * erreur entre deux écritures laissait la valeur modifiée et l'action
 * ouverte, ou l'inverse.
 *
 * Désormais les quatre éléments passent par le même `tx` :
 *   1. valeur appliquée (écrivain de la liste blanche) ;
 *   2. validation utilisateur (portée par l'écrivain : origine USER) ;
 *   3. action résolue — relue et verrouillée (`FOR UPDATE`) dans la
 *      transaction : deux clics simultanés n'arbitrent pas deux fois ;
 *   4. trace technique de succès (`to_process_action_events`).
 * Une étape en échec annule tout.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function resolveArbitration(
  accountId: number,
  publicId: string,
  value: unknown,
  options: ResolveOptions = {},
): Promise<ResolveResult> {
  return db.transaction(async (tx) => {
    const [action] = await tx
      .select()
      .from(toProcessActions)
      .where(
        and(eq(toProcessActions.accountId, accountId), eq(toProcessActions.publicId, publicId)),
      )
      .for('update')
      .limit(1);

    if (!action) return { ok: false, previousValue: null, error: 'NOT_FOUND' as const };
    if (action.resolvedAt) {
      return { ok: false, previousValue: null, error: 'ALREADY_RESOLVED' as const };
    }

    // Rapprochement d'échéances incertain (T4) : « même échéance » /
    // « échéances différentes », appliqué ici et seulement ici.
    if (action.ruleCode === 'AGENDA-DUPLICATE') {
      return resolveAgendaDuplicate(tx, action, value, accountId, options);
    }

    const writer = findFieldWriter(action.targetType as TargetType, action.fieldKey);
    if (!writer) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' as const };
    if (!writer.validate(value)) {
      return { ok: false, previousValue: null, error: 'INVALID_VALUE' as const };
    }

    const previousValue = await writer.read(tx, action.targetId, accountId);
    const now = new Date();

    // 1 + 2. Valeur appliquée et validée par l'utilisateur.
    await writer.write(tx, action.targetId, accountId, value);

    await options.onAfterFieldWrite?.();

    // 3. Action résolue.
    await tx
      .update(toProcessActions)
      .set({
        resolvedAt: now,
        resolutionReason: 'USER_ARBITRATED' satisfies ResolutionReason,
        updatedAt: now,
      })
      .where(eq(toProcessActions.id, action.id));

    // 4. Trace technique de succès.
    await tx.insert(toProcessActionEvents).values({
      actionId: action.id,
      accountId,
      event: 'RESOLVED_ARBITRATION',
      actorUserId: options.userId ?? null,
      targetType: action.targetType,
      targetId: action.targetId,
      fieldKey: action.fieldKey,
      previousValue: (previousValue ?? null) as never,
      newValue: (value ?? null) as never,
      details: { ruleCode: action.ruleCode, cycleNumber: action.cycleNumber },
      createdAt: now,
    });

    return { ok: true, previousValue };
  });
}

/**
 * Annule une résolution — §8.5.
 *
 * « Une annulation restaure la valeur précédente et réactive le même problème
 * sans créer un nouveau cycle. » La MÊME ligne est rouverte : un nouveau cycle
 * ferait apparaître l'action comme un problème inédit, alors que l'utilisateur
 * vient seulement de se raviser.
 *
 * La restauration passe par le même écrivain que l'application, ce qui a une
 * conséquence à assumer : la valeur restaurée redevient « validée par
 * l'utilisateur ». C'est voulu — elle l'était avant le clic, et la rendre à
 * l'IA au passage donnerait à un simple « Annuler » un effet que personne
 * n'attend.
 */
export async function undoArbitration(
  accountId: number,
  publicId: string,
  previousValue: unknown,
): Promise<ResolveResult> {
  const [action] = await db
    .select()
    .from(toProcessActions)
    .where(
      and(eq(toProcessActions.accountId, accountId), eq(toProcessActions.publicId, publicId)),
    )
    .limit(1);

  if (!action) return { ok: false, previousValue: null, error: 'NOT_FOUND' };

  const writer = findFieldWriter(action.targetType as TargetType, action.fieldKey);
  if (!writer) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };

  // (Annulation hors périmètre produit ; même client transactionnel par cohérence.)
  await db.transaction(async (tx) => {
    // Une valeur précédente nulle n'est pas restaurable par l'écrivain, qui
    // écrit des valeurs valides : seule l'action est rouverte, et la donnée
    // reste telle quelle. Le problème redevient visible, ce qui est l'essentiel.
    if (previousValue !== null && previousValue !== undefined && writer.validate(previousValue)) {
      await writer.write(tx, action.targetId, accountId, previousValue);
    }
    await tx
      .update(toProcessActions)
      .set({
        resolvedAt: null,
        resolutionReason: null,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(toProcessActions.id, action.id));
  });

  return { ok: true, previousValue };
}

/**
 * Marque une action « Non applicable » — §7.4.
 *
 * Refusée si la règle ne l'autorise pas : le §10.6 réserve cet état final aux
 * cas où l'absence de donnée est légitime. La Rubrique et le rattachement à un
 * bien n'en font jamais partie.
 */
export async function markNotApplicable(
  accountId: number,
  publicId: string,
  options: { userId?: number | null } = {},
): Promise<ResolveResult> {
  const [action] = await db
    .select()
    .from(toProcessActions)
    .where(
      and(eq(toProcessActions.accountId, accountId), eq(toProcessActions.publicId, publicId)),
    )
    .limit(1);

  if (!action) return { ok: false, previousValue: null, error: 'NOT_FOUND' };
  if (action.resolvedAt) return { ok: false, previousValue: null, error: 'ALREADY_RESOLVED' };
  if (!getRule(action.ruleCode)?.allowNotApplicable) {
    return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(toProcessActions)
      .set({
        resolvedAt: now,
        resolutionReason: 'NOT_APPLICABLE' satisfies ResolutionReason,
        updatedAt: now,
      })
      .where(eq(toProcessActions.id, action.id));
    // Décision conservée avec son contexte, pour l'audit et pour ne pas
    // reproposer la même chose sans élément nouveau.
    await tx.insert(toProcessActionEvents).values({
      actionId: action.id,
      accountId,
      event: 'NOT_APPLICABLE',
      actorUserId: options.userId ?? null,
      targetType: action.targetType,
      targetId: action.targetId,
      fieldKey: action.fieldKey ?? action.relationKey,
      details: { ruleCode: action.ruleCode, cycleNumber: action.cycleNumber, proposals: action.proposalsJson ?? null },
      createdAt: now,
    });
  });

  return { ok: true, previousValue: null };
}

// ══════════════════════════════════════════════════════════════════════════
// ARBITRAGE D'UN RAPPROCHEMENT D'ÉCHÉANCES INCERTAIN (T4)
//
// Rien n'a été appliqué avant ce choix : l'événement existant est intact et
// la nouvelle échéance n'existe que dans l'action.
//
//   · SAME — même échéance : consolidation selon la règle commune de
//     l'agenda. Un événement automatique jamais modifié prend la valeur
//     documentaire (titre, date, catégorie, source — la source précédente est
//     conservée dans la trace) ; un événement saisi ou modifié par
//     l'utilisateur garde SES valeurs (protection), la source est seulement
//     confirmée dans la trace.
//   · DIFFERENT — échéances différentes : l'existant reste tel quel, la
//     nouvelle échéance est créée séparément, rattachée au bien.
// Dans les deux cas l'action est close (USER_ARBITRATED) : le couple n'est
// plus reproposé tant que rien ne change.
// ══════════════════════════════════════════════════════════════════════════
type LockedAction = typeof toProcessActions.$inferSelect;
interface DuplicateContext {
  candidate: { title: string; date: string; category: 'action' | 'information' | null; confidence: string; sourceFileId: number | null; originFieldKey: string | null; sourceLabel?: string };
  existing: { id: number; title: string | null; date: string | null; origin: 'manual' | 'automatic' };
  assetId: number;
  similarity: number | null;
  dayGap: number | null;
  reason: string;
}

async function resolveAgendaDuplicate(
  tx: DbClient & { select: typeof db.select },
  action: LockedAction,
  value: unknown,
  accountId: number,
  options: ResolveOptions,
): Promise<ResolveResult> {
  if (value !== 'SAME' && value !== 'DIFFERENT') return { ok: false, previousValue: null, error: 'INVALID_VALUE' };
  const ctx = action.triggerContext as DuplicateContext | null;
  if (!ctx?.candidate) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };

  const [existing] = await tx
    .select()
    .from(agendaItems)
    .where(and(eq(agendaItems.id, action.targetId), eq(agendaItems.accountId, accountId)))
    .for('update')
    .limit(1);
  if (!existing) return { ok: false, previousValue: null, error: 'NOT_FOUND' };

  const now = new Date();
  const c = ctx.candidate;
  let consolidation: Record<string, unknown>;

  if (value === 'SAME') {
    const automatiqueIntact = existing.isAutomatic && !existing.isAutomaticModified;
    if (automatiqueIntact) {
      await tx.update(agendaItems).set({
        title: c.title,
        startDate: c.date,
        homeCategory: c.category ?? existing.homeCategory,
        originRefType: c.sourceFileId ? 'asset_file' : existing.originRefType,
        originRefId: c.sourceFileId ?? existing.originRefId,
        updatedAt: now,
      }).where(eq(agendaItems.id, existing.id));
      consolidation = {
        applied: true,
        previous: { title: existing.title, date: existing.startDate, category: existing.homeCategory, originRefType: existing.originRefType, originRefId: existing.originRefId },
        next: { title: c.title, date: c.date, sourceFileId: c.sourceFileId },
      };
    } else {
      consolidation = { applied: false, reason: 'USER_VALUES_PROTECTED', confirmedSourceFileId: c.sourceFileId };
    }
  } else {
    // L'échéance est créée séparément, rattachée au bien s'il est toujours au compte.
    const [created] = await tx.insert(agendaItems).values({
      accountId,
      title: c.title,
      startDate: c.date,
      homeCategory: c.category ?? 'information',
      isAutomatic: true,
      isAutomaticModified: false,
      requiresQualification: c.confidence !== 'certain',
      originType: c.originFieldKey ? 'asset_field' : 'qualified_document',
      originFieldKey: c.originFieldKey,
      originRefType: c.sourceFileId ? 'asset_file' : null,
      originRefId: c.sourceFileId,
    }).returning({ id: agendaItems.id });
    const [bien] = await tx.select({ id: assets.id }).from(assets)
      .where(and(eq(assets.id, ctx.assetId), eq(assets.accountId, accountId))).limit(1);
    if (bien) await tx.insert(agendaAssetLinks).values({ agendaItemId: created.id, assetId: bien.id }).onConflictDoNothing();
    consolidation = { createdItemId: created.id };
  }

  await tx.update(toProcessActions).set({
    resolvedAt: now,
    resolutionReason: 'USER_ARBITRATED' satisfies ResolutionReason,
    updatedAt: now,
  }).where(eq(toProcessActions.id, action.id));

  await tx.insert(toProcessActionEvents).values({
    actionId: action.id,
    accountId,
    event: 'RESOLVED_ARBITRATION',
    actorUserId: options.userId ?? null,
    targetType: action.targetType,
    targetId: action.targetId,
    fieldKey: action.relationKey,
    previousValue: null as never,
    newValue: value as never,
    details: {
      ruleCode: action.ruleCode, cycleNumber: action.cycleNumber, choice: value,
      matchKind: 'probable', similarity: ctx.similarity, dayGap: ctx.dayGap, reason: ctx.reason,
      candidate: c, existing: ctx.existing, consolidation,
    },
    createdAt: now,
  });

  return { ok: true, previousValue: null };
}
