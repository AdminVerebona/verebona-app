/**
 * Carte « À traiter » d'INTERVENTION RÉELLE sur un document — lot 61
 * (ticket « BUG P1 — À traiter : écarts résiduels du lot 58B », écart 2 ;
 * ticket « [P1] Fiabiliser la pertinence des cartes », §3 CREATE_ACTION).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DONNÉE DOCUMENTAIRE ≠ ÉCHÉANCE ≠ ACTION DE L'UTILISATEUR
 *
 * Avant : quand T4 jugeait qu'une échéance passée exigeait encore une action
 * (reconduction, résiliation, obligation), la carte restait « Quelle est la
 * date de fin de ce contrat ? » — une fausse question de complétion.
 *
 * Désormais la donnée (la date) et l'intervention sont deux objets distincts :
 *   · la donnée garde sa règle (DATA-CONTRACT-END…) — aucune question si sa
 *     valeur n'est pas nécessaire ;
 *   · l'intervention identifiée par T4 (`t4_output_v3`, contrôlée par le
 *     code) devient UNE carte `DOC-INTERVENTION`, clé
 *     `intervention:<donnée>` : libellé = l'action réelle (« Résilier le
 *     contrat avant sa reconduction »), choix « C'est fait » / « Pas
 *     nécessaire », justification et preuve dans son contexte (internes).
 *   · aucune carte sans intervention identifiable (`needed = yes`, action
 *     et nature renseignées, preuve retrouvée dans le contexte fourni).
 *
 * La décision de l'utilisateur est respectée : une carte close par lui
 * (« C'est fait », « Pas nécessaire », « Non applicable ») n'est pas
 * recréée tant que l'évaluation (même signature : mêmes preuves, même
 * configuration) n'a pas changé.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { toProcessActionEvents, toProcessActions } from '@/db/schema';
import type { ResolutionReason } from './action-model';
import type { InterventionDecision } from './document-field-evidence';
import type { ProcessingRule } from './rules-catalog';
import { upsertAction } from './to-process-action.service';
import type { DbClient, ResolveOptions, ResolveResult } from './resolve-action.service';

export const INTERVENTION_RULE_CODE = 'DOC-INTERVENTION';
/** Clé de la carte d'intervention d'une donnée documentaire. */
export const interventionKey = (dataKey: string) => `intervention:${dataKey}`;
export const isInterventionKey = (key: string | null | undefined) => !!key && key.startsWith('intervention:');

/** Choix proposés sur la carte (valeurs stables, libellés grand public). */
export const INTERVENTION_CHOICES = [
  { value: 'DONE', label: 'C’est fait' },
  { value: 'NOT_NEEDED', label: 'Pas nécessaire' },
] as const;

/** Libellé générique par nature, si T4 n'a pas fourni de formulation utilisable. */
const LIBELLE: Record<string, string> = {
  TERMINATE: 'Résilier ce contrat',
  RENEW_OR_DECIDE: 'Décider du renouvellement de ce contrat',
  PAY: 'Effectuer le paiement prévu par ce document',
  PERFORM_OBLIGATION: 'Réaliser l’obligation prévue par ce document',
  RETURN_OR_RESTITUTE: 'Restituer ce qui est prévu par ce document',
  VERIFY: 'Vérifier la situation de ce document',
  OTHER: 'Une démarche est attendue pour ce document',
};

const jjmmaaaa = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };

/** Libellé de la carte : l'action réelle (jamais une question de date). Pure. */
export function interventionQuestion(iv: Pick<InterventionDecision, 'action' | 'kind' | 'actBy'>): string {
  const base = (iv.action ?? LIBELLE[iv.kind ?? 'OTHER'] ?? LIBELLE.OTHER).replace(/[.\s]+$/, '');
  return iv.actBy && !/\d{2}\/\d{2}\/\d{4}/.test(base) ? `${base} (avant le ${jjmmaaaa(iv.actBy)})` : base;
}

export interface InterventionUpsertResult {
  status: 'CREATED' | 'UPDATED' | 'USER_DECIDED' | 'SKIPPED';
  actionId: number | null;
}

/**
 * Crée ou met à jour la carte d'intervention d'une donnée documentaire.
 * `signature` : signature de l'évaluation (preuves + configuration) — une
 * décision de l'utilisateur sur la même signature est respectée.
 */
export async function upsertDocumentIntervention(p: {
  accountId: number; fileId: number; rule: ProcessingRule; intervention: InterventionDecision; signature: string | null;
  contract?: unknown;
}): Promise<InterventionUpsertResult> {
  const dataKey = p.rule.fieldKey ?? p.rule.relationKey!;
  const key = interventionKey(dataKey);
  const [dernier] = await db.select({ id: toProcessActions.id, reason: toProcessActions.resolutionReason, ctx: toProcessActions.triggerContext })
    .from(toProcessActions)
    .where(and(
      eq(toProcessActions.accountId, p.accountId), eq(toProcessActions.targetType, 'DOCUMENT'), eq(toProcessActions.targetId, p.fileId),
      eq(toProcessActions.fieldKey, key), isNotNull(toProcessActions.resolvedAt),
    ))
    .orderBy(desc(toProcessActions.resolvedAt)).limit(1);
  const actif = await db.select({ id: toProcessActions.id }).from(toProcessActions)
    .where(and(eq(toProcessActions.accountId, p.accountId), eq(toProcessActions.targetType, 'DOCUMENT'), eq(toProcessActions.targetId, p.fileId),
      eq(toProcessActions.fieldKey, key), isNull(toProcessActions.resolvedAt))).limit(1);
  const tranche = dernier && (dernier.reason === 'USER_ARBITRATED' || dernier.reason === 'NOT_APPLICABLE' || dernier.reason === 'USER_COMPLETED');
  if (!actif.length && tranche && (dernier.ctx as { signature?: string } | null)?.signature === p.signature) {
    return { status: 'USER_DECIDED', actionId: dernier.id };
  }
  const iv = p.intervention;
  const r = await upsertAction({
    accountId: p.accountId, targetType: 'DOCUMENT', targetId: p.fileId, fieldKey: key, actionKind: 'ARBITRATE',
    ruleCode: INTERVENTION_RULE_CODE, question: interventionQuestion(iv),
    proposals: INTERVENTION_CHOICES.map((c) => ({ value: c.value, label: c.label, confidence: 0 })),
    dueDate: iv.actBy ? new Date(`${iv.actBy}T00:00:00Z`) : null,
    triggerContext: {
      signature: p.signature, sourceRule: p.rule.code, dataKey,
      intervention: { kind: iv.kind, action: iv.action, actBy: iv.actBy, timing: iv.timing, justification: iv.justification, consequence: iv.consequence, evidence: iv.evidence },
    },
  });
  return { status: r.status === 'SKIPPED' ? 'SKIPPED' : r.status, actionId: r.actionId ?? null };
}

/**
 * Ferme la carte d'intervention d'une donnée (devenue sans objet : preuve
 * nouvelle, décision « aucune intervention »). Tracée ; jamais sur un échec
 * technique (l'appelant ne l'appelle pas dans ce cas).
 */
export async function closeDocumentIntervention(accountId: number, fileId: number, dataKey: string, details: Record<string, unknown>): Promise<number[]> {
  const now = new Date();
  const closed = await db.update(toProcessActions)
    .set({ resolvedAt: now, resolutionReason: 'OBSOLETE' satisfies ResolutionReason, updatedAt: now })
    .where(and(
      eq(toProcessActions.accountId, accountId), eq(toProcessActions.targetType, 'DOCUMENT'), eq(toProcessActions.targetId, fileId),
      eq(toProcessActions.fieldKey, interventionKey(dataKey)), isNull(toProcessActions.resolvedAt),
    ))
    .returning({ id: toProcessActions.id });
  if (closed.length) {
    await db.insert(toProcessActionEvents).values(closed.map((a) => ({
      actionId: a.id, accountId, event: 'OBSOLETE', actorUserId: null, targetType: 'DOCUMENT', targetId: fileId,
      fieldKey: interventionKey(dataKey), details: { ruleCode: INTERVENTION_RULE_CODE, ...details }, createdAt: now,
    })));
  }
  return closed.map((a) => a.id);
}

type Action = typeof toProcessActions.$inferSelect;

/**
 * « C'est fait » / « Pas nécessaire » depuis la carte (dans la transaction de
 * `resolveArbitration`) : la carte est close, le choix tracé. Aucune donnée
 * documentaire n'est modifiée (l'intervention n'est pas une donnée).
 */
export async function resolveDocumentIntervention(
  tx: DbClient, action: Action, value: unknown, accountId: number, options: ResolveOptions,
): Promise<ResolveResult> {
  if (!INTERVENTION_CHOICES.some((c) => c.value === value)) return { ok: false, previousValue: null, error: 'INVALID_VALUE' };
  const now = new Date();
  await tx.update(toProcessActions)
    .set({ resolvedAt: now, resolutionReason: 'USER_ARBITRATED' satisfies ResolutionReason, updatedAt: now })
    .where(and(eq(toProcessActions.id, action.id), eq(toProcessActions.accountId, accountId)));
  await tx.insert(toProcessActionEvents).values({
    actionId: action.id, accountId, event: 'RESOLVED_ARBITRATION', actorUserId: options.userId ?? null,
    targetType: action.targetType, targetId: action.targetId, fieldKey: action.fieldKey,
    previousValue: null as never, newValue: value as never,
    details: { ruleCode: action.ruleCode, cycleNumber: action.cycleNumber, choice: value }, createdAt: now,
  });
  return { ok: true, previousValue: null };
}

/** « Annuler » : la MÊME carte est rouverte (aucune donnée à restaurer). */
export async function undoDocumentIntervention(action: Action, accountId: number): Promise<ResolveResult> {
  await db.update(toProcessActions)
    .set({ resolvedAt: null, resolutionReason: null, lastSeenAt: new Date(), updatedAt: new Date() })
    .where(and(eq(toProcessActions.id, action.id), eq(toProcessActions.accountId, accountId), sql`${toProcessActions.resolutionReason} = 'USER_ARBITRATED'`));
  return { ok: true, previousValue: null };
}
