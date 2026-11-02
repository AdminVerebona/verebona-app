/**
 * Carte « À traiter » de CONFIRMATION GROUPÉE d'identité — règle
 * LINK-ASSET-GROUP (lot 105D, ticket « T3 / Cohérence / À traiter —
 * Rattachement rétroactif après création d'un bien », §F).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUAND : plusieurs documents sans bien désignent une même identité de bien
 * (« 12 rue des Érables Fictifs, 69000 Lyon »), mais le bien compatible du
 * compte n'a pas d'identifiant (« Maison » sans adresse) : T3 ne l'attribue
 * JAMAIS implicitement (groupe TO_CONFIRM, `identity/graph.ts`).
 *
 * LA CARTE : « Le logement du 12 rue des Érables Fictifs, 69000 Lyon est-il
 * votre bien « Maison » ? » — cible : le premier document du groupe ;
 * relation `identityGroup` ; périmètre VISIBLE avant toute application
 * (documents inclus, exceptions et motifs, preuves à inspecter :
 * `triggerContext.scope`, rendu par la carte). Un bien compatible à la fois :
 * « Non » le retire, la carte passe au suivant s'il en reste un.
 *
 * LES CHOIX : « Oui » → décision CONFIRMED (durable, prioritaire,
 * `document_identity_decisions`) ; « Non » → REFUSED (stable tant que
 * l'identité du bien ne change pas). Aucune action cachée « rattacher tout » :
 * après la décision, CHAQUE document du groupe repasse par T3 DOCUMENT_ASSET
 * (file durable) qui ne rattache que les membres dont le lien est démontré
 * (identité propre ou contrat à un saut), ferme leurs LINK-ASSET et propage
 * par les chaînes existantes. « Annuler » : décision UNDONE, liens posés par
 * cette confirmation retirés (origine IA seulement), même carte rouverte.
 *
 * PAS DE DOUBLON : tant que la carte groupée est ouverte, les cartes
 * individuelles LINK-ASSET de ses membres sont fermées (OBSOLETE, motif
 * COVERED_BY_GROUP_CARD) et T3 n'en rouvre pas (abstention
 * GROUP_CONFIRMATION_PENDING, sans IA). Une panne technique n'ouvre jamais
 * cette carte (elle relève de la Supervision).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, pgClient } from '@/db';
import { assets, toProcessActionEvents, toProcessActions } from '@/db/schema';
import type { ResolutionReason } from './action-model';
import type { DbClient, ResolveOptions, ResolveResult } from './resolve-action.service';
import { upsertAction } from './to-process-action.service';
import { unnamedLabel } from './card-labels';

export const IDENTITY_GROUP_RULE = 'LINK-ASSET-GROUP';
export const IDENTITY_GROUP_RELATION = 'identityGroup';

/** Groupe tel que la carte le présente (extrait de `IdentityGroup`). */
export interface GroupCardInput {
  groupKey: string;
  fingerprint: string;
  family: 'PROPERTY' | 'VEHICLE';
  label: string;
  members: Array<{ fileId: number; via: 'OWN_IDENTITY' | 'CONTRACT' }>;
  excluded: Array<{ fileId: number; reason: string }>;
  candidateAssetIds: number[];
  /** Natures de preuves (ADDRESS, CADASTRAL, CONTRACT_REF…) par document. */
  evidenceKinds: Array<{ fileId: number; kinds: string[] }>;
}

/** Contexte conservé sur la carte (périmètre exact, visible avant application). */
export interface GroupCardContext {
  kind: 'identity_group';
  groupKey: string;
  groupFingerprint: string;
  family: 'PROPERTY' | 'VEHICLE';
  /** Bien proposé (un à la fois). */
  assetId: number;
  memberFileIds: number[];
  scope: {
    label: string;
    documents: Array<{ id: number; title: string; via: 'OWN_IDENTITY' | 'CONTRACT'; evidence: string }>;
    exceptions: Array<{ id: number; title: string; reason: string }>;
  };
}

/** Libellés français simples des motifs d'exclusion et des preuves. */
export const EXCLUSION_LABELS: Readonly<Record<string, string>> = {
  ADDRESS_ROLE_BILLING: 'adresse de facturation, pas celle du bien',
  ADDRESS_ROLE_DELIVERY: 'adresse de livraison, pas celle du bien',
  ADDRESS_ROLE_SUPPLIER: 'adresse du fournisseur',
  ADDRESS_ROLE_INTERVENTION: 'adresse d’intervention ou d’installation',
  ADDRESS_ROLE_UNKNOWN: 'adresse citée sans indiquer qu’il s’agit du bien',
  MULTI_ASSET_DOCUMENT: 'document qui concerne plusieurs biens',
  CONTRADICTORY_DOCUMENT: 'document aux informations contradictoires',
  EQUIPMENT_DOCUMENT: 'document d’un appareil : l’adresse ne prouve pas qu’il appartient au bien',
  CONTRACT_SPANS_SEVERAL_IDENTITIES: 'contrat cité par des documents de biens différents',
  UNCERTAIN_READING: 'adresse lue de façon incertaine',
};
const EVIDENCE_LABELS: Readonly<Record<string, string>> = {
  ADDRESS: 'adresse du bien', CADASTRAL: 'référence cadastrale', REGISTRATION: 'immatriculation', VIN: 'numéro VIN',
  CONTRACT_REF: 'même numéro de contrat qu’un document du groupe', DPE_REF: 'même numéro de DPE qu’un document du groupe',
};

const borne = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Question de la carte (pure) : l'identité lue, le bien proposé, rien de caché. */
export function identityGroupQuestion(p: { family: 'PROPERTY' | 'VEHICLE'; label: string; assetName: string }): string {
  const bien = `« ${borne(p.assetName, 50)} »`;
  return p.family === 'PROPERTY'
    ? `Le logement du ${borne(p.label)} est-il votre bien ${bien} ?`
    : `Le véhicule immatriculé ${borne(p.label, 30)} est-il votre bien ${bien} ?`;
}

/** Choix de la carte (pure) : confirmer CE bien, ou refuser. */
export function identityGroupProposals(p: { assetId: number; assetName: string; documentCount: number }) {
  return [
    { value: `CONFIRM:${p.assetId}`, label: `Oui, c’est « ${borne(p.assetName, 40)} » (${p.documentCount} documents)`, confidence: 0.6 },
    { value: 'REFUSE', label: 'Non, ce n’est pas ce bien', confidence: 0.3 },
  ];
}

async function names(accountId: number, assetIds: number[], fileIds: number[]) {
  const [a, f] = await Promise.all([
    pgClient.unsafe(`SELECT id, name FROM assets WHERE account_id = $1 AND deleted_at IS NULL AND id = ANY($2::int[])`, [accountId, assetIds] as never[]),
    pgClient.unsafe(`SELECT id, COALESCE(NULLIF(retained_title, ''), original_filename, filename) AS t FROM asset_files WHERE account_id = $1 AND id = ANY($2::int[])`, [accountId, fileIds] as never[]),
  ]) as unknown as [Array<{ id: number; name: string | null }>, Array<{ id: number; t: string | null }>];
  return {
    asset: new Map(a.map((r) => [Number(r.id), r.name ?? unnamedLabel('ASSET')])),
    file: new Map(f.map((r) => [Number(r.id), r.t ?? 'Document'])),
  };
}

/** Contexte de la carte (pure). */
export function groupCardContext(g: GroupCardInput, assetId: number, titles: ReadonlyMap<number, string>): GroupCardContext {
  const kinds = new Map(g.evidenceKinds.map((e) => [e.fileId, e.kinds]));
  return {
    kind: 'identity_group', groupKey: g.groupKey, groupFingerprint: g.fingerprint, family: g.family, assetId,
    memberFileIds: g.members.map((m) => m.fileId),
    scope: {
      label: g.label.slice(0, 160),
      documents: g.members.map((m) => ({
        id: m.fileId, title: borne(titles.get(m.fileId) ?? 'Document', 90), via: m.via,
        evidence: m.via === 'CONTRACT' ? EVIDENCE_LABELS.CONTRACT_REF
          : [...new Set((kinds.get(m.fileId) ?? ['ADDRESS']).map((k) => EVIDENCE_LABELS[k] ?? k))].join(', '),
      })),
      exceptions: g.excluded.slice(0, 30).map((x) => ({ id: x.fileId, title: borne(titles.get(x.fileId) ?? 'Document', 90), reason: EXCLUSION_LABELS[x.reason] ?? x.reason })),
    },
  };
}

/**
 * Synchronise les cartes groupées du compte avec les groupes calculés :
 * ouvre / actualise la carte des groupes TO_CONFIRM éligibles, ferme celles
 * devenues sans objet, ferme les cartes individuelles LINK-ASSET des membres
 * couverts. Rend les compteurs et l'identifiant de carte par groupe.
 */
export async function syncIdentityGroupCards(accountId: number, groups: readonly GroupCardInput[]): Promise<{
  opened: number; updated: number; closed: number; individualClosed: number; cards: Map<string, number | null>;
}> {
  const out = { opened: 0, updated: 0, closed: 0, individualClosed: 0, cards: new Map<string, number | null>() };
  const ids = [...new Set(groups.flatMap((g) => [...g.members.map((m) => m.fileId), ...g.excluded.map((x) => x.fileId)]))];
  const n = await names(accountId, [...new Set(groups.flatMap((g) => g.candidateAssetIds))], ids);
  const voulues = new Map<string, { lead: number }>();
  for (const g of groups) {
    const assetId = g.candidateAssetIds.find((id) => n.asset.has(id));
    if (assetId === undefined || g.members.length === 0) continue;
    const lead = Math.min(...g.members.map((m) => m.fileId));
    const ctx = groupCardContext(g, assetId, n.file);
    const r = await upsertAction({
      accountId, targetType: 'DOCUMENT', targetId: lead, relationKey: IDENTITY_GROUP_RELATION, actionKind: 'ARBITRATE', ruleCode: IDENTITY_GROUP_RULE,
      question: identityGroupQuestion({ family: g.family, label: g.label, assetName: n.asset.get(assetId)! }),
      proposals: identityGroupProposals({ assetId, assetName: n.asset.get(assetId)!, documentCount: g.members.length }),
      triggerContext: ctx as unknown as Record<string, unknown>,
    });
    if (r.status === 'CREATED') out.opened += 1;
    else if (r.status === 'UPDATED') out.updated += 1;
    const id = 'actionId' in r && typeof r.actionId === 'number' ? r.actionId : await openCardId(accountId, g.groupKey);
    out.cards.set(g.groupKey, id ?? null);
    voulues.set(g.groupKey, { lead });
    out.individualClosed += await closeIndividualCards(accountId, g.members.map((m) => m.fileId), g.groupKey);
  }
  // Cartes groupées devenues sans objet (groupe résolu, disparu, cible changée).
  const ouvertes = (await pgClient.unsafe(
    `SELECT id, target_id, trigger_context ->> 'groupKey' AS gk FROM to_process_actions
      WHERE account_id = $1 AND rule_code = $2 AND resolved_at IS NULL`,
    [accountId, IDENTITY_GROUP_RULE] as never[],
  )) as unknown as Array<{ id: number; target_id: number; gk: string | null }>;
  for (const c of ouvertes) {
    const v = c.gk ? voulues.get(c.gk) : undefined;
    if (v && v.lead === Number(c.target_id)) continue;
    if (await closeCard(accountId, Number(c.id), 'OBSOLETE', v ? 'GROUP_LEAD_CHANGED' : 'GROUP_NO_LONGER_TO_CONFIRM')) out.closed += 1;
  }
  return out;
}

async function openCardId(accountId: number, groupKey: string): Promise<number | null> {
  const [r] = (await pgClient.unsafe(
    `SELECT id FROM to_process_actions WHERE account_id = $1 AND rule_code = $2 AND resolved_at IS NULL AND trigger_context ->> 'groupKey' = $3 ORDER BY id DESC LIMIT 1`,
    [accountId, IDENTITY_GROUP_RULE, groupKey] as never[],
  )) as unknown as Array<{ id: number }>;
  return r ? Number(r.id) : null;
}

/** Ferme une carte (tracée). Rend vrai si elle était ouverte. */
async function closeCard(accountId: number, actionId: number, reason: ResolutionReason, detail: string): Promise<boolean> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const fermee = await tx.update(toProcessActions).set({ resolvedAt: now, resolutionReason: reason, updatedAt: now })
      .where(and(eq(toProcessActions.id, actionId), eq(toProcessActions.accountId, accountId), isNull(toProcessActions.resolvedAt)))
      .returning({ id: toProcessActions.id, targetType: toProcessActions.targetType, targetId: toProcessActions.targetId, relationKey: toProcessActions.relationKey, ruleCode: toProcessActions.ruleCode });
    if (!fermee.length) return false;
    await tx.insert(toProcessActionEvents).values({
      actionId, accountId, event: reason, targetType: fermee[0].targetType, targetId: fermee[0].targetId, fieldKey: fermee[0].relationKey,
      details: { reason: detail, ruleCode: fermee[0].ruleCode }, createdAt: now,
    });
    return true;
  });
}

/**
 * Cartes individuelles LINK-ASSET des documents couverts par une carte
 * groupée : fermées (OBSOLETE, motif COVERED_BY_GROUP_CARD) — pas de
 * doublon. Rend le nombre de cartes fermées.
 */
export async function closeIndividualCards(accountId: number, fileIds: readonly number[], groupKey: string): Promise<number> {
  if (fileIds.length === 0) return 0;
  const rows = (await pgClient.unsafe(
    `SELECT id FROM to_process_actions
      WHERE account_id = $1 AND target_type = 'DOCUMENT' AND target_id = ANY($2::int[]) AND rule_code = 'LINK-ASSET' AND resolved_at IS NULL`,
    [accountId, [...fileIds]] as never[],
  )) as unknown as Array<{ id: number }>;
  let n = 0;
  for (const r of rows) if (await closeCard(accountId, Number(r.id), 'OBSOLETE', `COVERED_BY_GROUP_CARD:${groupKey}`)) n += 1;
  return n;
}

// ══════════════════════════════════════════════════════════════════════════
// RÉSOLUTION (appelée par `resolveArbitration`, dans SA transaction)
// ══════════════════════════════════════════════════════════════════════════

type Action = typeof toProcessActions.$inferSelect;

/** Choix reçu (pure) ; `null` : invalide (seul le bien de la carte est accepté). */
export function parseIdentityGroupChoice(value: unknown, ctx: Pick<GroupCardContext, 'assetId'>): { kind: 'CONFIRM'; assetId: number } | { kind: 'REFUSE' } | null {
  if (value === 'REFUSE') return { kind: 'REFUSE' };
  if (typeof value === 'string' && /^CONFIRM:\d+$/.test(value)) {
    const id = Number(value.slice(8));
    return id === ctx.assetId ? { kind: 'CONFIRM', assetId: id } : null;
  }
  return null;
}

export async function resolveIdentityGroupCard(
  tx: DbClient, action: Action, value: unknown, accountId: number, options: ResolveOptions,
): Promise<ResolveResult & { afterCommit?: () => Promise<void> }> {
  const ctx = action.triggerContext as GroupCardContext | null;
  if (!ctx?.groupKey || !ctx.assetId) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
  const choice = parseIdentityGroupChoice(value, ctx);
  if (!choice) return { ok: false, previousValue: null, error: 'INVALID_VALUE' };
  const t = tx as unknown as { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };
  const [bien] = await tx.select({ id: assets.id }).from(assets)
    .where(and(eq(assets.id, ctx.assetId), eq(assets.accountId, accountId), isNull(assets.deletedAt))).limit(1);
  if (!bien) return { ok: false, previousValue: null, error: 'STALE' };
  // Contexte du refus : identité ACTUELLE du bien (même calcul que le graphe).
  const { loadAccountMatchingIndex } = await import('@/services/ai/reconciliation/document-asset/matching-index');
  const { assetIdentityFingerprint } = await import('@/services/ai/reconciliation/document-asset/identity/graph');
  const index = await loadAccountMatchingIndex(accountId);
  const a = index.byId.get(ctx.assetId);
  if (!a) return { ok: false, previousValue: null, error: 'STALE' };
  const decision = choice.kind === 'CONFIRM' ? 'CONFIRMED' : 'REFUSED';
  const now = new Date();
  await t.execute(sql`UPDATE document_identity_decisions SET status = 'SUPERSEDED', superseded_at = now(), superseded_reason = ${`NEW_USER_DECISION:${decision}`}
                      WHERE account_id = ${accountId} AND group_key = ${ctx.groupKey} AND asset_id = ${ctx.assetId} AND status = 'ACTIVE'`);
  await t.execute(sql`INSERT INTO document_identity_decisions (account_id, group_key, asset_id, decision, context_fingerprint, group_fingerprint, member_file_ids, decided_by_user_id, action_id)
                      VALUES (${accountId}, ${ctx.groupKey}, ${ctx.assetId}, ${decision}, ${assetIdentityFingerprint(a)}, ${ctx.groupFingerprint},
                              ${`{${ctx.memberFileIds.map(Number).join(',')}}`}::int[], ${options.userId ?? null}, ${action.id})`);
  await tx.update(toProcessActions).set({ resolvedAt: now, resolutionReason: 'USER_ARBITRATED' satisfies ResolutionReason, updatedAt: now })
    .where(eq(toProcessActions.id, action.id));
  await tx.insert(toProcessActionEvents).values({
    actionId: action.id, accountId, event: 'RESOLVED_ARBITRATION', actorUserId: options.userId ?? null,
    targetType: action.targetType, targetId: action.targetId, fieldKey: action.relationKey,
    previousValue: null as never, newValue: { choice: choice.kind, assetId: ctx.assetId } as never,
    details: { ruleCode: action.ruleCode, groupKey: ctx.groupKey, decision, memberFileIds: ctx.memberFileIds, cycleNumber: action.cycleNumber },
    createdAt: now,
  });
  return {
    ok: true,
    previousValue: { choice: choice.kind, assetId: ctx.assetId },
    afterCommit: () => afterGroupDecision({ accountId, actionId: action.id, memberFileIds: ctx.memberFileIds, userId: options.userId ?? null, reason: `GROUP_IDENTITY_${decision}` }),
  };
}

/**
 * Après une décision (ou son annulation) : signal de connaissance, puis
 * CHAQUE document du groupe repasse par T3 DOCUMENT_ASSET (file durable,
 * déterministe d'abord) — aucune écriture groupée cachée. Ne lève jamais.
 */
async function afterGroupDecision(p: { accountId: number; actionId: number; memberFileIds: number[]; userId: number | null; reason: string }): Promise<void> {
  try {
    const { noteIdentityKnowledgeChange } = await import('@/services/ai/reconciliation/document-asset/identity/store');
    await noteIdentityKnowledgeChange(p.accountId, p.actionId);
    const { requestDocumentAssetResolution } = await import('@/services/ai/reconciliation/document-asset/queue');
    for (const fileId of p.memberFileIds) {
      await requestDocumentAssetResolution({ accountId: p.accountId, userId: p.userId, fileId, triggerCode: 'identity_decision', reprocessReason: p.reason });
    }
  } catch (e) {
    console.error(`[to-process] décision d'identité ${p.actionId} : réexamen des documents non demandé (repris au passage T3 suivant) :`, (e as Error).message);
  }
}

/**
 * Annulation : décisions de la carte UNDONE ; liens posés par CETTE
 * confirmation (origine IA, motif GROUP_IDENTITY_CONFIRMED) retirés ; la même
 * carte est rouverte ; les documents repassent par T3.
 */
export async function undoIdentityGroupCard(action: Action, accountId: number): Promise<ResolveResult> {
  const ctx = action.triggerContext as GroupCardContext | null;
  const { undoGroupDecisions } = await import('@/services/ai/reconciliation/document-asset/identity/store');
  const annulees = await undoGroupDecisions(accountId, action.id);
  const confirmees = annulees.filter((d) => d.decision === 'CONFIRMED');
  if (confirmees.length && ctx?.memberFileIds.length) {
    const { unlinkDocument } = await import('@/services/documents/document-asset-links');
    const { clearAutomaticPrimaryColumn } = await import('@/services/ai/reconciliation/document-asset/automatic-attachment');
    const { onDocumentAssetChanged } = await import('@/services/ai/evidence/document-evidence-lifecycle');
    for (const d of confirmees) {
      // Rattachements AUTOMATIQUES posés depuis la confirmation (règle de groupe, ou chaîne déclenchée par elle :
      // référence partagée…) ; jamais un document qui porte un lien de l'utilisateur.
      const lies = (await pgClient.unsafe(
        `SELECT r.file_id, f.user_id FROM document_asset_resolutions r JOIN asset_files f ON f.id = r.file_id AND f.account_id = r.account_id
          WHERE r.account_id = $1 AND r.file_id = ANY($2::int[]) AND r.status = 'RESOLVED' AND $3 = ANY(r.decided_asset_ids)
            AND r.decided_at >= $4::timestamptz AND r.method IN ('DETERMINISTIC', 'AI')
            AND NOT EXISTS (SELECT 1 FROM document_asset_links l WHERE l.file_id = r.file_id AND l.status = 'ACTIVE' AND l.origin = 'USER')
            AND COALESCE((f.user_edited_fields ->> 'assetId')::boolean, false) = false`,
        [accountId, ctx.memberFileIds, d.assetId, d.createdAt] as never[],
      )) as unknown as Array<{ file_id: number; user_id: number | null }>;
      for (const l of lies) {
        const fileId = Number(l.file_id);
        await unlinkDocument({ accountId, fileId, target: { assetId: d.assetId }, origins: ['AI'] });
        await clearAutomaticPrimaryColumn(accountId, fileId, d.assetId);
        // Preuves projetées sur le bien retirées par le cycle de vie existant (document → plus de bien).
        if (l.user_id) await onDocumentAssetChanged({ accountId, userId: Number(l.user_id), fileId, fromAssetId: d.assetId, toAssetId: null }).catch(() => undefined);
      }
    }
  }
  await db.update(toProcessActions)
    .set({ resolvedAt: null, resolutionReason: null, lastSeenAt: new Date(), updatedAt: new Date() })
    .where(and(eq(toProcessActions.id, action.id), eq(toProcessActions.accountId, accountId)));
  if (ctx) await afterGroupDecision({ accountId, actionId: action.id, memberFileIds: ctx.memberFileIds, userId: null, reason: 'GROUP_IDENTITY_UNDONE' });
  return { ok: true, previousValue: null };
}
