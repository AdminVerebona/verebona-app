/**
 * Questions « À traiter » des ambiguïtés de consolidation T3 (lot 42, CDC
 * Opérations V1 ch. 20, B19, C19, C6.3 ; P09).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « À TRAITER » N'EST PAS UN ÉCRAN DE VALIDATION DES OPÉRATIONS
 *
 * Seules les ambiguïtés À IMPACT y arrivent, toujours posées sur un
 * DOCUMENT et formulées en langage métier (le mot « Opération » n'apparaît
 * jamais côté utilisateur) :
 *
 *   OPERATION-MATCH         (a) « Ce document concerne-t-il la même
 *                           intervention que « Facture … du 12/03/2026 » ? »
 *                           — plusieurs rapprochements exacts incompatibles,
 *                           ou verdict sémantique M3 incertain ;
 *   (b) parent Sinistre et (d) dissociation : RETIRÉES au lot 83D (CDC v5
 *                           §18.4, AC39 — plus d'intervention enfant d'un
 *                           sinistre) ; les cartes encore ouvertes sont
 *                           closes par le rattrapage BO « Sinistres :
 *                           nettoyage de l'ancien modèle » ;
 *   OPERATION-AMOUNT        (c) « Ces documents indiquent des montants
 *                           différents pour la même dépense : lequel est le
 *                           bon ? » — même facture, montants différents.
 *   OPERATION-CURRENCY      (d) lot 53D, retour PO D2 : « Aucune devise
 *                           n'est écrite clairement pour ce montant (749,00) :
 *                           de quelle devise s'agit-il ? » — montant gardé hors
 *                           des totaux en euros jusqu'à la réponse.
 *
 * Chaque choix écrit une décision DURABLE puis relance la consolidation :
 *   (a) `business_operation_match_decisions` (C6.3) — CONFIRMED sur
 *       l'Opération choisie, REJECTED sur les autres propositions, ou
 *       REJECTED partout (« c'est une autre intervention ») : jamais
 *       reproposé, jamais rejoué par l'IA ;
 *   (c) (d) source `USER_ARBITRATION` de l'Opération (B19 : « persistée
 *       comme source explicite »), `locator.decision` = AMOUNT / CURRENCY (« je ne sais pas » : devise null, montant laissé hors des
 *       totaux, question non reposée).
 *
 * Une carte par problème (relation propre : `operationMatch:<clé du
 * candidat>`, `operationAmount:<Opération>:
 * <empreinte>`), dédoublonnée par l'index des actions actives et l'empreinte
 * du contexte (`upsertAction`) ; fermée d'elle-même (OBSOLETE) quand la
 * situation se résout seule (le passage T3 suivant ne la reconduit pas).
 * Cartes génériques de la file : mêmes composants desktop et mobile
 * (`ActionCard` / `ActionRow`), priorité « À faire ensuite » — la mascotte
 * (DO_FIRST seulement, deux au plus) n'est pas concernée.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, pgClient } from '@/db';
import { toProcessActionEvents, toProcessActions } from '@/db/schema';
import type { ActionProposal, ResolutionReason } from './action-model';
import type { DbClient, ResolveOptions, ResolveResult } from './resolve-action.service';
import { upsertAction } from './to-process-action.service';
import type { OperationCardNeeds } from '@/services/business-operations/consolidation/card-needs';

export const OPERATION_MATCH_RULE = 'OPERATION-MATCH';
export const OPERATION_AMOUNT_RULE = 'OPERATION-AMOUNT';
/**
 * Lot 83D (CDC v5 §18.4, AC39) : règles RETIRÉES avec l'intervention enfant
 * d'un sinistre — plus jamais posées ni résolues. Seul le rattrapage BO
 * « Sinistres : nettoyage de l'ancien modèle » les lit, pour clore (OBSOLETE,
 * journalisé et restaurable) les cartes encore ouvertes.
 */
export const RETIRED_CLAIM_PARENT_RULES = ['OPERATION-CLAIM-PARENT', 'OPERATION-CLAIM-DETACH'] as const;
/** Lot 53 (retour PO Q17) : bien retiré du sinistre cité par un nouveau document — le rattacher à nouveau ? */
export const OPERATION_ASSET_EXCLUSION_RULE = 'OPERATION-CLAIM-ASSET';
/** Lot 53D (retour PO D2) : devise d'un montant non établie sur le document. */
export const OPERATION_CURRENCY_RULE = 'OPERATION-CURRENCY';
export const OPERATION_CARD_RULES = [
  OPERATION_MATCH_RULE, OPERATION_AMOUNT_RULE, OPERATION_ASSET_EXCLUSION_RULE, OPERATION_CURRENCY_RULE,
] as const;

const MATCH_RELATION = 'operationMatch';
const AMOUNT_RELATION = 'operationAmount';
const EXCLUSION_RELATION = 'operationAssetExclusion';
const CURRENCY_RELATION = 'operationCurrency';

export const matchRelationKey = (candidateKey: string) => `${MATCH_RELATION}:${candidateKey}`;
export const amountRelationKey = (operationId: number, fingerprint: string) => `${AMOUNT_RELATION}:${operationId}:${fingerprint.slice(0, 16)}`;
export const exclusionRelationKey = (operationId: number, assetId: number) => `${EXCLUSION_RELATION}:${operationId}:${assetId}`;
export const currencyRelationKey = (operationId: number, fingerprint: string) => `${CURRENCY_RELATION}:${operationId}:${fingerprint.slice(0, 16)}`;

// ── Libellés métier (purs) ──────────────────────────────────────────────────

/** Nom métier d'une réalité selon sa nature — jamais « Opération » (P09). */
const NOMS: Readonly<Record<string, { meme: string; autre: string }>> = {
  INTERVENTION: { meme: 'la même intervention', autre: 'une autre intervention' },
  CONTRACT: { meme: 'le même contrat', autre: 'un autre contrat' },
  CLAIM: { meme: 'le même sinistre', autre: 'un autre sinistre' },
  ACQUISITION: { meme: 'le même achat', autre: 'un autre achat' },
  FINANCING: { meme: 'le même financement', autre: 'un autre financement' },
  DISPOSAL: { meme: 'la même vente', autre: 'une autre vente' },
};
const NOM_DEFAUT = { meme: 'le même événement', autre: 'un autre événement' };
export const businessNoun = (type: string | null | undefined) => (type && NOMS[type]) || NOM_DEFAUT;

const borne = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const guillemets = (s: string) => `« ${borne(s, 50)} »`;
export const frDate = (iso: string | null | undefined): string | null =>
  iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10).split('-').reverse().join('/') : null;

export function formatAmount(minor: number, currency: string): string {
  // Lot 53D (D2) : « XXX » = aucune devise établie — jamais « ¤ ».
  if (currency === 'XXX') return `${(minor / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (devise non établie)`;
  try {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

/** Ce que la dépense désigne, selon le rôle économique du montant. */
const DEPENSES: Readonly<Record<string, string>> = {
  REALIZED_COST: 'la même dépense', FORECAST_COST: 'la même dépense prévue', REDUCTION: 'la même réduction',
  REFUND: 'le même remboursement', INDEMNITY: 'la même indemnité', PROCEED: 'la même vente',
};

export interface OperationLabel { id: number; label: string }

/** Question (a) — pure. */
export function matchQuestion(type: string | null, basis: 'CERTAIN' | 'M3', labels: readonly OperationLabel[]): string {
  const nom = businessNoun(type).meme;
  const [a, b] = labels;
  if (!b) return `Ce document concerne-t-il ${nom} que ${guillemets(a.label)} ?`;
  return basis === 'CERTAIN'
    ? `Ce document concerne-t-il ${nom} que ${guillemets(a.label)} ou que ${guillemets(b.label)} ?`
    : `Ce document concerne-t-il ${nom} que ${guillemets(a.label)} ou ${guillemets(b.label)} ?`;
}

/** Propositions (a) — pures. M3 : « Non, c'est … une autre » est l'état actuel (rien n'est rattaché). */
export function matchProposals(type: string | null, basis: 'CERTAIN' | 'M3', labels: readonly OperationLabel[]): ActionProposal[] {
  const props: ActionProposal[] = labels.slice(0, 2).map((l, i) => ({
    value: `SAME:${l.id}`,
    // Lot 56A : « Oui » — jamais un accord grammatical dépendant de la nature (contrat, intervention…).
    label: basis === 'M3' && labels.length === 1 ? 'Oui' : `Oui, ${guillemets(l.label)}`,
    confidence: 0.6 - i * 0.1,
  }));
  if (basis === 'M3') props.push({ value: 'DISTINCT', label: `Non, c’est ${businessNoun(type).autre}`, confidence: 1, isCurrentValue: true });
  return props;
}

export function amountQuestion(kind: string): string {
  return `Ces documents indiquent des montants différents pour ${DEPENSES[kind] ?? 'la même dépense'} : lequel est le bon ?`;
}

export function amountProposals(
  options: ReadonlyArray<{ amountMinor: number; currency: string; title: string | null }>, retained: { amountMinor: number; currency: string },
): ActionProposal[] {
  const lib = (o: { amountMinor: number; currency: string; title: string | null }) =>
    `${formatAmount(o.amountMinor, o.currency)}${o.title ? ` — ${guillemets(o.title)}` : ''}`;
  const est = (o: { amountMinor: number; currency: string }) => o.amountMinor === retained.amountMinor && o.currency === retained.currency;
  return [
    ...options.filter((o) => !est(o)).slice(-2).reverse().map((o, i) => ({ value: `AMOUNT:${o.amountMinor}:${o.currency}`, label: lib(o), confidence: 0.6 - i * 0.1 })),
    ...options.filter(est).slice(0, 1).map((o) => ({ value: `AMOUNT:${o.amountMinor}:${o.currency}`, label: lib(o), confidence: 1, isCurrentValue: true })),
  ];
}

/** Question (e) — lot 53, Q17 (pure). */
export function exclusionQuestion(assetName: string, claimLabel: string): string {
  return `Ce document mentionne ${guillemets(assetName)} ; ce bien a été retiré du sinistre ${guillemets(claimLabel)} : faut-il l’y rattacher à nouveau ?`;
}

/** Propositions (e) : réintégrer, ou garder l'exclusion (état actuel) — pures. */
export function exclusionProposals(assetName: string): ActionProposal[] {
  return [
    { value: 'REINSTATE', label: `Oui, rattacher ${guillemets(assetName)} au sinistre`, confidence: 0.6 },
    // Lot 56A : formulation neutre (le nom du bien peut être féminin ou masculin).
    { value: 'KEEP_EXCLUDED', label: 'Non, pas de nouveau rattachement au sinistre', confidence: 1, isCurrentValue: true },
  ];
}

const NOMS_DEVISES: Readonly<Record<string, string>> = { EUR: 'euros', CHF: 'francs suisses', USD: 'dollars américains', GBP: 'livres sterling', CAD: 'dollars canadiens' };

/** Question (d) — pure. */
export function currencyQuestion(amountMinor: number): string {
  const n = (amountMinor / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `Aucune devise n’est écrite clairement pour le montant ${n} de ce document : de quelle devise s’agit-il ?`;
}

/** Propositions (d) — pures. « Je ne sais pas » est l'état actuel : montant hors des totaux en euros. */
export function currencyProposals(candidates: readonly string[]): ActionProposal[] {
  const liste = [...new Set(candidates.filter((c) => /^[A-Z]{3}$/.test(c) && c !== 'XXX'))].slice(0, 3);
  return [
    ...liste.map((c, i) => ({ value: `CURRENCY:${c}`, label: `En ${NOMS_DEVISES[c] ?? c}`, confidence: 0.6 - i * 0.1 })),
    { value: 'UNKNOWN', label: 'Je ne sais pas — le laisser hors des totaux', confidence: 1, isCurrentValue: true },
  ];
}

// ── Lectures ────────────────────────────────────────────────────────────────

const intArray = (v: readonly number[]) => `{${v.filter((x) => Number.isSafeInteger(x)).join(',')}}`;

/**
 * Libellé métier d'une Opération : titre de son document le plus récent
 * (hors document de la carte), date principale ; à défaut prestataire.
 */
async function operationLabels(accountId: number, ids: readonly number[], excludeFileId: number | null): Promise<Map<number, { label: string; type: string | null }>> {
  if (!ids.length) return new Map();
  const r = (await pgClient.unsafe(
    `SELECT o.id, o.type_code, o.provider, COALESCE(o.realized_date, o.planned_date, o.start_date)::text AS d,
            (SELECT COALESCE(f.retained_title, f.original_filename, f.filename)
               FROM business_operation_sources s
               JOIN asset_files f ON f.id = (CASE WHEN s.source_entity_key ~ '^[0-9]{1,9}$' THEN s.source_entity_key::int END)
                AND f.account_id = s.account_id AND f.deleted_at IS NULL
              WHERE s.operation_id = o.id AND s.active AND s.source_kind = 'DOCUMENT' AND f.id IS DISTINCT FROM $3::int
              ORDER BY s.id DESC LIMIT 1) AS titre
       FROM business_operations o WHERE o.account_id = $1 AND o.id = ANY($2::bigint[])`,
    [accountId, intArray(ids), excludeFileId] as never[],
  )) as unknown as Array<{ id: number; type_code: string | null; provider: string | null; d: string | null; titre: string | null }>;
  const out = new Map<number, { label: string; type: string | null }>();
  for (const x of r) {
    const date = frDate(x.d);
    const base = x.titre ?? x.provider ?? (x.type_code === 'CLAIM' ? 'Sinistre' : 'Document');
    out.set(Number(x.id), { label: date ? `${borne(base, 36)} du ${date}` : base, type: x.type_code });
  }
  return out;
}

async function fileTitles(accountId: number, ids: readonly number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const r = (await pgClient.unsafe(
    `SELECT id, COALESCE(retained_title, original_filename, filename, 'Document') AS t FROM asset_files WHERE account_id = $1 AND id = ANY($2::int[])`,
    [accountId, intArray(ids)] as never[],
  )) as unknown as Array<{ id: number; t: string }>;
  return new Map(r.map((x) => [Number(x.id), x.t]));
}

async function closeCards(ids: number[], reason: string, extra: ReadonlyMap<number, Record<string, unknown>> = new Map()): Promise<number> {
  if (!ids.length) return 0;
  const now = new Date();
  const closed = await db.update(toProcessActions)
    .set({ resolvedAt: now, resolutionReason: 'OBSOLETE' satisfies ResolutionReason, updatedAt: now })
    .where(and(sql`${toProcessActions.id} = ANY(${intArray(ids)}::int[])`, isNull(toProcessActions.resolvedAt)))
    .returning({ id: toProcessActions.id, accountId: toProcessActions.accountId, targetType: toProcessActions.targetType, targetId: toProcessActions.targetId, relationKey: toProcessActions.relationKey, ruleCode: toProcessActions.ruleCode });
  if (closed.length) {
    await db.insert(toProcessActionEvents).values(closed.map((a) => ({
      actionId: a.id, accountId: a.accountId, event: 'OBSOLETE', actorUserId: null, targetType: a.targetType, targetId: a.targetId,
      fieldKey: a.relationKey, details: { ruleCode: a.ruleCode, reason, ...(extra.get(Number(a.id)) ?? {}) }, createdAt: now,
    })));
  }
  return closed.length;
}

/**
 * Lot 56A : motif tracé de la fermeture automatique d'une question « même
 * réalité ? » — issue T3 actuelle du document (rattachement M3 par l'IA,
 * référence, création…) et, pour un rattachement sémantique, l'issue et la
 * raison données par le modèle. Journal `to_process_action_events`
 * (OBSOLETE) : explicable et réversible (BO, historique de l'Opération).
 */
async function matchClosureTrace(
  accountId: number, cartes: ReadonlyArray<{ id: number; rule_code: string; target_id: number; candidate_key: string | null }>,
): Promise<Map<number, Record<string, unknown>>> {
  const out = new Map<number, Record<string, unknown>>();
  const match = cartes.filter((c) => c.rule_code === OPERATION_MATCH_RULE && c.candidate_key);
  if (!match.length) return out;
  const r = (await pgClient.unsafe(
    `SELECT c.file_id, c.candidate_key, c.t3_outcome, c.t3_reason, c.t3_operation_id::bigint AS operation_id,
            c.t3_detail->'m3'->'verdict' AS verdict
       FROM document_operation_candidates c
      WHERE c.account_id = $1 AND c.status = 'ACTIVE' AND c.file_id = ANY($2::int[])`,
    [accountId, intArray(match.map((c) => Number(c.target_id)))] as never[],
  )) as unknown as Array<{ file_id: number; candidate_key: string; t3_outcome: string | null; t3_reason: string | null; operation_id: string | null; verdict: Record<string, unknown> | null }>;
  for (const c of match) {
    const x = r.find((y) => Number(y.file_id) === Number(c.target_id) && y.candidate_key === c.candidate_key);
    if (!x) continue;
    const v = x.t3_reason === 'MATCH_M3' && x.verdict ? x.verdict : null;
    out.set(Number(c.id), {
      t3Outcome: x.t3_outcome, t3Reason: x.t3_reason, operationId: x.operation_id === null ? null : Number(x.operation_id),
      ...(v ? { ai: { resolution: v.resolution ?? null, reason: v.reason ?? null, concordantSignals: v.concordantSignals ?? [] } } : {}),
    });
  }
  return out;
}

// ── Producteur ──────────────────────────────────────────────────────────────

export interface OperationCardsReport { created: number; updated: number; closed: number; skipped: number; /** Lot 54D (E05) : échec de synchronisation (repris au passage T3 suivant). */ error?: string }

/**
 * Pose, met à jour ou ferme les cartes demandées par un passage T3 (après
 * commit). Ne lève jamais (une carte manquée est reprise au passage suivant).
 */
export async function syncOperationCards(accountId: number, needs: OperationCardNeeds): Promise<OperationCardsReport> {
  const rep: OperationCardsReport = { created: 0, updated: 0, closed: 0, skipped: 0 };
  const compter = (status: string) => {
    if (status === 'CREATED') rep.created++;
    else if (status === 'UPDATED') rep.updated++;
    else rep.skipped++;
  };
  try {
    const gardees = new Set<string>();

    // (a) Rapprochement document → réalité existante.
    for (const n of needs.match) {
      const labels = await operationLabels(accountId, n.operationIds, n.fileId);
      const offertes = n.operationIds.filter((id) => labels.has(id)).slice(0, 2).map((id) => ({ id, label: labels.get(id)!.label }));
      if (!offertes.length) continue;
      const type = n.typeHint ?? labels.get(offertes[0].id)?.type ?? null;
      const r = await upsertAction({
        accountId, targetType: 'DOCUMENT', targetId: n.fileId, relationKey: matchRelationKey(n.candidateKey),
        actionKind: 'ARBITRATE', ruleCode: OPERATION_MATCH_RULE,
        question: matchQuestion(type, n.basis, offertes), proposals: matchProposals(type, n.basis, offertes),
        triggerContext: { kind: 'operation_match', candidateKey: n.candidateKey, basis: n.basis, operationIds: offertes.map((o) => o.id) },
      });
      compter(r.status);
      gardees.add(`M:${n.fileId}:${matchRelationKey(n.candidateKey)}`);
    }

    // (c) Montant contradictoire de même rôle.
    for (const n of needs.amount) {
      const titres = await fileTitles(accountId, [...new Set(n.options.flatMap((o) => o.fileIds))]);
      const options = n.options.map((o) => ({ amountMinor: o.amountMinor, currency: o.currency, title: o.fileIds.map((f) => titres.get(f)).find(Boolean) ?? null }));
      const r = await upsertAction({
        accountId, targetType: 'DOCUMENT', targetId: n.fileId, relationKey: amountRelationKey(n.operationId, n.fingerprint),
        actionKind: 'ARBITRATE', ruleCode: OPERATION_AMOUNT_RULE,
        question: amountQuestion(n.kind), proposals: amountProposals(options, n.retained),
        triggerContext: {
          kind: 'operation_amount', operationId: n.operationId, fingerprint: n.fingerprint,
          options: n.options.map((o) => ({ amountMinor: o.amountMinor, currency: o.currency })),
        },
      });
      compter(r.status);
      gardees.add(`A:${n.fileId}:${amountRelationKey(n.operationId, n.fingerprint)}`);
    }

    // (e) Lot 53 (Q17) : bien exclu du sinistre cité par un document non encore arbitré.
    for (const n of needs.exclusion ?? []) {
      const fileId = n.fileIds.at(-1);
      if (fileId === undefined) continue;
      const labels = await operationLabels(accountId, [n.operationId], null);
      const [bien] = (await pgClient.unsafe(`SELECT name FROM assets WHERE id = $1 AND account_id = $2`, [n.assetId, accountId] as never[])) as unknown as Array<{ name: string | null }>;
      const nom = bien?.name ?? 'ce bien';
      const titres = await fileTitles(accountId, n.fileIds);
      const r = await upsertAction({
        accountId, targetType: 'DOCUMENT', targetId: fileId, relationKey: exclusionRelationKey(n.operationId, n.assetId),
        actionKind: 'ARBITRATE', ruleCode: OPERATION_ASSET_EXCLUSION_RULE,
        question: exclusionQuestion(nom, labels.get(n.operationId)?.label ?? 'Sinistre'), proposals: exclusionProposals(nom),
        triggerContext: {
          kind: 'operation_asset_exclusion', operationId: n.operationId, assetId: n.assetId, fileIds: n.fileIds,
          // Provenance : document(s) à l'origine de la contradiction.
          documents: n.fileIds.map((f) => ({ fileId: f, title: titres.get(f) ?? 'Document' })),
        },
      });
      compter(r.status);
      gardees.add(`E:${fileId}:${exclusionRelationKey(n.operationId, n.assetId)}`);
    }

    // (d) Lot 53D (D2) : devise d'un montant non établie.
    for (const n of needs.currency ?? []) {
      const r = await upsertAction({
        accountId, targetType: 'DOCUMENT', targetId: n.fileId, relationKey: currencyRelationKey(n.operationId, n.fingerprint),
        actionKind: 'ARBITRATE', ruleCode: OPERATION_CURRENCY_RULE,
        question: currencyQuestion(n.amountMinor), proposals: currencyProposals(n.candidates),
        triggerContext: {
          kind: 'operation_currency', operationId: n.operationId, fingerprint: n.fingerprint, amountMinor: n.amountMinor,
          candidates: currencyProposals(n.candidates).flatMap((p) => (String(p.value).startsWith('CURRENCY:') ? [String(p.value).slice(9)] : [])),
        },
      });
      compter(r.status);
      gardees.add(`C:${n.fileId}:${currencyRelationKey(n.operationId, n.fingerprint)}`);
    }

    // Fermeture automatique : cartes des documents / Opérations réexaminés que ce passage ne reconduit pas.
    const ouvertes = (await pgClient.unsafe(
      `SELECT id, rule_code, target_id, relation_key, (trigger_context->>'operationId')::bigint AS op,
              trigger_context->>'candidateKey' AS candidate_key
         FROM to_process_actions
        WHERE account_id = $1 AND target_type = 'DOCUMENT' AND resolved_at IS NULL AND rule_code = ANY($2::text[])
          AND ((rule_code = $3 AND target_id = ANY($4::int[]))
               OR (rule_code <> $3 AND (trigger_context->>'operationId')::bigint = ANY($5::bigint[])))`,
      [accountId, `{${OPERATION_CARD_RULES.join(',')}}`, OPERATION_MATCH_RULE, intArray(needs.reviewedFiles), intArray(needs.reviewedOperations)] as never[],
    )) as unknown as Array<{ id: number; rule_code: string; target_id: number; relation_key: string; candidate_key: string | null }>;
    const prefixe: Record<string, string> = {
      [OPERATION_MATCH_RULE]: 'M', [OPERATION_AMOUNT_RULE]: 'A',
      [OPERATION_ASSET_EXCLUSION_RULE]: 'E', [OPERATION_CURRENCY_RULE]: 'C',
    };
    const fermees = ouvertes.filter((o) => !gardees.has(`${prefixe[o.rule_code]}:${o.target_id}:${o.relation_key}`));
    rep.closed += await closeCards(fermees.map((o) => Number(o.id)), 'RESOLVED_BY_T3', await matchClosureTrace(accountId, fermees));
  } catch (e) {
    console.error(`[to-process] cartes de consolidation du compte ${accountId} non synchronisées :`, (e as Error).message);
    // Lot 54D (E05) : l'échec est RENDU à l'appelant (reprise programmée), plus jamais avalé.
    rep.error = (e as Error).message || 'CARDS_SYNC_FAILED';
  }
  return rep;
}

// ══════════════════════════════════════════════════════════════════════════
// RÉSOLUTION (appelée par `resolveArbitration`, dans SA transaction)
// ══════════════════════════════════════════════════════════════════════════

type Action = typeof toProcessActions.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface MatchCtx { kind: 'operation_match'; candidateKey: string; basis: 'CERTAIN' | 'M3'; operationIds: number[] }
interface AmountCtx { kind: 'operation_amount'; operationId: number; fingerprint: string; options: Array<{ amountMinor: number; currency: string }> }
interface ExclusionCtx { kind: 'operation_asset_exclusion'; operationId: number; assetId: number; fileIds: number[] }
interface CurrencyCtx { kind: 'operation_currency'; operationId: number; fingerprint: string; amountMinor: number; candidates: string[] }

/** Choix reçu (pur) ; `null` : invalide (une requête forgée ne désigne rien hors de la carte). */
export function parseOperationCardChoice(ruleCode: string, value: unknown, ctx: unknown):
  | { kind: 'SAME'; operationId: number } | { kind: 'DISTINCT' }
  | { kind: 'AMOUNT'; amountMinor: number; currency: string }
  | { kind: 'REINSTATE' } | { kind: 'KEEP_EXCLUDED' } | { kind: 'CURRENCY'; currency: string | null } | null {
  if (typeof value !== 'string' || !ctx || typeof ctx !== 'object') return null;
  if (ruleCode === OPERATION_ASSET_EXCLUSION_RULE) {
    if (value === 'REINSTATE') return { kind: 'REINSTATE' };
    return value === 'KEEP_EXCLUDED' ? { kind: 'KEEP_EXCLUDED' } : null;
  }
  if (ruleCode === OPERATION_MATCH_RULE) {
    const c = ctx as MatchCtx;
    if (value === 'DISTINCT') return c.basis === 'M3' ? { kind: 'DISTINCT' } : null;
    const m = /^SAME:(\d+)$/.exec(value);
    return m && c.operationIds?.includes(Number(m[1])) ? { kind: 'SAME', operationId: Number(m[1]) } : null;
  }
  if (ruleCode === OPERATION_AMOUNT_RULE) {
    const c = ctx as AmountCtx;
    const m = /^AMOUNT:(\d+):([A-Z]{3})$/.exec(value);
    if (!m) return null;
    const o = { amountMinor: Number(m[1]), currency: m[2] };
    return c.options?.some((x) => x.amountMinor === o.amountMinor && x.currency === o.currency) ? { kind: 'AMOUNT', ...o } : null;
  }
  if (ruleCode === OPERATION_CURRENCY_RULE) {
    const c = ctx as CurrencyCtx;
    if (value === 'UNKNOWN') return { kind: 'CURRENCY', currency: null };
    const m = /^CURRENCY:([A-Z]{3})$/.exec(value);
    return m && c.candidates?.includes(m[1]) ? { kind: 'CURRENCY', currency: m[1] } : null;
  }
  return null;
}

/** Opération canonique (redirection de fusion), même compte. */
async function canonicalId(tx: Tx, accountId: number, id: number): Promise<number | null> {
  const r = (await tx.execute(sql`
    WITH RECURSIVE ch(id, m, n) AS (
      SELECT id, merged_into_operation_id, 1 FROM business_operations WHERE id = ${id} AND account_id = ${accountId}
      UNION ALL
      SELECT o.id, o.merged_into_operation_id, ch.n + 1 FROM business_operations o JOIN ch ON o.id = ch.m WHERE ch.n < 10
    ) SELECT id FROM ch WHERE m IS NULL LIMIT 1`)) as unknown as Array<{ id: string }>;
  return r[0] ? Number(r[0].id) : null;
}

interface Previous {
  decisionIds?: number[]; sourceId?: number | null; operationId?: number; resolvedAt?: string;
  /** Lot 53 (Q17) : bien et documents de l'arbitrage d'une exclusion. */
  assetId?: number; fileIds?: number[];
}

export async function resolveOperationCard(
  tx: DbClient, action: Action, value: unknown, accountId: number, options: ResolveOptions,
): Promise<ResolveResult & { afterCommit?: () => Promise<void> }> {
  const choice = parseOperationCardChoice(action.ruleCode, value, action.triggerContext);
  if (!choice) return { ok: false, previousValue: null, error: 'INVALID_VALUE' };
  const t = tx as unknown as Tx;
  const { withBusinessOperationWriteInTx } = await import('@/services/business-operations/write');
  const { USER_DISTINCT_REASON } = await import('@/services/business-operations/consolidation/consolidator');
  const now = new Date();
  const previous: Previous = { resolvedAt: now.toISOString() };
  let fileToConsolidate: number | null = null;
  let stale = false;

  const { events, result: cards } = await withBusinessOperationWriteInTx(t, [accountId], async (session) => {
    const repo = session.repository(accountId);
    const { emptyCardNeeds } = await import('@/services/business-operations/consolidation/card-needs');
    const needs = emptyCardNeeds();
    if (choice.kind === 'SAME' || choice.kind === 'DISTINCT') {
      const ctx = action.triggerContext as unknown as MatchCtx;
      const ids: number[] = [];
      for (const id of ctx.operationIds) {
        const c = await canonicalId(t, accountId, id);
        if (c !== null && !ids.includes(c)) ids.push(c);
      }
      const choisie = choice.kind === 'SAME' ? await canonicalId(t, accountId, choice.operationId) : null;
      if (!ids.length || (choice.kind === 'SAME' && choisie === null)) { stale = true; return needs; }
      const source = { sourceKind: 'DOCUMENT' as const, entityKey: action.targetId, sourceVersion: ctx.candidateKey, origin: 'USER_ARBITRATION' as const };
      const decisionIds: number[] = [];
      for (const id of ids) {
        const confirmee = choice.kind === 'SAME' && id === choisie;
        decisionIds.push(await repo.recordMatchDecision({
          ...source, operationId: id, decision: confirmee ? 'CONFIRMED' : 'REJECTED',
          reasonCode: confirmee ? 'USER_SAME_OPERATION' : choice.kind === 'DISTINCT' ? USER_DISTINCT_REASON : 'USER_OTHER_CHOSEN',
        }));
      }
      previous.decisionIds = decisionIds;
      fileToConsolidate = action.targetId;
      return needs;
    }
    const ctx = action.triggerContext as unknown as AmountCtx | ExclusionCtx | CurrencyCtx;
    const opId = await canonicalId(t, accountId, ctx.operationId);
    if (opId === null) { stale = true; return needs; }
    const op = await repo.load(opId, { allowInactive: true });
    if (op.invalidatedAt !== null) { stale = true; return needs; }
    previous.operationId = opId;
    if (choice.kind === 'REINSTATE' || choice.kind === 'KEEP_EXCLUDED') {
      // Lot 53 (Q17) : nouvel arbitrage de l'exclusion — jamais décidé à la place de l'utilisateur.
      const x = ctx as ExclusionCtx;
      const ex = await import('@/services/business-operations/consolidation/asset-exclusions');
      if (choice.kind === 'REINSTATE') {
        await ex.releaseExclusion(session.tx, accountId, opId, x.assetId, 'USER_CLAIM_ASSET_REINSTATED');
      } else {
        await ex.acknowledgeExclusion(session.tx, accountId, opId, x.assetId, x.fileIds ?? []);
      }
      previous.assetId = x.assetId;
      previous.fileIds = x.fileIds ?? [];
      const { reconsolidateOperation } = await import('@/services/business-operations/consolidation/consolidator');
      await reconsolidateOperation(repo, session.tx, opId, now.toISOString().slice(0, 10), undefined, needs);
      return needs;
    }
    const genre = choice.kind === 'AMOUNT' ? 'AMOUNT' : 'CURRENCY';
    // La décision la plus récente remplace la précédente du même genre (et de la même empreinte).
    const anciennes = (await t.execute(sql`
      SELECT id FROM business_operation_sources
       WHERE operation_id = ${opId} AND account_id = ${accountId} AND active AND source_kind = 'USER_ARBITRATION'
         AND locator->>'decision' = ${genre}
         AND locator->>'fingerprint' = ${(ctx as AmountCtx).fingerprint ?? ''}`)) as unknown as Array<{ id: string }>;
    for (const a of anciennes) await repo.deactivateSource(Number(a.id), 'USER_DECISION_REPLACED');
    const locator = choice.kind === 'AMOUNT'
      ? { decision: 'AMOUNT', fingerprint: (ctx as AmountCtx).fingerprint, amountMinor: choice.amountMinor, currency: choice.currency, known: (ctx as AmountCtx).options }
      : { decision: 'CURRENCY', fingerprint: (ctx as CurrencyCtx).fingerprint, currency: choice.kind === 'CURRENCY' ? choice.currency : null };
    previous.sourceId = await repo.addSource(opId, {
      kind: 'USER_ARBITRATION', entityKey: action.id, authority: 'USER', confidence: 'certain', locator,
    }, genre === 'AMOUNT' ? 'USER_AMOUNT_CHOSEN' : 'USER_CURRENCY_CONFIRMED');
    const { reconsolidateOperation } = await import('@/services/business-operations/consolidation/consolidator');
    await reconsolidateOperation(repo, session.tx, opId, now.toISOString().slice(0, 10), undefined, needs);
    return needs;
  }, { actorUserId: options.userId ?? null, correlationId: `to-process:${action.publicId}` });

  if (stale) {
    await t.update(toProcessActions).set({ resolvedAt: now, resolutionReason: 'OBSOLETE' satisfies ResolutionReason, updatedAt: now })
      .where(eq(toProcessActions.id, action.id));
    await t.insert(toProcessActionEvents).values({
      actionId: action.id, accountId, event: 'OBSOLETE', actorUserId: options.userId ?? null, targetType: action.targetType,
      targetId: action.targetId, fieldKey: action.relationKey, details: { ruleCode: action.ruleCode, reason: 'OPERATION_GONE' }, createdAt: now,
    });
    return { ok: false, previousValue: null, error: 'STALE' };
  }

  await t.update(toProcessActions).set({ resolvedAt: now, resolutionReason: 'USER_ARBITRATED' satisfies ResolutionReason, updatedAt: now })
    .where(eq(toProcessActions.id, action.id));
  await t.insert(toProcessActionEvents).values({
    actionId: action.id, accountId, event: 'RESOLVED_ARBITRATION', actorUserId: options.userId ?? null,
    targetType: action.targetType, targetId: action.targetId, fieldKey: action.relationKey,
    previousValue: previous as never, newValue: choice as never,
    details: { ruleCode: action.ruleCode, cycleNumber: action.cycleNumber, choice: choice.kind, context: action.triggerContext },
    createdAt: now,
  });
  const fichier = fileToConsolidate as number | null;
  return {
    ok: true,
    previousValue: previous,
    afterCommit: () => afterDecision(accountId, fichier, events, cards, action.publicId),
  };
}

/** Après commit : événements Opération, consolidation du document, cartes, file T3 (TRG-018). Ne lève jamais. */
async function afterDecision(
  accountId: number, fileId: number | null, events: import('@/services/business-operations/events').BusinessOperationEvent[],
  cards: OperationCardNeeds, publicId: string,
): Promise<void> {
  try {
    const { publishBusinessOperationEvents } = await import('@/services/business-operations/events');
    await publishBusinessOperationEvents(events);
    if (fileId !== null) {
      const { consolidateDocument } = await import('@/services/business-operations/consolidation/consolidator');
      await consolidateDocument(accountId, fileId, { correlationId: `to-process:${publicId}` });
    } else {
      await syncOperationCards(accountId, cards);
    }
    const { notifyOperationsEvent } = await import('@/services/business-operations/consolidation/queue');
    notifyOperationsEvent(accountId, { trigger: 'arbitration_resolved', ...(fileId !== null ? { fileId } : {}) });
  } catch (e) {
    console.error(`[to-process] décision ${publicId} : reconsolidation différée au passage T3 suivant :`, (e as Error).message);
  }
}

/**
 * Annulation (§8.5) : la décision durable est retirée (décisions désactivées,
 * source de décision retirée), les rattachements qu'elle avait produits sont
 * défaits, la MÊME carte est rouverte, puis la consolidation la recalcule.
 */
export async function undoOperationCard(action: Action, accountId: number): Promise<ResolveResult> {
  const [ev] = await db.select({ previousValue: toProcessActionEvents.previousValue })
    .from(toProcessActionEvents)
    .where(and(eq(toProcessActionEvents.actionId, action.id), eq(toProcessActionEvents.accountId, accountId), eq(toProcessActionEvents.event, 'RESOLVED_ARBITRATION')))
    .orderBy(desc(toProcessActionEvents.id)).limit(1);
  const prev = (ev?.previousValue ?? null) as Previous | null;
  const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
  const { reconsolidateOperation } = await import('@/services/business-operations/consolidation/consolidator');
  const { emptyCardNeeds } = await import('@/services/business-operations/consolidation/card-needs');
  const needs = emptyCardNeeds();
  let fileId: number | null = null;
  await withBusinessOperationWrite(accountId, async (repo, session) => {
    const tx = session.tx;
    const today = new Date().toISOString().slice(0, 10);
    if (action.ruleCode === OPERATION_MATCH_RULE) {
      fileId = action.targetId;
      await repo.deactivateMatchDecisions(prev?.decisionIds ?? []);
      // Rattachements produits depuis la décision : retirés (la source sera réévaluée).
      const ctx = action.triggerContext as unknown as MatchCtx;
      const sources = (await tx.execute(sql`
        SELECT id, operation_id FROM business_operation_sources
         WHERE account_id = ${accountId} AND active AND source_kind = 'DOCUMENT' AND source_entity_key = ${String(action.targetId)}
           AND locator->>'candidateKey' = ${ctx.candidateKey} AND created_at >= ${prev?.resolvedAt ?? new Date(0).toISOString()}::timestamptz`)) as unknown as Array<{ id: string; operation_id: string }>;
      for (const s of sources) {
        await repo.deactivateSource(Number(s.id), 'USER_DECISION_UNDONE');
        await reconsolidateOperation(repo, tx, Number(s.operation_id), today, undefined, needs);
      }
    } else if (prev?.operationId && action.ruleCode === OPERATION_ASSET_EXCLUSION_RULE && prev.assetId) {
      // Lot 53 (Q17) : l'exclusion redevient celle d'avant l'arbitrage.
      const ex = await import('@/services/business-operations/consolidation/asset-exclusions');
      const [ev2] = await db.select({ newValue: toProcessActionEvents.newValue }).from(toProcessActionEvents)
        .where(and(eq(toProcessActionEvents.actionId, action.id), eq(toProcessActionEvents.event, 'RESOLVED_ARBITRATION')))
        .orderBy(desc(toProcessActionEvents.id)).limit(1);
      const choix = (ev2?.newValue as { kind?: string } | null)?.kind;
      if (choix === 'REINSTATE') await ex.excludeAsset(tx, accountId, prev.operationId, prev.assetId, null);
      else await ex.unacknowledgeExclusion(tx, accountId, prev.operationId, prev.assetId, prev.fileIds ?? []);
      await reconsolidateOperation(repo, tx, prev.operationId, today, undefined, needs);
    } else if (prev?.operationId) {
      if (prev.sourceId) await repo.deactivateSource(prev.sourceId, 'USER_DECISION_UNDONE');
      await reconsolidateOperation(repo, tx, prev.operationId, today, undefined, needs);
    }
    await tx.update(toProcessActions)
      .set({ resolvedAt: null, resolutionReason: null, lastSeenAt: new Date(), updatedAt: new Date() })
      .where(and(eq(toProcessActions.id, action.id), eq(toProcessActions.accountId, accountId)));
  }, { correlationId: `to-process-undo:${action.publicId}` });
  const fichier = fileId as number | null;
  try {
    if (fichier !== null) {
      const { consolidateDocument } = await import('@/services/business-operations/consolidation/consolidator');
      await consolidateDocument(accountId, fichier, { correlationId: `to-process-undo:${action.publicId}` });
    } else {
      await syncOperationCards(accountId, needs);
    }
  } catch (e) {
    console.error(`[to-process] annulation ${action.publicId} : reconsolidation différée :`, (e as Error).message);
  }
  return { ok: true, previousValue: null };
}

/** Règle d'une carte de consolidation ? */
export function isOperationCardRule(ruleCode: string): boolean {
  return (OPERATION_CARD_RULES as readonly string[]).includes(ruleCode);
}
