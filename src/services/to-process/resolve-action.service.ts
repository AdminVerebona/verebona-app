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
import { assetFiles, assets, toProcessActions } from '@/db/schema';
import { REFERENTIAL_VERSION, getDocumentType, getRubric } from '@/lib/referential/v2';
import { applyClassificationChange } from '@/services/documents/rubric-classification';
import type { ResolutionReason, TargetType } from './action-model';
import { getRule } from './rules-catalog';

export interface FieldWriter {
  targetType: TargetType;
  fieldKey: string;
  /** Valeur refusée avant toute écriture — le modèle n'est pas seul à se tromper. */
  validate: (value: unknown) => boolean;
  write: (targetId: number, accountId: number, value: unknown) => Promise<void>;
  /** Valeur actuelle, relue pour permettre l'annulation (§8.5). */
  read: (targetId: number, accountId: number) => Promise<unknown>;
}

const FIELD_WRITERS: FieldWriter[] = [
  {
    targetType: 'DOCUMENT',
    fieldKey: 'rubricCode',
    validate: (v) => typeof v === 'string' && !!getRubric(v),
    read: async (id, accountId) => {
      const [row] = await db
        .select({ v: assetFiles.rubricCode })
        .from(assetFiles)
        .where(and(eq(assetFiles.id, id), eq(assetFiles.accountId, accountId)))
        .limit(1);
      return row?.v ?? null;
    },
    write: (id, accountId, value) =>
      writeDocumentClassification(id, accountId, { nextRubric: value as string }),
  },
  {
    targetType: 'DOCUMENT',
    fieldKey: 'documentTypeCode',
    // Le Type « Autre » est accepté ICI : le §5.2 le réserve à l'utilisateur,
    // et c'est précisément lui qui agit.
    validate: (v) => typeof v === 'string' && !!getDocumentType(v),
    read: async (id, accountId) => {
      const [row] = await db
        .select({ v: assetFiles.documentTypeCode })
        .from(assetFiles)
        .where(and(eq(assetFiles.id, id), eq(assetFiles.accountId, accountId)))
        .limit(1);
      return row?.v ?? null;
    },
    write: (id, accountId, value) =>
      writeDocumentClassification(id, accountId, { nextType: value as string }),
  },
  {
    targetType: 'ASSET',
    fieldKey: 'isRented',
    validate: (v) => typeof v === 'boolean' || v === 'true' || v === 'false',
    read: async (id, accountId) => {
      const [row] = await db
        .select({ v: assets.isRented })
        .from(assets)
        .where(and(eq(assets.id, id), eq(assets.accountId, accountId)))
        .limit(1);
      return row?.v ?? null;
    },
    write: async (id, accountId, value) => {
      await db
        .update(assets)
        .set({
          isRented: value === true || value === 'true',
          // §6.1 : un choix explicite protège la valeur. Le défaut « Non »
          // posé à la migration, lui, ne valait pas validation.
          isRentedOrigin: 'USER',
          isRentedUserValidated: true,
          isRentedUpdatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(assets.id, id), eq(assets.accountId, accountId)));
    },
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
  fileId: number,
  accountId: number,
  change: { nextRubric?: string; nextType?: string },
): Promise<void> {
  const [row] = await db
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

  await db
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
    .where(eq(assetFiles.id, fileId));
}

export interface ResolveResult {
  ok: boolean;
  /** Valeur précédente, à conserver côté client pour l'annulation (§8.5). */
  previousValue: unknown;
  error?: 'NOT_FOUND' | 'ALREADY_RESOLVED' | 'FIELD_NOT_RESOLVABLE' | 'INVALID_VALUE';
}

/**
 * Applique une proposition retenue depuis la carte.
 *
 * §8.5 : « Cliquer sur une proposition applique immédiatement la valeur et
 * résout l'action, sans écran de confirmation supplémentaire. » L'absence de
 * confirmation n'est tenable que parce que l'annulation existe — c'est elle
 * qui rend le clic réversible, et donc anodin.
 */
export async function resolveArbitration(
  accountId: number,
  publicId: string,
  value: unknown,
): Promise<ResolveResult> {
  const [action] = await db
    .select()
    .from(toProcessActions)
    .where(
      and(eq(toProcessActions.accountId, accountId), eq(toProcessActions.publicId, publicId)),
    )
    .limit(1);

  if (!action) return { ok: false, previousValue: null, error: 'NOT_FOUND' };
  if (action.resolvedAt) {
    return { ok: false, previousValue: null, error: 'ALREADY_RESOLVED' };
  }

  const writer = findFieldWriter(action.targetType as TargetType, action.fieldKey);
  if (!writer) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
  if (!writer.validate(value)) {
    return { ok: false, previousValue: null, error: 'INVALID_VALUE' };
  }

  const previousValue = await writer.read(action.targetId, accountId);

  await db.transaction(async () => {
    await writer.write(action.targetId, accountId, value);
    await db
      .update(toProcessActions)
      .set({
        resolvedAt: new Date(),
        resolutionReason: 'USER_ARBITRATED' satisfies ResolutionReason,
        updatedAt: new Date(),
      })
      .where(eq(toProcessActions.id, action.id));
  });

  return { ok: true, previousValue };
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

  await db.transaction(async () => {
    // Une valeur précédente nulle n'est pas restaurable par l'écrivain, qui
    // écrit des valeurs valides : seule l'action est rouverte, et la donnée
    // reste telle quelle. Le problème redevient visible, ce qui est l'essentiel.
    if (previousValue !== null && previousValue !== undefined && writer.validate(previousValue)) {
      await writer.write(action.targetId, accountId, previousValue);
    }
    await db
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

  await db
    .update(toProcessActions)
    .set({
      resolvedAt: new Date(),
      resolutionReason: 'NOT_APPLICABLE' satisfies ResolutionReason,
      updatedAt: new Date(),
    })
    .where(eq(toProcessActions.id, action.id));

  return { ok: true, previousValue: null };
}
