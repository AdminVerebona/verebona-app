/**
 * Échéance lue dans une source NON AUTORITAIRE — carte « À traiter »
 * AGENDA-PROPOSAL (CDC 15 T4-04 ; lot 14, volet B).
 *
 * Recette : « proposition / À traiter, pas création automatique ». Sous
 * AI_T4_EFFECTS=enabled, une décision T4 `propose` de motif
 * `SOURCE_TYPE_NOT_AUTHORIZED` ou `SOURCE_TYPE_UNKNOWN` (devis, document de
 * type inconnu…) ne crée AUCUN élément d'agenda : elle ouvre cette carte.
 *
 *   · cible : le DOCUMENT source ; relation `agenda:<clé fonctionnelle>` —
 *     une carte par échéance de la source, idempotente (réanalyse : mise à
 *     jour de la même carte) ;
 *   · contexte : titre, date, catégorie, type métier, nature, champ
 *     d'origine, bien, cible, sources (rôle, preuve) ;
 *   · « Oui » : l'élément est créé par `upsertAgendaItem`, origine MANUAL
 *     (l'utilisateur l'a voulu), lié au bien et au document (SOURCE, preuve),
 *     dans la transaction de résolution ; « Annuler » le retire et rouvre la
 *     carte ;
 *   · « Non » : carte close comme « Non applicable » — elle ne revient pas
 *     tant que l'échéance lue (date, titre, sources) ne change pas (§7.4).
 *     Une carte acceptée ne revient pas non plus.
 */
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { db } from '@/db';
import { agendaItems, assets, toProcessActionEvents, toProcessActions } from '@/db/schema';
import type { ResolutionReason } from './action-model';
import type { DbClient, ResolveOptions, ResolveResult } from './resolve-action.service';
import { upsertAction, type UpsertActionResult } from './to-process-action.service';

export const AGENDA_PROPOSAL_RULE = 'AGENDA-PROPOSAL';
export const AGENDA_PROPOSAL_REASONS = new Set(['SOURCE_TYPE_NOT_AUTHORIZED', 'SOURCE_TYPE_UNKNOWN']);

/** Échéance proposée, telle que la carte la conserve. */
export interface AgendaProposalCandidate {
  title: string;
  date: string;
  category: 'action' | 'information' | null;
  originFieldKey: string | null;
  nature: 'HISTORICAL' | 'DEADLINE' | null;
  businessType: string | null;
  assetId: number;
  target: { type: 'EQUIPMENT'; id: number } | null;
  sources: Array<{ fileId: number; role: 'SOURCE' | 'ATTACHMENT' | 'PROOF'; evidenceId?: number | null }>;
  reasonCode: string;
  documentType: string | null;
}

/** Relation de la carte : une par échéance de la source (clé fonctionnelle, sinon empreinte). */
export function agendaProposalRelation(functionalKey: string | null, c: Pick<AgendaProposalCandidate, 'title' | 'date' | 'originFieldKey'>): string {
  if (functionalKey) return `agenda:${functionalKey}`;
  const t = c.title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `agenda:${createHash('sha256').update(`${c.originFieldKey ?? '-'}|${t}|${c.date}`).digest('hex').slice(0, 40)}`;
}

/**
 * Ouvre (ou met à jour) la carte d'une échéance proposée. Rien si la même
 * échéance a déjà été acceptée ; rien de nouveau après « Non » sans
 * changement (empreinte, §7.4).
 */
export async function proposeAgendaCreation(p: {
  accountId: number;
  sourceFileId: number;
  functionalKey: string | null;
  candidate: AgendaProposalCandidate;
}): Promise<UpsertActionResult> {
  const relationKey = agendaProposalRelation(p.functionalKey, p.candidate);
  const [derniere] = await db.select({ reason: toProcessActions.resolutionReason })
    .from(toProcessActions)
    .where(and(
      eq(toProcessActions.accountId, p.accountId), eq(toProcessActions.targetType, 'DOCUMENT'),
      eq(toProcessActions.targetId, p.sourceFileId), eq(toProcessActions.relationKey, relationKey),
      isNotNull(toProcessActions.resolvedAt),
    ))
    .orderBy(desc(toProcessActions.resolvedAt)).limit(1);
  if (derniere?.reason === 'USER_ARBITRATED') {
    return { status: 'SKIPPED', reason: 'Échéance déjà ajoutée à l’agenda par l’utilisateur.' };
  }
  const c = p.candidate;
  const source = { label: `${c.title} — ${c.date}`.slice(0, 200), targetType: 'DOCUMENT' as const, targetId: p.sourceFileId };
  return upsertAction({
    accountId: p.accountId,
    targetType: 'DOCUMENT',
    targetId: p.sourceFileId,
    relationKey,
    actionKind: 'ARBITRATE',
    ruleCode: AGENDA_PROPOSAL_RULE,
    question: `Ajouter cette échéance à l’agenda ? « ${c.title} » le ${c.date}`.slice(0, 300),
    proposals: [
      { value: 'YES', label: 'Oui, l’ajouter à l’agenda', confidence: 0.6, sourceContext: source,
        evidenceIds: c.sources.filter((s) => s.evidenceId != null).map((s) => String(s.evidenceId)) },
      { value: 'NO', label: 'Non', confidence: 0.3 },
    ],
    triggerContext: { kind: 'agenda_proposal', functionalKey: p.functionalKey, candidate: c as unknown as Record<string, unknown> },
  });
}

type Action = typeof toProcessActions.$inferSelect;

/** Empreinte d'un élément : titre, date, statut, dernière mise à jour. */
const itemFingerprint = sql<string>`md5(concat_ws('|', ${agendaItems.title}, ${agendaItems.startDate}::text, coalesce(${agendaItems.manualStatus}, ''), ${agendaItems.updatedAt}::text))`;

/**
 * Résolution (appelée par `resolveArbitration`, dans SA transaction) :
 * « YES » crée l'élément (primitive, origine MANUAL), « NO » clôt la carte
 * comme « Non applicable ».
 */
export async function resolveAgendaProposal(
  tx: DbClient & { transaction: typeof db.transaction },
  action: Action,
  value: unknown,
  accountId: number,
  options: ResolveOptions,
): Promise<ResolveResult & { afterCommit?: () => Promise<void> }> {
  if (value !== 'YES' && value !== 'NO') return { ok: false, previousValue: null, error: 'INVALID_VALUE' };
  const ctx = action.triggerContext as { candidate?: AgendaProposalCandidate } | null;
  const c = ctx?.candidate;
  if (!c) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
  const now = new Date();
  let createdItemId: number | null = null;
  let empreinte: string | null = null;

  if (value === 'YES') {
    // Le bien doit toujours appartenir au compte ; sinon l'élément est créé sans bien.
    const [bien] = await tx.select({ id: assets.id }).from(assets)
      .where(and(eq(assets.id, c.assetId), eq(assets.accountId, accountId), isNull(assets.deletedAt))).limit(1);
    const { upsertAgendaItem } = await import('@/services/agenda/agenda-write-primitive');
    const res = await upsertAgendaItem({
      accountId, assetId: bien?.id ?? null, target: bien ? c.target : null, origin: 'MANUAL',
      nature: c.nature, businessType: c.businessType, category: c.category, date: c.date, title: c.title,
      originFieldKey: c.originFieldKey, sources: c.sources,
      details: {
        createdByUserId: options.userId ?? null,
        originType: 'manual', originRefType: 'asset_file', originRefId: action.targetId,
      },
      links: {
        assetIds: bien ? [bien.id] : [],
        fileIds: [...new Set(c.sources.map((s) => s.fileId))],
        substructureIds: [],
        equipmentIds: bien && c.target ? [c.target.id] : [],
      },
    }, { client: tx, actorUserId: options.userId ?? null });
    createdItemId = res.id;
    // Empreinte de l'élément tel que créé : l'annulation ne le retire que s'il
    // n'a pas été modifié depuis.
    const [fp] = await tx.select({ fp: itemFingerprint }).from(agendaItems)
      .where(and(eq(agendaItems.id, res.id), eq(agendaItems.accountId, accountId))).limit(1);
    empreinte = fp?.fp ?? null;
  }

  await tx.update(toProcessActions).set({
    resolvedAt: now,
    resolutionReason: (value === 'YES' ? 'USER_ARBITRATED' : 'NOT_APPLICABLE') satisfies ResolutionReason,
    updatedAt: now,
  }).where(eq(toProcessActions.id, action.id));
  await tx.insert(toProcessActionEvents).values({
    actionId: action.id,
    accountId,
    event: value === 'YES' ? 'RESOLVED_ARBITRATION' : 'NOT_APPLICABLE',
    actorUserId: options.userId ?? null,
    targetType: action.targetType,
    targetId: action.targetId,
    fieldKey: action.relationKey,
    previousValue: null as never,
    newValue: { choice: value, createdItemId, fingerprint: empreinte } as never,
    details: { ruleCode: action.ruleCode, cycleNumber: action.cycleNumber, choice: value, createdItemId, candidate: c },
    createdAt: now,
  });

  return {
    ok: true,
    previousValue: null,
    // Effets d'après validation (D-13 recopie « achat », D-14 notification,
    // D-15 statut du bien) : mêmes que la création manuelle.
    afterCommit: createdItemId
      ? async () => {
        const { agendaEffectsAfterCommit } = await import('@/services/agenda/write-agenda-item');
        await agendaEffectsAfterCommit({ accountId, itemId: createdItemId!, actorUserId: options.userId ?? null, created: true });
      }
      : undefined,
  };
}

/**
 * Annulation : l'élément créé par « Oui » est retiré SEULEMENT s'il n'a pas
 * été modifié depuis la résolution (même empreinte : titre, date, statut,
 * date de mise à jour) ; sinon il est gardé. Dans les deux cas la MÊME carte
 * est rouverte.
 */
export async function undoAgendaProposal(action: Action, accountId: number): Promise<ResolveResult & { kept?: boolean }> {
  let kept = false;
  await db.transaction(async (tx) => {
    const [ev] = await tx.select({ newValue: toProcessActionEvents.newValue })
      .from(toProcessActionEvents)
      .where(and(
        eq(toProcessActionEvents.actionId, action.id), eq(toProcessActionEvents.accountId, accountId),
        eq(toProcessActionEvents.event, 'RESOLVED_ARBITRATION'),
      ))
      .orderBy(desc(toProcessActionEvents.id)).limit(1);
    const v = (ev?.newValue ?? null) as { createdItemId?: number | null; fingerprint?: string | null } | null;
    if (v?.createdItemId) {
      const suppr = v.fingerprint
        ? await tx.delete(agendaItems).where(and(
          eq(agendaItems.id, v.createdItemId), eq(agendaItems.accountId, accountId),
          sql`${itemFingerprint} = ${v.fingerprint}`,
        )).returning({ id: agendaItems.id })
        : [];
      const [existe] = await tx.select({ id: agendaItems.id }).from(agendaItems)
        .where(and(eq(agendaItems.id, v.createdItemId), eq(agendaItems.accountId, accountId))).limit(1);
      kept = suppr.length === 0 && !!existe;
    }
    await tx.update(toProcessActions)
      .set({ resolvedAt: null, resolutionReason: null, lastSeenAt: new Date(), updatedAt: new Date() })
      .where(and(eq(toProcessActions.id, action.id), eq(toProcessActions.accountId, accountId)));
  });
  if (kept) console.info(`[to-process] annulation AGENDA-PROPOSAL ${action.publicId} : élément modifié depuis — conservé`);
  return { ok: true, previousValue: null, kept };
}
