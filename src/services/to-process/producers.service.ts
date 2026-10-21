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
  supplierReviewItems,
  toProcessActionEvents,
  toProcessActions,
} from '@/db/schema';
import type { ActionProposal } from './action-model';
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

/** Erreur de trace d'une décision de famille (lot 75I, E) → détail d'erreur, jamais console seule. */
function traceFailure(report: ProducerReport, accountId: number, targetType: string, targetId: number, ruleCode: string, error: string | null): void {
  if (!error) return;
  (report.errorDetails ??= []).push({ accountId, fileId: null, ruleCode, step: 'TRACE', kind: 'TRACE_FAILED', cause: error.slice(0, 300), targetType, targetId });
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
}

/** Délai laissé à la qualification T4 d'un événement avant toute question (jours). */
export const AGENDA_QUALIFICATION_GRACE_DAYS = 7;

/**
 * Admissibilité d'une question « date » sur un événement d'agenda (pure) :
 *   · événement INFORMATIF (« à savoir ») : aucune date à réclamer ;
 *   · tâche sans échéance obligatoire : seulement si l'événement le DIT
 *     (catégorie « information ») — un événement saisi par l'utilisateur
 *     sans catégorie garde sa question (variante prudente : aucune donnée
 *     ne distingue aujourd'hui une tâche libre d'une échéance réelle —
 *     décision PO signalée) ;
 *   · date retrouvée à la source d'un événement automatique jamais modifié :
 *     résolue automatiquement (écrite, vérifiée) ;
 *   · qualification T4 en cours (récente) : pas maintenant ;
 *   · sinon l'événement nécessite une date que rien ne fournit : carte.
 */
export function agendaDateAdmissibility(f: AgendaDateFacts, now: Date = new Date()): AdmissibilityDecision {
  const recent = f.createdAt ? now.getTime() - new Date(f.createdAt).getTime() < AGENDA_QUALIFICATION_GRACE_DAYS * 86_400_000 : false;
  const ecrivable = !!f.sourceDate && f.isAutomatic && !f.isAutomaticModified;
  return decideAdmissibility({
    ruleCode: 'DATA-AGENDA-DATE',
    checks: {
      realProblem: true,
      neededForUse: f.homeCategory !== 'information',
      autoResolvable: ecrivable,
      userActionNeeded: true,
      timely: !(f.requiresQualification && recent),
      userDecided: null,
    },
    motives: {
      neededForUse: 'INFORMATIONAL_EVENT',
      autoResolvable: 'DATE_FOUND_AT_SOURCE',
      timely: 'QUALIFICATION_PENDING',
    },
  });
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

  for (const item of sansDate) {
    const decision = agendaDateAdmissibility({ ...item, sourceDate: sources.get(item.id) ?? null });
    const evidence = { homeCategory: item.homeCategory, originType: item.originType, automatic: item.isAutomatic, modifiedByUser: item.isAutomaticModified,
      requiresQualification: item.requiresQualification, sourceDate: sources.get(item.id) ?? null, sourceFileId: item.originRefType === 'asset_file' ? item.originRefId : null };
    const trace = async (effect: FamilyDecisionRecord['effect'], actionIds: FamilyDecisionRecord['actionIds'] = null, d = decision, error: string | null = null) =>
      traceFailure(report, accountId, 'AGENDA_ITEM', item.id, 'DATA-AGENDA-DATE', await recordFamilyDecision({ accountId, targetType: 'AGENDA_ITEM', targetId: item.id, ruleCode: 'DATA-AGENDA-DATE', dataKey: 'date', trigger,
        runRef: opts.runRef, decision: d, evidence, effect, actionIds, error }));
    if (decision.outcome === 'AUTO_RESOLVED') {
      const date = sources.get(item.id)!;
      // Écriture conditionnelle (toujours sans date, jamais modifié par l'utilisateur), relue.
      const ecrit = (await pgClient.unsafe(
        `UPDATE agenda_items SET start_date = $3::date, date_source = COALESCE(date_source, 'EXPLICIT_DATE'), updated_at = now()
          WHERE id = $1 AND account_id = $2 AND start_date IS NULL AND manual_status IS NULL AND is_automatic = true AND is_automatic_modified = false
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
    const result = await upsertAction({
      accountId,
      targetType: 'AGENDA_ITEM',
      targetId: item.id,
      fieldKey: 'date',
      actionKind: 'COMPLETE',
      ruleCode: 'DATA-AGENDA-DATE',
      question: `À quelle date « ${item.title} » a-t-il lieu ?`,
    });
    if (result.status === 'CREATED') report.created += 1;
    else if (result.status === 'UPDATED') report.updated += 1;
    await trace(result.status === 'CREATED' ? 'CREATED' : result.status === 'UPDATED' ? 'KEPT' : 'NONE',
      result.actionId ? { [result.status === 'CREATED' ? 'created' : 'kept']: [result.actionId] } : null);
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
    motives: { realProblem: 'EQUIPMENT_INACTIVE', autoResolvable: 'ASSET_KNOWN_FROM_ROOM', timely: 'NO_LIVE_ASSET_TO_ATTACH' },
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
    motives: { realProblem: 'SAME_VALUE_AS_CURRENT', userActionNeeded: 'NO_EXPLOITABLE_PROPOSAL' },
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
  ruleErrors: Array<{ accountId: number; fileId: number; ruleCode: string; step: string; cause: string; kind?: string }>;
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
    ...documents.ruleErrors.map((e) => ({ accountId: e.accountId, fileId: e.fileId, ruleCode: e.ruleCode, step: e.step, kind: e.kind ?? 'EVALUATION_FAILED', cause: e.cause })),
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
 * supprimé.
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
        inArray(toProcessActions.targetType, ['AGENDA_ITEM', 'DOCUMENT', 'ASSET']),
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
