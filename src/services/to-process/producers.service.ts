/**
 * Producteurs d'actions — CDC V2.0 §7.4, §10.3, §10.5.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS FAMILLES QUI N'AVAIENT PLUS DE SOURCE
 *
 * Le pont de réconciliation couvre les biens, le pipeline d'analyse couvre
 * les documents. Restaient trois problèmes que la V1 détectait et que rien ne
 * recréait en V2 : agenda sans date, équipement rattaché à aucun bien,
 * fournisseur à confirmer.
 *
 * La migration du lot 4 les reprenait UNE FOIS. Après quoi ils disparaissaient
 * définitivement : un équipement créé le lendemain de la bascule n'aurait
 * jamais remonté. Ce module est leur source permanente.
 *
 * Lot 28 : quatrième famille, les DOCUMENTS (`produceDocumentActions`) —
 * réévaluation sans analyse des règles du pont documentaire générique
 * (rattachement à un bien, données requises), rattrapage des documents
 * existants compris ; et les cibles disparues incluent désormais documents
 * supprimés ou regroupés et biens supprimés.
 *
 * ── UN BALAYAGE, PAS UN DÉCLENCHEUR ───────────────────────────────────────
 *
 * Ces trois problèmes ne naissent pas d'une analyse : ils naissent d'un état
 * de la base — une date absente, un rattachement manquant. Les détecter à
 * l'écriture supposerait d'instrumenter chaque endroit qui crée un événement
 * ou un équipement, et il suffirait d'en oublier un.
 *
 * Le balayage périodique accepte un délai (quelques heures) en échange d'une
 * garantie : aucun chemin de création ne peut lui échapper.
 *
 * ── LA FERMETURE COMPTE AUTANT QUE LA CRÉATION ────────────────────────────
 *
 * Chaque producteur ferme les actions dont le problème a disparu (§7.3,
 * « problème devenu sans objet »). Sans cela, une date saisie ailleurs
 * laisserait la carte en place, et l'utilisateur répondrait deux fois à la
 * même question.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, pgClient } from '@/db';
import {
  agendaItems,
  assetFiles,
  assets,
  equipments,
  rooms,
  supplierReviewItems,
  toProcessActionEvents,
  toProcessActions,
} from '@/db/schema';
import type { ActionProposal } from './action-model';
import type { TraceFailure } from './trace-retries';
import { upsertAction } from './to-process-action.service';
import {
  decideAdmissibility, recordFamilyDecision, type AdmissibilityDecision, type DecisionTrigger, type FamilyDecisionRecord,
} from './admissibility';

export interface ProducerReport {
  created: number;
  updated: number;
  closed: number;
  /**
   * Lot 75I (B) : erreurs NON bloquantes du producteur (écriture non
   * confirmée, trace non écrite…) — le reste du traitement a réussi ; elles
   * remontent au bilan du balayage (statut « partial »), jamais en console seule.
   */
  errorDetails?: ScanErrorDetail[];
}

/**
 * Lot 75I (B) — erreur détaillée d'un passage : compte, document (si
 * documentaire), règle, étape, nature, cause. Nature : PERSISTENCE_FAILED
 * (écriture non confirmée, persistance), READ_FAILED, AI_OR_MEMORY_FAILED,
 * DERIVATION_FAILED, EVALUATION_FAILED, TRACE_FAILED (journalisation),
 * FAMILY_FAILED, ACCOUNT_FAILED. Un refus de PROTECTION d'une valeur de
 * l'utilisateur n'est jamais une erreur (compté à part).
 */
export interface ScanErrorDetail {
  accountId: number;
  fileId: number | null;
  ruleCode: string;
  step: string;
  kind: string;
  cause: string;
  /** Cible non documentaire (agenda, équipement, fournisseur). */
  targetType?: string;
  targetId?: number;
  /** Lot 76 (C8) : trace non écrite — n° de reprise (null : reprise impossible). */
  retryId?: number | null;
}

const EMPTY: ProducerReport = { created: 0, updated: 0, closed: 0 };

function merge(...reports: ProducerReport[]): Required<ProducerReport> {
  return reports.reduce<Required<ProducerReport>>(
    (acc, r) => ({
      created: acc.created + r.created,
      updated: acc.updated + r.updated,
      closed: acc.closed + r.closed,
      errorDetails: [...acc.errorDetails, ...(r.errorDetails ?? [])],
    }),
    { ...EMPTY, errorDetails: [] },
  );
}

/** Erreur de trace d'une décision de famille (lot 75I, E) → détail d'erreur, jamais console seule. Lot 76 (C8) : n° de reprise. */
function traceFailure(report: ProducerReport, accountId: number, targetType: string, targetId: number, ruleCode: string, echec: TraceFailure | null): void {
  if (!echec) return;
  (report.errorDetails ??= []).push({ accountId, fileId: null, ruleCode, step: 'TRACE', kind: 'TRACE_FAILED', cause: echec.cause.slice(0, 300), targetType, targetId, retryId: echec.retryId });
}

/** Options d'un passage de producteur (lot 72) : déclencheur et référence tracés. */
export interface ProducerRunOptions { trigger?: DecisionTrigger; runRef?: string | null; only?: readonly number[] | null }

/** Faits d'un événement d'agenda sans date, pour l'admissibilité (lot 72, C4). */
export interface AgendaDateFacts {
  homeCategory: string | null;
  originType: string;
  isAutomatic: boolean;
  isAutomaticModified: boolean;
  requiresQualification: boolean;
  createdAt: Date | string | null;
  /** Date retrouvée à la source de l'événement (valeur retenue du document d'origine), ISO. */
  sourceDate: string | null;
  /**
   * Lot 77A : l'utilisateur a déclaré la tâche « Sans échéance » (option
   * explicite de l'événement, jamais posée par un traitement).
   */
  noDeadline?: boolean;
  /**
   * Lot 83A (CDC v5 §11.5, §13.6, §16) : l'élément est le PRINCIPAL d'une
   * Opération active — l'événement global : sa date est nécessaire (Timeline
   * regroupée, dossier Assurance/Sinistre), même s'il est informatif.
   */
  operationPrincipal?: boolean;
}

/** Lot 83A : justification (tracée) du besoin de date d'un événement principal. */
export const OPERATION_PRINCIPAL_DATE_REASON = 'OPERATION_PRINCIPAL_DATE';

/** Délai laissé à la qualification T4 d'un événement avant toute question (jours). */
export const AGENDA_QUALIFICATION_GRACE_DAYS = 7;

/** Origines d'un événement SAISI par l'utilisateur (jamais produit par un traitement). */
const ORIGINES_UTILISATEUR = ['manual', 'legacy_event_migration'];

/**
 * Admissibilité d'une question « date » sur un événement d'agenda (pure) —
 * lot 76 (C5) : chaque critère nécessaire est JUSTIFIÉ positivement, jamais
 * présumé :
 *   · événement INFORMATIF (« à savoir », tâche sans échéance obligatoire) :
 *     aucune date à réclamer ;
 *   · événement qualifié « action » (prochaines dates) : la date est
 *     nécessaire (EVENT_REQUIRES_DATE) ;
 *   · événement SAISI par l'utilisateur, sans catégorie : décision PO du
 *     lot 72C — sa question reste (USER_CREATED_EVENT_PO_72C) ;
 *   · événement produit par un traitement, SANS catégorie : nécessité
 *     inconnue — différé (CATEGORY_UNKNOWN), jamais une carte présumée (une
 *     carte existante n'est pas fermée sur ce « pas encore ») ;
 *   · date retrouvée à la source d'un événement automatique jamais modifié :
 *     résolue automatiquement (écrite, vérifiée) ;
 *   · qualification T4 en cours (récente) : pas maintenant ;
 *   · lot 77A — tâche déclarée « Sans échéance » par l'utilisateur : la date
 *     est JUSTIFIÉE non nécessaire (NO_DEADLINE_BY_USER) — prime sur la
 *     catégorie et sur la décision 72C ; aucune date n'est écrite depuis la
 *     source (choix de l'utilisateur respecté) ;
 *   · lot 83A — événement PRINCIPAL d'une Opération active (événement global,
 *     CDC v5 §11.5) : la date est nécessaire (OPERATION_PRINCIPAL_DATE), même
 *     pour un événement informatif ; « Sans échéance » prime toujours.
 * La décision « Non applicable » de l'utilisateur est protégée à l'écriture
 * (empreinte de `upsertAction`) : critère sans objet ici.
 */
export function agendaDateAdmissibility(f: AgendaDateFacts, now: Date = new Date()): AdmissibilityDecision {
  const recent = f.createdAt ? now.getTime() - new Date(f.createdAt).getTime() < AGENDA_QUALIFICATION_GRACE_DAYS * 86_400_000 : false;
  const ecrivable = !!f.sourceDate && f.isAutomatic && !f.isAutomaticModified;
  const saisiParUtilisateur = !f.isAutomatic && ORIGINES_UTILISATEUR.includes(f.originType);
  const sansEcheance = f.noDeadline === true;
  const necessaire = sansEcheance ? false : f.operationPrincipal ? true
    : f.homeCategory === 'information' ? false : f.homeCategory === 'action' ? true : saisiParUtilisateur ? true : null;
  return decideAdmissibility({
    ruleCode: 'DATA-AGENDA-DATE',
    checks: {
      // Fait établi par la sélection : événement ouvert (ni réalisé, ni annulé) sans date.
      realProblem: true,
      neededForUse: necessaire,
      autoResolvable: ecrivable,
      userActionNeeded: true,
      timely: !(f.requiresQualification && recent),
      userDecided: null,
    },
    notApplicable: ['userDecided'],
    motives: {
      neededForUse: sansEcheance ? NO_DEADLINE_REASON : f.homeCategory === 'information' ? 'INFORMATIONAL_EVENT' : 'CATEGORY_UNKNOWN',
      autoResolvable: 'DATE_FOUND_AT_SOURCE',
      timely: 'QUALIFICATION_PENDING',
    },
    justifications: {
      realProblem: 'OPEN_EVENT_WITHOUT_DATE',
      neededForUse: f.operationPrincipal ? OPERATION_PRINCIPAL_DATE_REASON
        : f.homeCategory === 'action' ? 'EVENT_REQUIRES_DATE' : saisiParUtilisateur ? 'USER_CREATED_EVENT_PO_72C' : undefined,
      autoResolvable: 'NO_DATE_AT_SOURCE',
      userActionNeeded: 'USER_CAN_DATE_EVENT',
      timely: f.requiresQualification ? 'QUALIFICATION_GRACE_ELAPSED' : 'NO_QUALIFICATION_PENDING',
    },
  });
}

/** Lot 77A : motif (tracé) de la fermeture d'une carte de date d'une tâche « Sans échéance ». */
export const NO_DEADLINE_REASON = 'NO_DEADLINE_BY_USER';

/**
 * Lot 77A — option « Sans échéance » RETIRÉE : la carte de date fermée pour
 * ce motif (dernière carte résolue de l'élément, fermée OBSOLETE avec le
 * motif NO_DEADLINE_BY_USER comme dernier événement) est ROUVERTE — même
 * ligne, même cycle (l'utilisateur s'est ravisé : ce n'est pas un problème
 * inédit, voir `reopenAction`). Réouverture et événement d'audit dans une
 * transaction. Rend l'identifiant rouvert, ou null (rien à rouvrir : la
 * production ordinaire crée la carte).
 */
async function reopenNoDeadlineCard(accountId: number, itemId: number): Promise<number | null> {
  const [last] = (await pgClient.unsafe(
    `SELECT a.id, a.resolution_reason,
            (SELECT e.details->>'reason' FROM to_process_action_events e WHERE e.action_id = a.id ORDER BY e.id DESC LIMIT 1) AS last_reason
       FROM to_process_actions a
      WHERE a.account_id = $1 AND a.target_type = 'AGENDA_ITEM' AND a.target_id = $2
        AND COALESCE(a.field_key, a.relation_key) = 'date' AND a.resolved_at IS NOT NULL
      ORDER BY a.resolved_at DESC, a.id DESC LIMIT 1`,
    [accountId, itemId] as never[],
  )) as unknown as Array<{ id: number; resolution_reason: string | null; last_reason: string | null }>;
  if (!last || last.resolution_reason !== 'OBSOLETE' || last.last_reason !== NO_DEADLINE_REASON) return null;
  try {
    return await db.transaction(async (tx) => {
      const now = new Date();
      const rouverte = await tx.update(toProcessActions)
        .set({ resolvedAt: null, resolutionReason: null, lastSeenAt: now, updatedAt: now })
        .where(and(eq(toProcessActions.id, Number(last.id)), eq(toProcessActions.accountId, accountId), sql`${toProcessActions.resolvedAt} IS NOT NULL`))
        .returning({ id: toProcessActions.id, ruleCode: toProcessActions.ruleCode });
      if (!rouverte.length) return null;
      await tx.insert(toProcessActionEvents).values({
        actionId: rouverte[0].id, accountId, event: 'REOPENED', actorUserId: null, targetType: 'AGENDA_ITEM', targetId: itemId, fieldKey: 'date',
        details: { ruleCode: rouverte[0].ruleCode, reason: 'NO_DEADLINE_CLEARED' }, createdAt: now,
      });
      return rouverte[0].id;
    });
  } catch (e) {
    // Carte active déjà présente (index unique 0147) : rien à rouvrir, la production ordinaire la met à jour.
    if ((e as { code?: string }).code === '23505' || (e as { cause?: { code?: string } }).cause?.code === '23505') return null;
    throw e;
  }
}

/** Clés de donnée documentaire candidates pour la date d'un événement (clé d'origine et sa clé canonique). */
async function sourceDatesOf(accountId: number, items: Array<{ id: number; originRefType: string | null; originRefId: number | null; originFieldKey: string | null }>): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const cibles = items.filter((i) => i.originRefType === 'asset_file' && i.originRefId && i.originFieldKey);
  if (cibles.length === 0) return out;
  const { documentBridgeFieldKey, parseDocumentDate } = await import('./document-field-evidence');
  const rows = (await pgClient.unsafe(
    `SELECT v.file_id, v.field_key, v.value_text FROM document_field_values v
       JOIN asset_files f ON f.id = v.file_id AND f.account_id = v.account_id AND f.deleted_at IS NULL
      WHERE v.account_id = $1 AND v.file_id = ANY($2::int[]) AND v.value_text IS NOT NULL`,
    [accountId, [...new Set(cibles.map((c) => c.originRefId!))]] as never[],
  )) as unknown as Array<{ file_id: number; field_key: string; value_text: string }>;
  for (const c of cibles) {
    const cles = new Set([c.originFieldKey!, documentBridgeFieldKey(c.originFieldKey!) ?? c.originFieldKey!]);
    const v = rows.find((r) => Number(r.file_id) === c.originRefId && cles.has(r.field_key));
    const iso = v ? parseDocumentDate(v.value_text) : null;
    if (iso?.iso && (iso.status === 'ISO' || iso.status === 'NORMALIZED')) out.set(c.id, iso.iso);
  }
  return out;
}

/**
 * Lot 83A (CDC v5 §11.5, §11.8) — éléments sans date qui sont le PRINCIPAL
 * d'une Opération active, et dates de réalisation CONTRADICTOIRES que T3 a
 * tracées pour cette Opération (provenance 78A, contradictions ouvertes ;
 * ≥ 2 dates valides). Lecture seule.
 */
async function principalDateContexts(accountId: number, itemIds: number[]): Promise<Map<number, { contested: string[] }>> {
  const out = new Map<number, { contested: string[] }>();
  if (!itemIds.length) return out;
  const rows = (await pgClient.unsafe(
    `SELECT i.id,
            COALESCE((SELECT array_agg(DISTINCT v->>'value' ORDER BY v->>'value') FROM jsonb_array_elements(
                        CASE WHEN jsonb_typeof(to_jsonb(o)->'attribute_provenance'->'conflicts') = 'array' THEN to_jsonb(o)->'attribute_provenance'->'conflicts' ELSE '[]'::jsonb END) c,
                      jsonb_array_elements(CASE WHEN jsonb_typeof(c->'values') = 'array' THEN c->'values' ELSE '[]'::jsonb END) v
                      WHERE c->>'field' = 'realizedDate' AND v->>'value' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'), '{}') AS contested
       FROM agenda_items i
       JOIN business_operations o ON o.id = i.business_operation_id AND o.account_id = i.account_id
            AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
      WHERE i.account_id = $1 AND i.id = ANY($2::int[]) AND i.operation_role = 'PRINCIPAL'`,
    [accountId, itemIds] as never[],
  )) as unknown as Array<{ id: number; contested: string[] | null }>;
  for (const r of rows) out.set(Number(r.id), { contested: (r.contested ?? []).map(String) });
  return out;
}

/** Libellé d'une date proposée (JJ/MM/AAAA). */
const dateLabel = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/**
 * Événements d'agenda sans date — règle DATA-AGENDA-DATE.
 *
 * Les événements marqués « réalisé » ou « annulé » sont écartés : réclamer la
 * date d'un événement clos est du bruit, et c'est exactement le genre de carte
 * qui décourage de consulter la page.
 *
 * Lot 72 (C4) : plus « date absente → carte ». Chaque événement passe le
 * contrôle d'admissibilité commun (`agendaDateAdmissibility`) ; une date
 * retrouvée à la source est écrite (événement automatique jamais modifié,
 * écriture conditionnelle relue) ; chaque décision est tracée, même sans carte.
 */
export async function produceAgendaActions(accountId: number, opts: ProducerRunOptions = {}): Promise<ProducerReport> {
  const sansDate = (await db
    .select({
      id: agendaItems.id, title: agendaItems.title, homeCategory: agendaItems.homeCategory, originType: agendaItems.originType,
      originRefType: agendaItems.originRefType, originRefId: agendaItems.originRefId, originFieldKey: agendaItems.originFieldKey,
      isAutomatic: agendaItems.isAutomatic, isAutomaticModified: agendaItems.isAutomaticModified,
      requiresQualification: agendaItems.requiresQualification, createdAt: agendaItems.createdAt,
      noDeadline: agendaItems.noDeadline,
    })
    .from(agendaItems)
    .where(
      and(
        eq(agendaItems.accountId, accountId),
        isNull(agendaItems.startDate),
        isNull(agendaItems.manualStatus),
      ),
    )).filter((i) => !opts.only || opts.only.includes(i.id));

  const report: ProducerReport = { ...EMPTY, errorDetails: [] };
  const trigger = opts.trigger ?? 'SWEEP';
  const actives = await activeTargets(accountId, 'AGENDA_ITEM', 'date');
  const sources = await sourceDatesOf(accountId, sansDate);
  // Lot 83A : principal d'une Opération (événement global) et dates contradictoires de T3.
  const principaux = await principalDateContexts(accountId, sansDate.map((i) => i.id));

  for (const item of sansDate) {
    const principal = principaux.get(item.id);
    const decision = agendaDateAdmissibility({ ...item, sourceDate: sources.get(item.id) ?? null, operationPrincipal: !!principal });
    const evidence = { homeCategory: item.homeCategory, originType: item.originType, automatic: item.isAutomatic, modifiedByUser: item.isAutomaticModified,
      requiresQualification: item.requiresQualification, sourceDate: sources.get(item.id) ?? null, sourceFileId: item.originRefType === 'asset_file' ? item.originRefId : null,
      noDeadline: item.noDeadline === true,
      ...(principal ? { operationPrincipal: true, contestedDates: principal.contested } : {}) };
    const trace = async (effect: FamilyDecisionRecord['effect'], actionIds: FamilyDecisionRecord['actionIds'] = null, d = decision, error: string | null = null) =>
      traceFailure(report, accountId, 'AGENDA_ITEM', item.id, 'DATA-AGENDA-DATE', await recordFamilyDecision({ accountId, targetType: 'AGENDA_ITEM', targetId: item.id, ruleCode: 'DATA-AGENDA-DATE', dataKey: 'date', trigger,
        runRef: opts.runRef, decision: d, evidence, effect, actionIds, error }));
    if (decision.outcome === 'AUTO_RESOLVED') {
      const date = sources.get(item.id)!;
      // Écriture conditionnelle (toujours sans date, jamais modifié par l'utilisateur), relue.
      const ecrit = (await pgClient.unsafe(
        `UPDATE agenda_items SET start_date = $3::date, date_source = COALESCE(date_source, 'EXPLICIT_DATE'), updated_at = now()
          WHERE id = $1 AND account_id = $2 AND start_date IS NULL AND manual_status IS NULL AND is_automatic = true AND is_automatic_modified = false
            AND no_deadline = false
          RETURNING to_char(start_date, 'YYYY-MM-DD') AS d`,
        [item.id, accountId, date] as never[],
      )) as unknown as Array<{ d: string }>;
      if (ecrit[0]?.d === date) {
        const fermees = await closeObsoleteTraced(accountId, 'AGENDA_ITEM', 'date', [item.id], { reason: 'AUTO_RESOLVED', source: 'DATE_FOUND_AT_SOURCE' });
        report.closed += fermees.length;
        await trace('WRITTEN', { closed: fermees });
        continue;
      }
      // Non confirmée : la question reste possible (jamais une fausse résolution).
      // Lot 75I (B) : l'échec d'écriture remonte au bilan (statut « partial »).
      report.errorDetails!.push({ accountId, fileId: null, ruleCode: 'DATA-AGENDA-DATE', step: 'VERIFY', kind: 'PERSISTENCE_FAILED',
        cause: 'écriture de la date retrouvée non confirmée', targetType: 'AGENDA_ITEM', targetId: item.id });
      const repli = decideAdmissibility({ ruleCode: 'DATA-AGENDA-DATE', checks: { ...decision.checks, autoResolvable: false } });
      const r = await upsertAction({ accountId, targetType: 'AGENDA_ITEM', targetId: item.id, fieldKey: 'date', actionKind: 'COMPLETE',
        ruleCode: 'DATA-AGENDA-DATE', question: `À quelle date « ${item.title} » a-t-il lieu ?` });
      if (r.status === 'CREATED') report.created += 1; else if (r.status === 'UPDATED') report.updated += 1;
      await trace(r.status === 'CREATED' ? 'CREATED' : r.status === 'UPDATED' ? 'KEPT' : 'NONE', r.actionId ? { [r.status === 'CREATED' ? 'created' : 'kept']: [r.actionId] } : null, repli,
        'écriture de la date retrouvée non confirmée');
      continue;
    }
    if (decision.outcome === 'DEFER' && actives.has(item.id)) {
      // Une carte déjà ouverte n'est pas retirée pendant une qualification (aucune fermeture sur un « pas maintenant »).
      await trace('KEPT', { kept: [actives.get(item.id)!] });
      continue;
    }
    if (decision.outcome !== 'CREATE_ACTION') {
      const fermees = actives.has(item.id)
        ? await closeObsoleteTraced(accountId, 'AGENDA_ITEM', 'date', [item.id], { reason: decision.reason, outcome: decision.outcome }) : [];
      report.closed += fermees.length;
      await trace(fermees.length ? 'CLOSED' : 'NONE', fermees.length ? { closed: fermees } : null);
      continue;
    }
    // Lot 77A : « Sans échéance » retirée — la carte fermée pour ce motif est rouverte (même carte).
    const rouverte = actives.has(item.id) ? null : await reopenNoDeadlineCard(accountId, item.id);
    // Lot 83A (CDC v5 §11.8, AC20) : dates contradictoires établies par T3 pour l'événement principal —
    // la MÊME carte devient un arbitrage entre ces dates (jamais une date choisie à la place de l'utilisateur).
    const arbitrage = principal && principal.contested.length >= 2
      ? await upsertAction({
        accountId, targetType: 'AGENDA_ITEM', targetId: item.id, fieldKey: 'date', actionKind: 'ARBITRATE', ruleCode: 'DATA-AGENDA-DATE',
        question: `Les documents donnent plusieurs dates pour « ${item.title} » : laquelle est la bonne ?`,
        proposals: principal.contested.map((d) => ({ value: d, label: dateLabel(d), confidence: 0.5 })),
      })
      : null;
    const result = arbitrage && arbitrage.status !== 'SKIPPED' ? arbitrage : await upsertAction({
      accountId,
      targetType: 'AGENDA_ITEM',
      targetId: item.id,
      fieldKey: 'date',
      actionKind: 'COMPLETE',
      ruleCode: 'DATA-AGENDA-DATE',
      question: `À quelle date « ${item.title} » a-t-il lieu ?`,
    });
    if (result.status === 'CREATED' || (rouverte && result.actionId === rouverte)) report.created += 1;
    else if (result.status === 'UPDATED') report.updated += 1;
    const nouvelle = result.status === 'CREATED' || (rouverte !== null && result.actionId === rouverte);
    await trace(nouvelle ? 'CREATED' : result.status === 'UPDATED' ? 'KEPT' : 'NONE',
      result.actionId ? { [nouvelle ? 'created' : 'kept']: [result.actionId] } : null);
  }

  // Cartes dont l'événement a désormais une date, est clos ou a disparu : le problème n'existe plus.
  const traites = new Set(sansDate.map((i) => i.id));
  const aFermer = [...actives.keys()].filter((id) => !traites.has(id) && (!opts.only || opts.only.includes(id)));
  report.closed += (await closeObsoleteTraced(accountId, 'AGENDA_ITEM', 'date', aFermer, { reason: 'DATA_PRESENT_OR_EVENT_CLOSED' })).length;

  return report;
}

/** Faits d'un équipement rattaché à un bien supprimé (lot 72, C4). */
export interface EquipmentLinkFacts {
  status: string | null;
  archivedAt: Date | string | null;
  /** Bien VIVANT déjà connu par la pièce de l'équipement (autre que le bien supprimé). */
  knownAssetId: number | null;
  /** Biens vivants du compte (une réponse est-elle possible ?). */
  liveAssets: number;
}

/**
 * Admissibilité « à quel bien appartient cet équipement ? » (pure) :
 *   · équipement archivé, transmis ou hors service : aucun problème réel ;
 *   · bien déjà connu (pièce rattachée à un bien vivant) : résolu sans question ;
 *   · aucun bien vivant dans le compte : aucune réponse possible maintenant.
 */
export function equipmentLinkAdmissibility(f: EquipmentLinkFacts): AdmissibilityDecision {
  const inactif = !!f.archivedAt || (f.status !== null && ['ARCHIVED', 'TRANSMIS', 'HORS_SERVICE'].includes(f.status));
  return decideAdmissibility({
    ruleCode: 'LINK-EQUIP-ASSET',
    checks: { realProblem: !inactif, neededForUse: true, autoResolvable: f.knownAssetId !== null, userActionNeeded: true, timely: f.liveAssets > 0, userDecided: null },
    // Lot 76 (C5) : « Non applicable » protégé à l'écriture (empreinte de la carte).
    notApplicable: ['userDecided'],
    motives: { realProblem: 'EQUIPMENT_INACTIVE', autoResolvable: 'ASSET_KNOWN_FROM_ROOM', timely: 'NO_LIVE_ASSET_TO_ATTACH' },
    justifications: { realProblem: 'ACTIVE_EQUIPMENT_ON_DELETED_ASSET', neededForUse: 'EQUIPMENT_INVISIBLE_WITHOUT_ASSET', autoResolvable: 'NO_ASSET_KNOWN_FROM_ROOM',
      userActionNeeded: 'USER_CAN_ATTACH', timely: 'LIVE_ASSET_AVAILABLE' },
  });
}

/**
 * Équipements rattachés à un bien supprimé — règle LINK-EQUIP-ASSET.
 *
 * `equipments.asset_id` est NOT NULL et porte un `ON DELETE CASCADE` : un
 * équipement sans bien du tout ne peut pas exister. Le seul orphelin possible
 * est celui dont le bien a été supprimé en douceur — la ligne demeure, avec
 * `deleted_at` renseigné, et l'équipement reste accroché à un bien que
 * l'utilisateur ne voit plus nulle part.
 *
 * Le compte vient du bien : la table `equipments` n'en porte pas.
 *
 * Lot 72 (C4) : contrôle d'admissibilité commun — ni question sur un
 * équipement inactif, ni question dont la réponse est déjà connue (pièce
 * rattachée à un bien vivant : rattachement écrit et relu), ni question
 * impossible (aucun bien vivant) ; chaque décision est tracée.
 */
export async function produceEquipmentActions(accountId: number, opts: ProducerRunOptions = {}): Promise<ProducerReport> {
  const orphelins = (await pgClient.unsafe(
    `SELECT e.id, e.name, e.status, e.archived_at AS "archivedAt", e.asset_id AS "deletedAssetId",
            (SELECT s.asset_id FROM substructures s JOIN assets a2 ON a2.id = s.asset_id AND a2.account_id = $1 AND a2.deleted_at IS NULL
              WHERE s.id = e.substructure_id AND s.asset_id <> e.asset_id) AS "knownAssetId",
            (SELECT count(*)::int FROM assets a3 WHERE a3.account_id = $1 AND a3.deleted_at IS NULL) AS "liveAssets"
       FROM equipments e JOIN assets a ON a.id = e.asset_id
      WHERE a.account_id = $1 AND a.deleted_at IS NOT NULL`,
    [accountId] as never[],
  )) as unknown as Array<{ id: number; name: string; status: string | null; archivedAt: string | null; deletedAssetId: number; knownAssetId: number | null; liveAssets: number }>;
  const cibles = orphelins.filter((e) => !opts.only || opts.only.includes(Number(e.id)));

  const report: ProducerReport = { ...EMPTY, errorDetails: [] };
  const trigger = opts.trigger ?? 'SWEEP';
  const actives = await activeTargets(accountId, 'EQUIPMENT', 'assetId');

  for (const equip of cibles) {
    const id = Number(equip.id);
    const decision = equipmentLinkAdmissibility({ status: equip.status, archivedAt: equip.archivedAt, knownAssetId: equip.knownAssetId === null ? null : Number(equip.knownAssetId), liveAssets: Number(equip.liveAssets) });
    const evidence = { status: equip.status, archived: !!equip.archivedAt, deletedAssetId: Number(equip.deletedAssetId), knownAssetId: equip.knownAssetId, liveAssets: Number(equip.liveAssets) };
    const trace = async (effect: FamilyDecisionRecord['effect'], actionIds: FamilyDecisionRecord['actionIds'] = null, d = decision, error: string | null = null) =>
      traceFailure(report, accountId, 'EQUIPMENT', id, 'LINK-EQUIP-ASSET',
        await recordFamilyDecision({ accountId, targetType: 'EQUIPMENT', targetId: id, ruleCode: 'LINK-EQUIP-ASSET', dataKey: 'assetId', trigger, runRef: opts.runRef, decision: d, evidence, effect, actionIds, error }));
    if (decision.outcome === 'AUTO_RESOLVED') {
      // Rattachement au bien de la pièce, conditionnel (toujours orphelin), relu, isolé par compte.
      const ecrit = (await pgClient.unsafe(
        `UPDATE equipments e SET asset_id = $3, updated_at = now()
          WHERE e.id = $1 AND e.asset_id = $4
            AND EXISTS (SELECT 1 FROM assets a WHERE a.id = $3 AND a.account_id = $2 AND a.deleted_at IS NULL)
            AND EXISTS (SELECT 1 FROM assets o WHERE o.id = $4 AND o.account_id = $2 AND o.deleted_at IS NOT NULL)
          RETURNING e.asset_id`,
        [id, accountId, Number(equip.knownAssetId), Number(equip.deletedAssetId)] as never[],
      )) as unknown as Array<{ asset_id: number }>;
      if (Number(ecrit[0]?.asset_id) === Number(equip.knownAssetId)) {
        const fermees = await closeObsoleteTraced(accountId, 'EQUIPMENT', 'assetId', [id], { reason: 'AUTO_RESOLVED', source: 'ASSET_KNOWN_FROM_ROOM' });
        report.closed += fermees.length;
        await trace('WRITTEN', { closed: fermees });
        continue;
      }
      await trace('ERROR', null, decision, 'rattachement au bien connu non confirmé');
      report.errorDetails!.push({ accountId, fileId: null, ruleCode: 'LINK-EQUIP-ASSET', step: 'VERIFY', kind: 'PERSISTENCE_FAILED',
        cause: 'rattachement au bien connu non confirmé', targetType: 'EQUIPMENT', targetId: id });
      continue;
    }
    if (decision.outcome === 'DEFER' && actives.has(id)) { await trace('KEPT', { kept: [actives.get(id)!] }); continue; }
    if (decision.outcome !== 'CREATE_ACTION') {
      const fermees = actives.has(id) ? await closeObsoleteTraced(accountId, 'EQUIPMENT', 'assetId', [id], { reason: decision.reason, outcome: decision.outcome }) : [];
      report.closed += fermees.length;
      await trace(fermees.length ? 'CLOSED' : 'NONE', fermees.length ? { closed: fermees } : null);
      continue;
    }
    const result = await upsertAction({
      accountId,
      targetType: 'EQUIPMENT',
      targetId: id,
      relationKey: 'assetId',
      actionKind: 'COMPLETE',
      ruleCode: 'LINK-EQUIP-ASSET',
      question: `À quel bien « ${equip.name} » appartient-il ?`,
    });
    if (result.status === 'CREATED') report.created += 1;
    else if (result.status === 'UPDATED') report.updated += 1;
    await trace(result.status === 'CREATED' ? 'CREATED' : result.status === 'UPDATED' ? 'KEPT' : 'NONE',
      result.actionId ? { [result.status === 'CREATED' ? 'created' : 'kept']: [result.actionId] } : null);
  }

  const vus = new Set(cibles.map((e) => Number(e.id)));
  const aFermer = [...actives.keys()].filter((id) => !vus.has(id) && (!opts.only || opts.only.includes(id)));
  report.closed += (await closeObsoleteTraced(accountId, 'EQUIPMENT', 'assetId', aFermer, { reason: 'ATTACHED_ELSEWHERE' })).length;

  return report;
}

const normFournisseur = (v: string | null | undefined) =>
  (v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Faits d'une revue fournisseur ouverte (lot 72, C4). */
export interface SupplierReviewFacts { detectedValue: string | null; currentValue: string | null }

/**
 * Admissibilité d'une confirmation de fournisseur (pure) : facultative, elle
 * n'est demandée qu'avec une PROPOSITION EXPLOITABLE — une valeur détectée,
 * distincte de la valeur actuelle. Valeur détectée identique : rien à
 * confirmer ; aucune valeur détectée : rien à proposer.
 */
export function supplierIdentityAdmissibility(f: SupplierReviewFacts): AdmissibilityDecision {
  const detecte = normFournisseur(f.detectedValue);
  const identique = !!detecte && detecte === normFournisseur(f.currentValue);
  return decideAdmissibility({
    ruleCode: 'SUPPLIER-IDENTITY',
    checks: { realProblem: !identique, neededForUse: null, autoResolvable: null, userActionNeeded: !!detecte, timely: true, userDecided: null },
    // Lot 76 (C5) : critères sans incidence pour une confirmation facultative (déclarés).
    notApplicable: ['neededForUse', 'autoResolvable', 'userDecided'],
    motives: { realProblem: 'SAME_VALUE_AS_CURRENT', userActionNeeded: 'NO_EXPLOITABLE_PROPOSAL' },
    justifications: { realProblem: 'DETECTED_VALUE_DIFFERS', userActionNeeded: 'EXPLOITABLE_PROPOSAL', timely: 'OPEN_REVIEW' },
  });
}

/**
 * Fournisseurs à confirmer — règle SUPPLIER-IDENTITY.
 *
 * Une revue ouverte devient un arbitrage dès qu'elle porte des candidats, et
 * rien du tout sinon : sans proposition, la carte serait une question à
 * laquelle l'utilisateur ne pourrait pas répondre depuis la file (ATP-05).
 *
 * Lot 72 (C4) : contrôle d'admissibilité commun — jamais de confirmation
 * facultative sans proposition exploitable ; chaque décision est tracée.
 */
export async function produceSupplierActions(accountId: number, opts: ProducerRunOptions = {}): Promise<ProducerReport> {
  const revues = (await db
    .select({
      id: supplierReviewItems.id,
      supplierId: supplierReviewItems.supplierId,
      detectedName: supplierReviewItems.detectedName,
      currentValue: supplierReviewItems.currentValue,
      detectedValue: supplierReviewItems.detectedValue,
      candidateIds: supplierReviewItems.candidateSupplierIds,
    })
    .from(supplierReviewItems)
    .where(
      and(
        eq(supplierReviewItems.accountId, accountId),
        eq(supplierReviewItems.status, 'open'),
      ),
    )).filter((r) => !opts.only || opts.only.includes(r.supplierId ?? r.id));

  const report: ProducerReport = { ...EMPTY, errorDetails: [] };
  const traites: number[] = [];
  const trigger = opts.trigger ?? 'SWEEP';
  const actives = await activeTargets(accountId, 'SUPPLIER', 'identity');

  for (const revue of revues) {
    const cible = revue.supplierId ?? revue.id;
    const decision = supplierIdentityAdmissibility(revue);
    const evidence = { reviewId: revue.id, supplierId: revue.supplierId, hasDetected: !!revue.detectedValue, hasCurrent: !!revue.currentValue,
      candidates: Array.isArray(revue.candidateIds) ? (revue.candidateIds as unknown[]).length : 0 };
    const trace = async (effect: FamilyDecisionRecord['effect'], actionIds: FamilyDecisionRecord['actionIds'] = null) =>
      traceFailure(report, accountId, 'SUPPLIER', cible, 'SUPPLIER-IDENTITY',
        await recordFamilyDecision({ accountId, targetType: 'SUPPLIER', targetId: cible, ruleCode: 'SUPPLIER-IDENTITY', dataKey: 'identity', trigger, runRef: opts.runRef, decision, evidence, effect, actionIds }));
    if (decision.outcome !== 'CREATE_ACTION') {
      const fermees = actives.has(cible) ? await closeObsoleteTraced(accountId, 'SUPPLIER', 'identity', [cible], { reason: decision.reason, outcome: decision.outcome }) : [];
      report.closed += fermees.length;
      traites.push(cible);
      await trace(fermees.length ? 'CLOSED' : 'NONE', fermees.length ? { closed: fermees } : null);
      continue;
    }
    const proposals: ActionProposal[] = [];

    if (revue.detectedValue) {
      proposals.push({
        value: revue.detectedValue,
        label: revue.detectedValue,
        // Une valeur relevée sur un document n'a pas de score comparable au
        // seuil du §11.2 : 0 la maintient à l'arbitrage, jamais à l'écriture.
        confidence: 0,
      });
    }
    if (revue.currentValue) {
      proposals.push({
        value: revue.currentValue,
        label: revue.currentValue,
        confidence: 1,
        isCurrentValue: true,
      });
    }

    const result = await upsertAction({
      accountId,
      targetType: 'SUPPLIER',
      targetId: cible,
      fieldKey: 'identity',
      actionKind: 'ARBITRATE',
      ruleCode: 'SUPPLIER-IDENTITY',
      proposals,
      question: revue.detectedName
        ? `« ${revue.detectedName} » est-il un fournisseur déjà connu ?`
        : 'S’agit-il du même fournisseur ?',
    });

    // `SKIPPED` = arbitrage sans candidat affichable. L'action n'existe pas,
    // et l'identifiant ne doit donc pas figurer parmi ceux à conserver.
    if (result.status === 'CREATED') {
      report.created += 1;
      traites.push(cible);
    } else if (result.status === 'UPDATED') {
      report.updated += 1;
      traites.push(cible);
    }
    await trace(result.status === 'CREATED' ? 'CREATED' : result.status === 'UPDATED' ? 'KEPT' : 'NONE',
      result.actionId ? { [result.status === 'CREATED' ? 'created' : 'kept']: [result.actionId] } : null);
  }

  const aFermer = [...actives.keys()].filter((id) => !traites.includes(id) && (!opts.only || opts.only.includes(id)));
  report.closed += (await closeObsoleteTraced(accountId, 'SUPPLIER', 'identity', aFermer, { reason: 'NOT_RELEVANT_ANYMORE' })).length;

  return report;
}

/** Cartes actives d'une donnée, par cible (identifiant de la carte). */
async function activeTargets(accountId: number, targetType: 'AGENDA_ITEM' | 'EQUIPMENT' | 'SUPPLIER', dataKey: string): Promise<Map<number, number>> {
  const rows = await db
    .select({ id: toProcessActions.id, targetId: toProcessActions.targetId })
    .from(toProcessActions)
    .where(and(
      eq(toProcessActions.accountId, accountId), eq(toProcessActions.targetType, targetType),
      sql`COALESCE(${toProcessActions.fieldKey}, ${toProcessActions.relationKey}) = ${dataKey}`, isNull(toProcessActions.resolvedAt),
    ));
  return new Map(rows.map((r) => [r.targetId, r.id]));
}

/**
 * Ferme (OBSOLETE) les cartes actives d'une donnée pour les cibles données et
 * TRACE chaque fermeture (`to_process_action_events`, motif) — lot 72 (C7).
 * Rend les identifiants fermés.
 */
async function closeObsoleteTraced(
  accountId: number, targetType: 'AGENDA_ITEM' | 'EQUIPMENT' | 'SUPPLIER', dataKey: string, targetIds: number[], details: Record<string, unknown>,
): Promise<number[]> {
  if (targetIds.length === 0) return [];
  const now = new Date();
  // Lot 75I (E) : fermeture et événement d'audit dans UNE transaction — jamais l'un sans l'autre.
  return db.transaction(async (tx) => {
    const closed = await tx.update(toProcessActions)
      .set({ resolvedAt: now, resolutionReason: 'OBSOLETE', updatedAt: now })
      .where(and(
        eq(toProcessActions.accountId, accountId), eq(toProcessActions.targetType, targetType), inArray(toProcessActions.targetId, targetIds),
        sql`COALESCE(${toProcessActions.fieldKey}, ${toProcessActions.relationKey}) = ${dataKey}`, isNull(toProcessActions.resolvedAt),
      ))
      .returning({ id: toProcessActions.id, targetId: toProcessActions.targetId, ruleCode: toProcessActions.ruleCode });
    if (closed.length) {
      await tx.insert(toProcessActionEvents).values(closed.map((a) => ({
        actionId: a.id, accountId, event: 'OBSOLETE', actorUserId: null, targetType, targetId: a.targetId, fieldKey: dataKey,
        details: { ruleCode: a.ruleCode, ...details }, createdAt: now,
      })));
    }
    return closed.map((a) => a.id);
  });
}

/**
 * Documents — règles du pont générique (LINK-ASSET, DATA-*, lot 28).
 *
 * Réévalue, SANS analyse, les documents qui portent une action documentaire
 * active (fermeture si la donnée a été renseignée ailleurs) et ceux à qui
 * manque une donnée requise sans action ouverte (document sans bien, contrat
 * sans date de fin…). C'est aussi le rattrapage automatique des documents
 * déposés avant le lot 28 — borné par passage, repris au suivant.
 */
/**
 * Lot 61 (écart 5) : bilan documentaire d'un passage — réussites ET échecs
 * partiels. Chaque erreur d'une règle porte compte, document, règle, étape
 * et cause ; elle remonte au bilan du balayage (trace `to_process_scan_runs`,
 * BO › Tâches planifiées) et au diagnostic par règle (0418).
 */
export interface DocumentProducerReport extends ProducerReport {
  documents: number;
  /**
   * Règles en erreur (le document est repris au passage suivant ; aucune
   * fermeture). Lot 75I (B) : nature de l'erreur (`kind`) — écritures NON
   * CONFIRMÉES, persistance, lecture, IA, trace — comprises.
   */
  ruleErrors: Array<{ accountId: number; fileId: number; ruleCode: string; step: string; cause: string; kind?: string; retryId?: number | null }>;
  /** Issues centrales (AUTO_RESOLVED, NO_ACTION, DEFER, CREATE_ACTION, KEEP, ERROR). */
  outcomes: Record<string, number>;
  /** Lot 75I (B) : refus NORMAUX d'écriture (valeur de l'utilisateur protégée) — jamais une erreur. */
  protectedRefusals?: number;
}

export async function produceDocumentActions(accountId: number, limit = 200): Promise<DocumentProducerReport> {
  const { documentsToReevaluate, syncDocumentRulesFromState } = await import('./document-rule-bridge');
  const report: DocumentProducerReport = { ...EMPTY, documents: 0, ruleErrors: [], outcomes: {}, protectedRefusals: 0 };
  for (const fileId of await documentsToReevaluate(accountId, limit)) {
    const r = await syncDocumentRulesFromState(accountId, fileId, { reason: 'OBSOLETE', create: true });
    report.documents += 1;
    report.created += r.created;
    report.updated += r.updated;
    report.closed += r.closed;
    report.ruleErrors.push(...r.errorDetails);
    report.protectedRefusals! += r.protectedRefusals ?? 0;
    for (const o of Object.values(r.outcomes)) report.outcomes[o] = (report.outcomes[o] ?? 0) + 1;
  }
  return report;
}

export interface AccountProductionReport extends ProducerReport {
  /** Familles (ou règles documentaires, lot 61) en échec pour ce compte (le balayage continue). */
  errors: string[];
  /** Lot 61 : règles documentaires en erreur (détail), succès partiel du compte. */
  documentRuleErrors?: DocumentProducerReport['ruleErrors'];
  /** Lot 75I (B) : familles en échec / familles traitées (toutes en échec = aucun résultat exploitable). */
  familiesFailed?: number;
  familiesTotal?: number;
  /** Lot 75I (B) : documents réévalués, issues, refus normaux. */
  documents?: number;
  outcomes?: Record<string, number>;
  protectedRefusals?: number;
}

/** Libellé d'une erreur de règle documentaire (sans donnée personnelle). */
export const documentRuleErrorLabel = (e: DocumentProducerReport['ruleErrors'][number]) =>
  `documents : compte ${e.accountId} · document ${e.fileId} · règle ${e.ruleCode} · étape ${e.step}${e.kind ? ` (${e.kind})` : ''} — ${e.cause}`.slice(0, 300);

/** Familles balayées par compte (agenda, équipements, fournisseurs, documents, incohérences). */
const FAMILIES = 5;

/** Balaye les familles nées d'un état de la base, pour un compte. */
export async function produceAccountActions(accountId: number): Promise<AccountProductionReport> {
  const errors: string[] = [];
  const familles: ScanErrorDetail[] = [];
  const [agenda, equipements, fournisseurs, documents, incoherences] = await Promise.all([
    produceAgendaActions(accountId).catch(reportError('agenda', accountId, errors, familles)),
    produceEquipmentActions(accountId).catch(reportError('équipements', accountId, errors, familles)),
    produceSupplierActions(accountId).catch(reportError('fournisseurs', accountId, errors, familles)),
    produceDocumentActions(accountId).catch((e: Error): DocumentProducerReport => ({
      ...reportError('documents', accountId, errors, familles)(e), documents: 0, ruleErrors: [], outcomes: {},
    })),
    // Lot 32C : incohérences de rattachement devenues sans objet.
    import('./document-asset-conflict')
      .then(async ({ closeObsoleteAssetConflicts }) => ({ ...EMPTY, closed: await closeObsoleteAssetConflicts(accountId) }))
      .catch(reportError('incohérences de rattachement', accountId, errors, familles)),
  ]);
  const fusion = merge(agenda, equipements, fournisseurs, documents, incoherences);
  // Lot 61 (écart 5) : les erreurs des règles documentaires remontent au bilan.
  for (const e of documents.ruleErrors.slice(0, 20)) errors.push(documentRuleErrorLabel(e));
  if (documents.ruleErrors.length > 20) errors.push(`documents : ${documents.ruleErrors.length - 20} autre(s) règle(s) en erreur`);
  // Lot 75I (B) : erreurs non bloquantes des familles « état » (écriture non confirmée, trace).
  for (const e of fusion.errorDetails.slice(0, 20)) errors.push(`${e.targetType ?? 'cible'} ${e.targetId ?? '?'} · règle ${e.ruleCode} · étape ${e.step} (${e.kind}) — ${e.cause}`.slice(0, 300));
  const errorDetails: ScanErrorDetail[] = [
    ...familles,
    ...documents.ruleErrors.map((e) => ({ accountId: e.accountId, fileId: e.fileId, ruleCode: e.ruleCode, step: e.step, kind: e.kind ?? 'EVALUATION_FAILED', cause: e.cause,
      ...(e.retryId !== undefined ? { retryId: e.retryId } : {}) })),
    ...fusion.errorDetails,
  ];
  return {
    created: fusion.created, updated: fusion.updated, closed: fusion.closed, errors, documentRuleErrors: documents.ruleErrors, errorDetails,
    familiesFailed: familles.length, familiesTotal: FAMILIES,
    documents: documents.documents, outcomes: documents.outcomes, protectedRefusals: documents.protectedRefusals ?? 0,
  };
}

/**
 * Une famille en échec ne doit pas emporter les autres : le balayage est
 * rejoué périodiquement, et perdre un tour complet pour une requête fautive
 * coûterait plus que la famille manquée. L'échec est COMPTÉ (trace du
 * balayage, BO Exploitation), jamais silencieux.
 */
function reportError(famille: string, accountId: number, errors: string[], details?: ScanErrorDetail[]) {
  return (e: Error): ProducerReport => {
    errors.push(`${famille} : ${e.message}`.slice(0, 300));
    details?.push({ accountId, fileId: null, ruleCode: `famille:${famille}`, step: 'FAMILY', kind: 'FAMILY_FAILED', cause: String(e.message).slice(0, 300) });
    console.error(
      `[to-process] production ${famille} impossible pour le compte ${accountId} :`,
      e.message,
    );
    return { ...EMPTY };
  };
}

/**
 * Actions à fermer parce que leur cible a disparu (§7.3, TARGET_DELETED) :
 * échéance supprimée, document supprimé ou regroupé dans un autre, bien
 * supprimé ; lot 83E : équipement ou pièce supprimés (suppression physique).
 * Service unique de fermeture : balayage horaire `to-process-scan` et
 * contrôle de cohérence COH-TODO-ORPHAN-CARDS (même service, idempotent).
 */
export async function closeActionsForDeletedTargets(
  accountId: number,
): Promise<number> {
  const actions = await db
    .select({
      id: toProcessActions.id,
      targetType: toProcessActions.targetType,
      targetId: toProcessActions.targetId,
    })
    .from(toProcessActions)
    .where(
      and(
        eq(toProcessActions.accountId, accountId),
        inArray(toProcessActions.targetType, ['AGENDA_ITEM', 'DOCUMENT', 'ASSET', 'EQUIPMENT', 'ROOM']),
        isNull(toProcessActions.resolvedAt),
      ),
    );

  if (actions.length === 0) return 0;

  const ids = (type: string) => [...new Set(actions.filter((a) => a.targetType === type).map((a) => a.targetId))];
  const vivants = new Set<string>();

  const agendaIds = ids('AGENDA_ITEM');
  if (agendaIds.length) {
    for (const e of await db.select({ id: agendaItems.id }).from(agendaItems).where(inArray(agendaItems.id, agendaIds))) {
      vivants.add(`AGENDA_ITEM:${e.id}`);
    }
  }
  const docIds = ids('DOCUMENT');
  if (docIds.length) {
    const docs = await db
      .select({ id: assetFiles.id })
      .from(assetFiles)
      .where(and(
        inArray(assetFiles.id, docIds), eq(assetFiles.accountId, accountId),
        isNull(assetFiles.deletedAt), isNull(assetFiles.groupedIntoFileId),
      ));
    for (const d of docs) vivants.add(`DOCUMENT:${d.id}`);
  }
  const assetIds = ids('ASSET');
  if (assetIds.length) {
    const biens = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(inArray(assets.id, assetIds), eq(assets.accountId, accountId), isNull(assets.deletedAt)));
    for (const b of biens) vivants.add(`ASSET:${b.id}`);
  }

  // Lot 83E : équipements et pièces (suppression physique — aucune date de suppression).
  const equipementIds = ids('EQUIPMENT');
  if (equipementIds.length) {
    for (const e of await db.select({ id: equipments.id }).from(equipments).where(inArray(equipments.id, equipementIds))) {
      vivants.add(`EQUIPMENT:${e.id}`);
    }
  }
  const pieceIds = ids('ROOM');
  if (pieceIds.length) {
    for (const r of await db.select({ id: rooms.id }).from(rooms).where(and(inArray(rooms.id, pieceIds), eq(rooms.accountId, accountId)))) {
      vivants.add(`ROOM:${r.id}`);
    }
  }

  const disparus = actions.filter((a) => !vivants.has(`${a.targetType}:${a.targetId}`));
  if (disparus.length === 0) return 0;

  // Lot 75I (E) : suppression de cible TRACÉE (événement d'audit), dans la
  // même transaction que la fermeture — seules les cartes réellement fermées.
  const now = new Date();
  return db.transaction(async (tx) => {
    const fermees = await tx
      .update(toProcessActions)
      .set({ resolvedAt: now, resolutionReason: 'TARGET_DELETED', updatedAt: now })
      .where(and(inArray(toProcessActions.id, disparus.map((a) => a.id)), eq(toProcessActions.accountId, accountId), isNull(toProcessActions.resolvedAt)))
      .returning({ id: toProcessActions.id, targetType: toProcessActions.targetType, targetId: toProcessActions.targetId,
        key: sql<string | null>`COALESCE(${toProcessActions.fieldKey}, ${toProcessActions.relationKey})`, ruleCode: toProcessActions.ruleCode });
    if (fermees.length) {
      await tx.insert(toProcessActionEvents).values(fermees.map((a) => ({
        actionId: a.id, accountId, event: 'TARGET_DELETED', actorUserId: null, targetType: a.targetType, targetId: a.targetId, fieldKey: a.key,
        details: { ruleCode: a.ruleCode, reason: 'TARGET_DELETED', trigger: 'SWEEP' }, createdAt: now,
      })));
    }
    return fermees.length;
  });
}

/**
 * Cartes de donnée de BIEN sans objet pour leur bien (lot 32, L32-1) :
 * immatriculation demandée pour un vélo (catégorie changée depuis, ou carte
 * produite avant le correctif). Fermées OBSOLETE, tracées — le balayage
 * horaire rattrape tout changement de catégorie.
 */
export async function closeInapplicableAssetFieldActions(accountId: number): Promise<number> {
  const ouvertes = await db
    .select({
      id: toProcessActions.id, targetId: toProcessActions.targetId, fieldKey: toProcessActions.fieldKey,
      ruleCode: toProcessActions.ruleCode,
      category: assets.category, subtype: assets.subtype,
    })
    .from(toProcessActions)
    .innerJoin(assets, eq(assets.id, toProcessActions.targetId))
    .where(and(
      eq(toProcessActions.accountId, accountId), eq(toProcessActions.targetType, 'ASSET'),
      isNull(toProcessActions.resolvedAt), eq(assets.accountId, accountId),
    ));
  const { isFieldApplicableToAsset } = await import('@/services/canonical/registry');
  const sansObjet = ouvertes.filter((a) => a.fieldKey && !isFieldApplicableToAsset(a.fieldKey, a));
  if (sansObjet.length === 0) return 0;
  const now = new Date();
  // Lot 75I (E) : fermeture et événement dans UNE transaction ; seules les cartes réellement fermées sont tracées.
  return db.transaction(async (tx) => {
    const fermees = await tx.update(toProcessActions)
      .set({ resolvedAt: now, resolutionReason: 'OBSOLETE', updatedAt: now })
      .where(and(inArray(toProcessActions.id, sansObjet.map((a) => a.id)), eq(toProcessActions.accountId, accountId), isNull(toProcessActions.resolvedAt)))
      .returning({ id: toProcessActions.id });
    const ids = new Set(fermees.map((f) => f.id));
    const tracees = sansObjet.filter((a) => ids.has(a.id));
    if (tracees.length) {
      await tx.insert(toProcessActionEvents).values(tracees.map((a) => ({
        actionId: a.id, accountId, event: 'OBSOLETE', actorUserId: null,
        targetType: 'ASSET', targetId: a.targetId, fieldKey: a.fieldKey,
        details: { ruleCode: a.ruleCode, reason: 'FIELD_NOT_APPLICABLE' }, createdAt: now,
      })));
    }
    return tracees.length;
  });
}
