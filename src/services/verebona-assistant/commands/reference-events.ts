/**
 * Commandes de l'Assistant sur les ÉVÉNEMENTS DE RÉFÉRENCE — lot 114X
 * (Trello #753, CDC T2 §14.3 W21 – W26, §14.4 « Opérations », X69 – X73).
 *
 *   W21  CREATE_REFERENCE_EVENT          créer sur DÉCLARATION de l'utilisateur ;
 *   W22  UPDATE_REFERENCE_EVENT          corriger date, prestataire, intitulé, type, situation ;
 *   W23  INVALIDATE_REFERENCE_EVENT      supprimer = INVALIDER (jamais un DELETE) ;
 *   W24  ASSOCIATE_REFERENCE_EVENTS      associer deux événements (jamais une fusion) ;
 *   W25  LINK_DOCUMENT_REFERENCE_EVENT   rattacher un document ;
 *   W26  LINK_SUPPLIER_REFERENCE_EVENT   relier un fournisseur.
 *
 * Même parcours que les autres commandes : plan figé, annonce avant écriture,
 * confirmation par identifiant de plan, état RELU avant d'écrire. AUCUNE
 * écriture propre : chaque exécuteur appelle la façade métier du graphe
 * (`operation-write.facade`, carte #744), acteur « utilisateur », canal
 * « Assistant », avec une clé d'idempotence (plan + action) et la version
 * présentée à l'aperçu. Chaque résultat de la façade est traduit en texte
 * (`translateWriteResult`) : jamais un code, jamais le mot « Opération ».
 *
 * Lecture : par le lecteur canonique des Opérations déjà utilisé par
 * l'Assistant (`operationReader().listForAssistant` : compte borné, événements
 * actifs seulement) et le lecteur du graphe (`readOperationGraph`).
 */
import { pgClient } from '@/db';
import { SITUATION_QUESTION } from '@/lib/agenda/situation';
import { referenceEventLabel } from '@/services/documents/business-period-surfaces';
import type { AssistantOperationRead } from '@/services/business-operations/read-service';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';
import type { OperationPatch, OperationPatchDateField } from '@/services/business-operations/graph/model';
import { formatDateFr } from '../core/deterministic-format';
import { plain } from '../core/routing-text';
import type { AssistantRequestInput } from '../types/contracts';
import type { ActionResult, CommandParams, PlannedAction } from './catalog';
import type { ExecutionContext } from './executors';
import { bienDesigne, documentDesigne, fournisseurDesigne, type CommandLookup } from './plan.service';
import { declaredDate, type ReferenceEventDraft, type ReferenceEventTargetDraft } from './reference-event-parser';
import {
  DATE_FIELD_LABELS, DEFERRED_OPERATION_ID, REFERENCE_EVENT_CHANGED_SINCE_PREVIEW, REFERENCE_EVENT_NOT_FOUND, TYPE_NOUNS, declaredDateField, matchReferenceEvents,
  relationBetween, relationSentence, shownDate, situationLabel, translateWriteResult, typeChoices, typeLabel,
  type DeclarableTypeCode, type ReferenceEventParams, type ReferenceEventQuery, type ReferenceEventState,
} from './reference-event-model';

type Resolution = PlannedAction | { needInfo: string };
const IMPOSSIBLE = 'Je ne peux pas faire cette modification depuis l’assistant.';

// ── Lecture dans le compte ─────────────────────────────────────────────────

async function assetNames(accountId: number, ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = (await pgClient.unsafe(
    `SELECT id, name FROM assets WHERE account_id = $1 AND id = ANY($2::int[]) AND deleted_at IS NULL`,
    [accountId, ids] as never[],
  )) as unknown as Array<{ id: number; name: string }>;
  return new Map(rows.map((r) => [Number(r.id), r.name]));
}

function toState(op: AssistantOperationRead, noms: Map<number, string>): ReferenceEventState {
  return {
    id: op.id, typeCode: op.typeCode, status: op.status,
    label: referenceEventLabel({ typeCode: op.typeCode, technicalLabel: op.technicalLabel, provider: op.provider, firstDocumentTitle: op.documents[0]?.title ?? null }),
    technicalLabel: op.technicalLabel, provider: op.provider,
    plannedDate: op.plannedDate, startDate: op.startDate, realizedDate: op.realizedDate, endDate: op.endDate,
    assets: op.assetIds.flatMap((id) => (noms.has(id) ? [{ id, name: noms.get(id)! }] : [])),
    documentTitles: op.documents.map((d) => d.title),
    version: op.version,
  };
}

const PAGE = 500;
/** Carte #807 (E06) — temps maximal d'UNE recherche d'opérations dans un compte (parcours complet par curseur). */
export const REFERENCE_EVENT_SEARCH_BUDGET_MS = 20_000;
/** Texte dit quand le parcours complet n'a pas pu aboutir dans le temps imparti (à valider par le PO). */
export const REFERENCE_EVENT_SEARCH_INCOMPLETE = 'Je n’ai pas pu parcourir toutes vos opérations dans le temps imparti, et je ne vous présente pas un résultat partiel. Précisez son type, sa date complète ou son intitulé, puis refaites votre demande : rien n’a été modifié.';

/**
 * Carte #807 (E06) : le parcours des opérations du compte n'a pas pu être mené à son terme. Jamais un résultat
 * partiel n'est rendu à sa place — l'appelant le DIT (aucune action préparée ni exécutée sur une lecture tronquée).
 */
export class ReferenceEventSearchIncomplete extends Error {
  constructor() { super(REFERENCE_EVENT_SEARCH_INCOMPLETE); this.name = 'ReferenceEventSearchIncomplete'; }
}

/**
 * Événements de référence ACTIFS du compte qui répondent à la désignation (lecteur canonique, compte borné).
 *
 * Carte #807 (E06) — règle remplacée (carte #807) : « 10 pages de 500 au plus » (5 000 opérations, au-delà
 * desquelles une opération restait introuvable sans que rien ne le dise). Le compte est désormais parcouru EN
 * ENTIER, par curseur stable (identifiant croissant), page après page ; seules les opérations qui répondent
 * sont gardées en mémoire. Le temps est borné : passé le budget, la recherche échoue EXPLICITEMENT
 * (`ReferenceEventSearchIncomplete`) au lieu de rendre une liste tronquée.
 */
export async function sqlFindReferenceEvents(
  accountId: number, q: ReferenceEventQuery, opts: { budgetMs?: number; now?: () => number } = {},
): Promise<ReferenceEventState[]> {
  const { operationReader } = await import('../canonical/operations');
  const now = opts.now ?? Date.now;
  const fin = now() + (opts.budgetMs ?? REFERENCE_EVENT_SEARCH_BUDGET_MS);
  const trouves: ReferenceEventState[] = [];
  let afterId = 0;
  for (;;) {
    const lot = await operationReader().listForAssistant(accountId, { ...(q.typeCode ? { typeCodes: [q.typeCode] } : {}), limit: PAGE, afterId });
    if (lot.length) {
      const noms = await assetNames(accountId, [...new Set(lot.flatMap((o) => o.assetIds))]);
      trouves.push(...matchReferenceEvents(lot.map((o) => toState(o, noms)), q));
    }
    if (lot.length < PAGE) return trouves;
    afterId = lot[lot.length - 1].id;
    if (now() > fin) throw new ReferenceEventSearchIncomplete();
  }
}

/** Un événement de référence ACTIF du compte, avec le nombre d'échéances et de documents rattachés ; `null` : absent, supprimé ou d'un autre compte. */
export async function sqlGetReferenceEventState(accountId: number, id: number): Promise<ReferenceEventState | null> {
  const { operationReader } = await import('../canonical/operations');
  const [op] = await operationReader().listForAssistant(accountId, { ids: [id], limit: 1 });
  if (!op) return null;
  const noms = await assetNames(accountId, op.assetIds);
  const { readOperationGraph } = await import('@/services/business-operations/graph/read');
  const graphe = await readOperationGraph(accountId, id).catch(() => null);
  // Documents membres : même lecture que la fiche d'un événement de référence (un document rattaché par
  // l'utilisateur en fait partie, même s'il n'en est pas une source).
  const { readReferenceEvent } = await import('@/services/documents/business-period-surfaces');
  const fiche = await readReferenceEvent(accountId, id).catch(() => null);
  return {
    ...toState(op, noms),
    ...(graphe ? { agendaItems: graphe.agendaItems.length } : {}),
    ...(fiche ? { documentCount: fiche.documents.length } : {}),
  };
}

// ── Désignation ────────────────────────────────────────────────────────────

const quand = (s: ReferenceEventState): string => (shownDate(s) ? ` du ${formatDateFr(shownDate(s))}` : '');
/** « Intervention — Vidange » du 12 mars 2025 — Clio. */
export const designer = (s: ReferenceEventState): string => `« ${s.label} »${quand(s)}${s.assets.length ? ` — ${s.assets.map((a) => a.name).join(', ')}` : ''}`;
const motsDe = (t: string): string => plain(t).split(/[^a-z0-9]+/).filter(Boolean).join(' ');
const memeTexte = (a: string, b: string): boolean => motsDe(a) === motsDe(b);
const pluriel = (n: number, un: string, plusieurs: string): string => `${n} ${n > 1 ? plusieurs : un}`;

/**
 * Événement de référence unique désigné par la demande, ou la précision à demander. Jamais un choix au hasard.
 *
 * Passage 114AA (#753) : quand la demande ne désigne RIEN (« Supprime celui-ci », « Relie le fournisseur … à cet
 * événement de référence »), c'est l'événement de référence DU FIL — le dernier sur lequel une action de ce fil
 * a abouti. Il est relu dans le compte (`getReferenceEventState`) : supprimé, inactif ou hors du compte, la
 * question est posée comme avant. Il ne vaut JAMAIS pour un autre fil ni pour un autre membre d'un Duo (il est
 * lu dans le contexte du fil de l'utilisateur), et l'action qu'il vise passe par la confirmation habituelle.
 */
async function evenementDesigne(
  lookup: CommandLookup, input: AssistantRequestInput, cible: ReferenceEventTargetDraft, pourQuoi: string,
): Promise<{ state: ReferenceEventState } | { needInfo: string }> {
  const accountId = input.accountId;
  if (!lookup.findReferenceEvents || !lookup.getReferenceEventState) return { needInfo: IMPOSSIBLE };
  if (!cible.typeCode && cible.words.length === 0 && !cible.date) {
    const duFil = input.threadReferenceEventId;
    if (duFil) {
      const state = await lookup.getReferenceEventState(accountId, duFil);
      if (state) return { state };
    }
    return { needInfo: `Quel événement de référence voulez-vous ${pourQuoi} ? Donnez son intitulé, sa date complète ou son bien.` };
  }
  const introuvable = { needInfo: `Je n’ai pas trouvé cet événement de référence dans votre compte. Lequel voulez-vous ${pourQuoi} ?` };
  const trouves = await lookup.findReferenceEvents(accountId, cible);
  if (trouves.length === 0) return introuvable;
  // Un intitulé exact l'emporte sur ceux qui le contiennent (« Vidange » face à « Vidange et filtres »).
  const exacts = cible.words.length ? trouves.filter((s) => s.technicalLabel !== null && motsDe(s.technicalLabel) === cible.words.join(' ')) : [];
  const retenus = exacts.length === 1 ? exacts : trouves;
  if (retenus.length > 1) {
    return { needInfo: `Plusieurs événements de référence correspondent : ${retenus.slice(0, 5).map(designer).join(' ; ')}. Précisez lequel dans votre demande (intitulé, date complète ou bien).` };
  }
  const state = await lookup.getReferenceEventState(accountId, retenus[0].id);
  return state ? { state } : introuvable;
}

const cibleDe = (s: ReferenceEventState): PlannedAction['targets'][number] => ({ type: 'reference_event', id: s.id, label: s.label });

/**
 * Passage 114AB (#753) : la MÊME désignation, pour les gestes inverses (`reference-events-inverse.ts`) —
 * aucune règle de désignation n'est dupliquée (événement du fil compris).
 */
export const evenementDesignePublic = evenementDesigne;

// ── W21 : créer sur déclaration ────────────────────────────────────────────

interface ComparableQuery { typeCode: DeclarableTypeCode | null; date: string | null; label: string | null; assetIds: number[] }

/**
 * Événements de référence COMPARABLES à une déclaration (lecture seule) : même type, mêmes biens (ou aucun des
 * deux côtés), et même date — ou, sans date, même intitulé. Ce n'est pas un rapprochement sémantique (il relève
 * de la consolidation, carte #744) : un comparable est ANNONCÉ, la confirmation dit qu'il s'agit d'un autre événement.
 */
export async function comparableEvents(
  find: NonNullable<CommandLookup['findReferenceEvents']>, accountId: number, q: ComparableQuery,
): Promise<ReferenceEventState[]> {
  if (!q.date && !q.label) return [];
  const candidats = await find(accountId, { typeCode: q.typeCode, words: [], date: q.date });
  return candidats.filter((s) => {
    if (s.typeCode !== q.typeCode) return false;
    const memesBiens = q.assetIds.length ? q.assetIds.every((id) => s.assets.some((a) => a.id === id)) : s.assets.length === 0;
    if (!memesBiens) return false;
    return q.date !== null || (q.label !== null && s.technicalLabel !== null && memeTexte(q.label, s.technicalLabel));
  });
}

/** Texte, dit à l'aperçu et au résultat : un événement déclaré n'est pas encore visible sur un écran (limite connue, carte #744). */
export const NOT_YET_VISIBLE = 'Pour l’instant, un événement de référence enregistré sur votre déclaration n’apparaît sur aucun écran de l’application (ni fiche, ni recherche).';

async function resolveCreation(
  draft: Extract<ReferenceEventDraft, { command: 'CREATE_REFERENCE_EVENT' }>, input: AssistantRequestInput, lookup: CommandLookup, actionId: string,
): Promise<Resolution> {
  if (!lookup.findReferenceEvents) return { needInfo: IMPOSSIBLE };
  const acc = input.accountId;
  // Carte #807 (E05, W21) — règle remplacée (carte #807) : « l'Assistant n'enregistre pas de sinistre ». Un
  // sinistre se déclare comme toute opération : c'est une opération À PART de celle du contrat d'assurance
  // (jamais fusionnée avec elle), que l'utilisateur peut ensuite lui associer.

  // Bien : jamais attribué par proximité — seulement s'il est désigné (mots, ou « ce bien »).
  let bien: { id: number; name: string; city?: string | null } | null = null;
  let label = draft.label;
  if (draft.assetWords.length && !draft.labelQuoted) {
    const trouves = await lookup.findAssets(acc, draft.assetWords);
    if (trouves.length > 1) return { needInfo: `Plusieurs biens correspondent : ${trouves.slice(0, 5).map((a) => a.name).join(', ')}. Précisez lequel dans votre demande.` };
    // Le dernier complément n'est pas un bien du compte : il fait partie de l'intitulé (« … de la chaudière »). L'aperçu dit « Bien : aucun ».
    if (trouves.length === 0) label = draft.fullLabel;
    else bien = trouves[0];
  } else if (draft.assetWords.length || draft.assetFromContext) {
    const r = await bienDesigne(lookup, input, draft, 'Pour quel bien voulez-vous enregistrer cet événement de référence ?');
    if ('needInfo' in r) return r;
    bien = r.bien;
  }

  if (!draft.status) {
    return { needInfo: `${SITUATION_QUESTION} Précisez-le dans votre demande, par exemple « … réalisée le 12 mars 2025 » ou « … à prévoir ».` };
  }
  const today = lookup.today();
  const date = draft.dateText ? declaredDate(draft.dateText, today, draft.status === 'REALIZED') : null;
  if (draft.dateText && !date) return { needInfo: 'Je n’ai pas compris la date. Pouvez-vous l’écrire en entier, par exemple « 12 mars 2025 » ?' };
  if (date && draft.status === 'REALIZED' && date > today) {
    return { needInfo: 'Un événement qui a eu lieu ne peut pas avoir une date future : corrigez la date, ou dites qu’il est à prévoir.' };
  }
  if (!label && !bien && !date) return { needInfo: 'Que voulez-vous enregistrer ? Donnez au moins un intitulé, un bien ou une date.' };

  const assetIds = bien ? [bien.id] : [];
  const memes = await comparableEvents(lookup.findReferenceEvents, acc, { typeCode: draft.typeCode, date, label, assetIds });
  const dateField = date ? declaredDateField(draft.typeCode, draft.status) : null;
  const nom = draft.typeCode ? referenceEventLabel({ typeCode: draft.typeCode, technicalLabel: label }) : label ?? 'sans intitulé';
  return {
    actionId, command: 'CREATE_REFERENCE_EVENT', dependsOn: [],
    targets: bien ? [{ type: 'asset', id: bien.id, label: bien.name }] : [],
    params: {
      kind: 'reference_event_create', declaration: draft.declaration, typeCode: draft.typeCode, status: draft.status,
      eventLabel: label, dateField, eventDate: date, eventAssetIds: assetIds, distinctFrom: memes.map((s) => s.id),
    },
    preview: `Enregistrer l’événement de référence « ${nom} »${date ? ` du ${formatDateFr(date)}` : ''}${bien ? ` pour ${bien.name}` : ''}.`,
    effects: [
      `Type : ${typeLabel(draft.typeCode)}`,
      `Intitulé : ${label ?? 'aucun'}`,
      `Situation : ${situationLabel(draft.status)}`,
      dateField && date ? `${DATE_FIELD_LABELS[dateField]} : ${formatDateFr(date)}` : 'Date : non précisée (aucune date n’est inventée)',
      `Bien : ${bien ? bien.name : 'aucun'}`,
      ...(memes.length ? [
        `Attention : ${memes.length > 1 ? 'des événements de référence comparables existent' : 'un événement de référence comparable existe'} déjà : ${memes.slice(0, 5).map(designer).join(' ; ')}.`,
        'En confirmant, vous indiquez qu’il s’agit d’un autre événement.',
      ] : []),
      ...(draft.typeCode === 'CLAIM' ? [
        'Ce sinistre est une opération distincte de celle de votre contrat d’assurance : rien n’est fusionné, et le contrat, ses cotisations et ses échéances ne sont pas modifiés.',
        'Vous pourrez ensuite l’associer au contrat d’assurance, lui rattacher ses justificatifs et lui relier un prestataire.',
      ] : []),
      'Il est enregistré sur votre déclaration : aucun document, aucune échéance et aucun montant ne sont créés.',
      NOT_YET_VISIBLE,
      'Vous pourrez le corriger ou le supprimer depuis l’assistant.',
    ],
  };
}

// ── W22 : corriger ─────────────────────────────────────────────────────────

type UpdateChange = Extract<ReferenceEventParams, { kind: 'reference_event_update' }>['change'];
type ChangeField = UpdateChange['field'];
const FIELD_TEXT: Readonly<Record<ChangeField, { label: string; article: string; vide: string }>> = {
  plannedDate: { label: DATE_FIELD_LABELS.plannedDate, article: 'la date prévue', vide: '(aucune)' },
  startDate: { label: DATE_FIELD_LABELS.startDate, article: 'la date de début', vide: '(aucune)' },
  realizedDate: { label: DATE_FIELD_LABELS.realizedDate, article: 'la date', vide: '(aucune)' },
  endDate: { label: DATE_FIELD_LABELS.endDate, article: 'la date de fin', vide: '(aucune)' },
  provider: { label: 'Prestataire', article: 'le prestataire', vide: '(aucun)' },
  label: { label: 'Intitulé', article: 'l’intitulé', vide: '(aucun)' },
  type: { label: 'Type', article: 'le type', vide: typeLabel(null) },
  status: { label: 'Situation', article: 'la situation', vide: 'non précisée' },
};
const DATE_FIELDS: readonly OperationPatchDateField[] = ['plannedDate', 'startDate', 'realizedDate', 'endDate'];
const estDate = (f: string): f is OperationPatchDateField => (DATE_FIELDS as readonly string[]).includes(f);

async function resolveUpdate(
  draft: Extract<ReferenceEventDraft, { command: 'UPDATE_REFERENCE_EVENT' }>, input: AssistantRequestInput, lookup: CommandLookup, actionId: string,
): Promise<Resolution> {
  const cible = await evenementDesigne(lookup, input, draft.target, 'corriger');
  if ('needInfo' in cible) return cible;
  const s = cible.state;
  const today = lookup.today();
  const field: ChangeField = draft.field === 'date' ? declaredDateField(s.typeCode, s.status) : draft.field;
  const def = FIELD_TEXT[field];
  let change: UpdateChange;
  let avant: string;
  let apres: string;

  if (field === 'status') {
    if (s.status === 'REALIZED') return { needInfo: `« ${s.label} » est déjà indiqué comme ayant eu lieu.` };
    change = { field, value: 'REALIZED' };
    avant = s.status === 'ENVISAGED' ? situationLabel('ENVISAGED') : def.vide;
    apres = situationLabel('REALIZED');
  } else if (field === 'type') {
    const code = draft.value ? TYPE_NOUNS.get(plain(draft.value).trim().replace(/^(?:une?\s+|l'|le\s+|la\s+)/, '')) ?? null : null;
    if (!code) return { needInfo: `Quel type voulez-vous donner à « ${s.label} » ? Par exemple : ${typeChoices()}.` };
    if (code === 'CLAIM' || s.typeCode === 'CLAIM') return { needInfo: 'Depuis l’assistant, le type d’un sinistre ne se modifie pas.' };
    if (code === s.typeCode) return { needInfo: `« ${s.label} » est déjà de type ${typeLabel(code).toLowerCase()}.` };
    change = { field, value: code };
    avant = typeLabel(s.typeCode);
    apres = typeLabel(code);
  } else if (field === 'provider' || field === 'label') {
    const valeur = draft.value?.replace(/\s+/g, ' ').trim() ?? '';
    if (!valeur) return { needInfo: `Quelle valeur voulez-vous enregistrer pour ${def.article} de « ${s.label} » ?` };
    if (valeur.length > 200) return { needInfo: 'Cette valeur est trop longue (200 caractères au plus).' };
    const actuelle = field === 'provider' ? s.provider : s.technicalLabel;
    if (actuelle === valeur) return { needInfo: `${def.label} de « ${s.label} » : c’est déjà ${valeur}.` };
    change = { field, value: valeur };
    avant = actuelle ?? def.vide;
    apres = valeur;
  } else {
    if (!draft.value) return { needInfo: `Quelle date voulez-vous enregistrer pour « ${s.label} » ?` };
    // Sans année écrite : une date de réalisation ou de début est passée ; une date prévue ou de fin est à venir. L'aperçu donne la date complète.
    const date = declaredDate(draft.value, today, field === 'realizedDate' || field === 'startDate');
    if (!date) return { needInfo: 'Je n’ai pas compris la date. Pouvez-vous l’écrire en entier, par exemple « 12 mars 2025 » ?' };
    if (field === 'realizedDate' && date > today) return { needInfo: 'Un événement qui a eu lieu ne peut pas avoir une date future.' };
    const debut = field === 'startDate' ? date : s.startDate;
    const fin = field === 'endDate' ? date : s.endDate;
    if (debut && fin && fin < debut) return { needInfo: 'La date de fin ne peut pas précéder la date de début.' };
    const actuelle = s[field];
    if (actuelle === date) return { needInfo: `${def.label} de « ${s.label} » : c’est déjà le ${formatDateFr(date)}.` };
    change = { field, value: date };
    avant = actuelle ? formatDateFr(actuelle) : def.vide;
    apres = formatDateFr(date);
  }

  const protege = estDate(field) || field === 'provider';
  return {
    actionId, command: 'UPDATE_REFERENCE_EVENT', dependsOn: [], targets: [cibleDe(s)],
    params: { kind: 'reference_event_update', operationId: s.id, declaration: draft.declaration, change, expectedVersion: s.version },
    preview: `Modifier ${def.article} de l’événement de référence ${designer(s)} : ${avant} → ${apres}.`,
    effects: [
      `Événement de référence : ${s.label}`,
      `${def.label} : ${avant} → ${apres}`,
      ...(protege ? ['Cette correction est enregistrée comme votre décision : elle ne sera pas remplacée par une analyse.'] : []),
      'Pour revenir en arrière, refaites une demande de correction.',
    ],
  };
}

// ── W23 : supprimer (invalider) ────────────────────────────────────────────

async function resolveInvalidation(
  draft: Extract<ReferenceEventDraft, { command: 'INVALIDATE_REFERENCE_EVENT' }>, input: AssistantRequestInput, lookup: CommandLookup, actionId: string,
): Promise<Resolution> {
  const cible = await evenementDesigne(lookup, input, draft.target, 'supprimer');
  if ('needInfo' in cible) return cible;
  const s = cible.state;
  const documents = s.documentCount ?? s.documentTitles.length;
  const conserves = [
    ...(documents ? [pluriel(documents, 'document', 'documents')] : []),
    ...(s.agendaItems ? [pluriel(s.agendaItems, 'échéance', 'échéances')] : []),
  ];
  return {
    actionId, command: 'INVALIDATE_REFERENCE_EVENT', dependsOn: [], targets: [cibleDe(s)],
    params: { kind: 'reference_event_invalidate', operationId: s.id, expectedVersion: s.version },
    preview: `Supprimer l’événement de référence ${designer(s)}.`,
    effects: [
      'Seul cet événement de référence est retiré : il n’est plus pris en compte (dépenses, réponses de l’assistant).',
      conserves.length
        ? `Conservés dans votre compte : ${conserves.join(', ')}, ainsi que ses fournisseurs.`
        : 'Aucun document ni échéance ne lui est rattaché ; ses fournisseurs sont conservés.',
      ...(s.agendaItems ? ['Ses échéances restent dans l’Agenda, à leur date, avec leurs rappels ; elles ne lui sont plus rattachées.'] : []),
      ...(documents ? ['Ses documents ne sont pas supprimés : une prochaine analyse de ces documents peut faire apparaître un nouvel événement de référence.'] : []),
      'Depuis l’assistant, cette suppression ne s’annule pas.',
    ],
  };
}

// ── W24 : associer deux événements de référence ────────────────────────────

async function resolveAssociation(
  draft: Extract<ReferenceEventDraft, { command: 'ASSOCIATE_REFERENCE_EVENTS' }>, input: AssistantRequestInput, lookup: CommandLookup, actionId: string,
): Promise<Resolution> {
  const premier = await evenementDesigne(lookup, input, draft.first, 'associer');
  if ('needInfo' in premier) return premier;
  const second = await evenementDesigne(lookup, input, draft.second, 'associer');
  if ('needInfo' in second) return second;
  const a = premier.state;
  const b = second.state;
  if (a.id === b.id) return { needInfo: 'Ces deux désignations correspondent au même événement de référence : précisez les deux événements à associer.' };
  const r = relationBetween(a, b);
  const from = r.fromOperationId === a.id ? a : b;
  const to = r.fromOperationId === a.id ? b : a;
  return {
    actionId, command: 'ASSOCIATE_REFERENCE_EVENTS', dependsOn: [], targets: [cibleDe(from), cibleDe(to)],
    params: { kind: 'reference_events_associate', fromOperationId: from.id, toOperationId: to.id, nature: r.nature, expectedVersions: [from.version, to.version] },
    preview: `Associer les événements de référence ${designer(a)} et ${designer(b)}.`,
    effects: [
      relationSentence(r.nature, from.label, to.label),
      'Ils restent deux événements de référence distincts : rien n’est fusionné.',
      'Aucun document n’est déplacé ; aucun montant, aucune date et aucune échéance ne sont modifiés.',
    ],
  };
}

// ── W25 : rattacher un document ────────────────────────────────────────────

async function resolveDocumentLink(
  draft: Extract<ReferenceEventDraft, { command: 'LINK_DOCUMENT_REFERENCE_EVENT' }>, input: AssistantRequestInput, lookup: CommandLookup, actionId: string,
): Promise<Resolution> {
  const doc = await documentDesigne(lookup, input, draft, 'rattacher');
  if ('needInfo' in doc) return doc;
  const cible = await evenementDesigne(lookup, input, draft.target, 'compléter');
  if ('needInfo' in cible) return cible;
  const s = cible.state;
  const d = doc.state;
  return {
    actionId, command: 'LINK_DOCUMENT_REFERENCE_EVENT', dependsOn: [],
    targets: [{ type: 'document', id: d.id, label: d.title }, cibleDe(s)],
    params: { kind: 'reference_event_document', operationId: s.id, linkedDocumentId: d.id, expectedVersion: s.version, documentVersion: d.version },
    preview: `Rattacher le document « ${d.title} » à l’événement de référence ${designer(s)}.`,
    effects: [
      `Document : ${d.title}${d.documentDate ? ` du ${formatDateFr(d.documentDate)}` : ''}`,
      `Événement de référence : ${s.label}`,
      'Le document reste dans vos documents et garde ses autres rattachements.',
      'Ce rattachement est votre décision. Il n’ajoute par lui-même aucun montant à cet événement de référence.',
    ],
  };
}

// ── W26 : relier un fournisseur ────────────────────────────────────────────

const ROLE_LABELS: Readonly<Record<Extract<ReferenceEventParams, { kind: 'reference_event_supplier' }>['role'], string>> = {
  PROVIDER: 'Prestataire', INTERVENER: 'Intervenant',
};

async function resolveSupplierLink(
  draft: Extract<ReferenceEventDraft, { command: 'LINK_SUPPLIER_REFERENCE_EVENT' }>, input: AssistantRequestInput, lookup: CommandLookup, actionId: string,
): Promise<Resolution> {
  const fournisseur = await fournisseurDesigne(lookup, input.accountId, draft.supplierWords, 'relier');
  if ('needInfo' in fournisseur) return fournisseur;
  const cible = await evenementDesigne(lookup, input, draft.target, 'compléter');
  if ('needInfo' in cible) return cible;
  const s = cible.state;
  const f = fournisseur.state;
  return {
    actionId, command: 'LINK_SUPPLIER_REFERENCE_EVENT', dependsOn: [],
    targets: [{ type: 'supplier', id: f.id, label: f.name }, cibleDe(s)],
    params: { kind: 'reference_event_supplier', operationId: s.id, linkedSupplierId: f.id, role: draft.role, expectedVersion: s.version, supplierVersion: f.version },
    preview: `Relier le fournisseur « ${f.name} » à l’événement de référence ${designer(s)}.`,
    effects: [
      `Fournisseur : ${f.name}`,
      `Rôle : ${ROLE_LABELS[draft.role]}`,
      `Événement de référence : ${s.label}`,
      'Aucun document, aucun coût et aucune échéance ne sont créés.',
      'Ce lien est votre décision : il ne sera pas modifié par une analyse.',
    ],
  };
}

// ── Passage 114Z4 : « Déclare … puis relie / rattache … à celui-ci » ───────

/**
 * Lien vers l'événement qu'une AUTRE action du même plan enregistre (W25, W26).
 *
 * L'événement n'existe pas encore au moment de l'aperçu : seuls le document ou le fournisseur sont résolus et
 * figés ici ; l'identifiant de l'événement est posé à l'exécution, depuis le résultat de l'action dont celle-ci
 * dépend (`operationFromAction`). Si cet enregistrement échoue, l'action n'est pas exécutée (SKIPPED_DEPENDENCY)
 * et rien n'est écrit. L'aperçu le dit en toutes lettres : jamais un lien vers un événement choisi au hasard.
 */
export async function resolveReferenceEventLinkToCreated(
  draft: Extract<ReferenceEventDraft, { command: 'LINK_DOCUMENT_REFERENCE_EVENT' | 'LINK_SUPPLIER_REFERENCE_EVENT' }>,
  input: AssistantRequestInput, lookup: CommandLookup, actionId: string, fromActionId: string,
): Promise<Resolution> {
  const commun = ['Événement de référence : celui que l’action précédente enregistre.',
    'Si cet enregistrement n’aboutit pas, ce lien n’est pas fait et rien n’est écrit.'];
  if (draft.command === 'LINK_SUPPLIER_REFERENCE_EVENT') {
    const fournisseur = await fournisseurDesigne(lookup, input.accountId, draft.supplierWords, 'relier');
    if ('needInfo' in fournisseur) return fournisseur;
    const f = fournisseur.state;
    return {
      actionId, command: 'LINK_SUPPLIER_REFERENCE_EVENT', dependsOn: [], targets: [{ type: 'supplier', id: f.id, label: f.name }],
      params: {
        kind: 'reference_event_supplier', operationId: DEFERRED_OPERATION_ID, operationFromAction: fromActionId,
        linkedSupplierId: f.id, role: draft.role, expectedVersion: 0, supplierVersion: f.version,
      },
      preview: `Relier le fournisseur « ${f.name} » à l’événement de référence qui vient d’être enregistré.`,
      effects: [`Fournisseur : ${f.name}`, `Rôle : ${ROLE_LABELS[draft.role]}`, ...commun,
        'Aucun document, aucun coût et aucune échéance ne sont créés.',
        'Ce lien est votre décision : il ne sera pas modifié par une analyse.'],
    };
  }
  const doc = await documentDesigne(lookup, input, draft, 'rattacher');
  if ('needInfo' in doc) return doc;
  const d = doc.state;
  return {
    actionId, command: 'LINK_DOCUMENT_REFERENCE_EVENT', dependsOn: [], targets: [{ type: 'document', id: d.id, label: d.title }],
    params: {
      kind: 'reference_event_document', operationId: DEFERRED_OPERATION_ID, operationFromAction: fromActionId,
      linkedDocumentId: d.id, expectedVersion: 0, documentVersion: d.version,
    },
    preview: `Rattacher le document « ${d.title} » à l’événement de référence qui vient d’être enregistré.`,
    effects: [`Document : ${d.title}${d.documentDate ? ` du ${formatDateFr(d.documentDate)}` : ''}`, ...commun,
      'Le document reste dans vos documents et garde ses autres rattachements.',
      'Ce rattachement est votre décision. Il n’ajoute par lui-même aucun montant à cet événement de référence.'],
  };
}

/**
 * Résout un brouillon en action figée — ou dit ce qui manque (appelé par `resolveDraft`).
 * Passage 114AB (#753) : les GESTES INVERSES ont leur propre résolveur
 * (`reference-events-inverse.ts`), vers lequel `plan.service.ts` les envoie ; ils sont donc
 * exclus d'ici, ce qui garde ce choix exhaustif.
 */
export async function resolveReferenceEventCommand(
  draft: Exclude<ReferenceEventDraft, {
    command: 'RESTORE_REFERENCE_EVENT' | 'DISSOCIATE_REFERENCE_EVENTS' | 'UNLINK_DOCUMENT_REFERENCE_EVENT'
      | 'UNLINK_SUPPLIER_REFERENCE_EVENT' | 'LINK_AGENDA_REFERENCE_EVENT' | 'DOCUMENT_REFERENCE_EVENT_TRANSFER_REQUEST';
  }>,
  input: AssistantRequestInput, lookup: CommandLookup, actionId: string,
): Promise<Resolution> {
  switch (draft.command) {
    case 'CREATE_REFERENCE_EVENT': return resolveCreation(draft, input, lookup, actionId);
    case 'UPDATE_REFERENCE_EVENT': return resolveUpdate(draft, input, lookup, actionId);
    case 'INVALIDATE_REFERENCE_EVENT': return resolveInvalidation(draft, input, lookup, actionId);
    case 'ASSOCIATE_REFERENCE_EVENTS': return resolveAssociation(draft, input, lookup, actionId);
    case 'LINK_DOCUMENT_REFERENCE_EVENT': return resolveDocumentLink(draft, input, lookup, actionId);
    case 'LINK_SUPPLIER_REFERENCE_EVENT': return resolveSupplierLink(draft, input, lookup, actionId);
    default: { const jamais: never = draft; return jamais; }
  }
}

/**
 * Le brouillon est-il VRAIMENT une commande pour ce compte ? Non-régression : ces phrases suivaient jusqu'ici le
 * parcours de réponse normal (aide, compréhension par le sens, proposition de mise à jour d'une fiche). Elles ne
 * deviennent une action que si elles désignent quelque chose de réel :
 *   · déclaration IMPLICITE (« j'ai fait … de la Clio hier ») : son bien est un bien du compte (ou le bien de la
 *     page pour « ce bien ») ;
 *   · « Déclare un sinistre … » : une action comme les autres déclarations (carte #807, E05) ;
 *   · événement désigné par le NOM D'UN TYPE (« le contrat … », « l'intervention … ») : au moins un événement de
 *     référence du compte y répond. « Mets la date de fin du contrat au … » dans un compte sans événement de ce
 *     type reste donc traité comme avant.
 * Une phrase qui dit « événement de référence » est toujours une commande (question précise si rien n'est trouvé).
 * `false` → `prepareCommand` rend `null` : le message suit le parcours de réponse normal.
 *
 * `sameSentenceAnaphora` (passage 114Z4) : ce segment vise l'événement que la DÉCLARATION de la même phrase
 * enregistre — il n'a donc rien à désigner dans le compte, et le fil n'a pas à porter d'événement.
 */
export async function isReferenceEventCommand(
  draft: ReferenceEventDraft, input: AssistantRequestInput, lookup: CommandLookup, sameSentenceAnaphora = false,
): Promise<boolean> {
  if (draft.command === 'CREATE_REFERENCE_EVENT') {
    // Carte #807 (E05) — règle remplacée (carte #807) : « Déclare un sinistre … » est désormais une action.
    if (!draft.implicit) return true;
    if (draft.assetWords.length) return (await lookup.findAssets(input.accountId, draft.assetWords)).length > 0;
    const id = input.reference?.type === 'asset' ? input.reference.id : Number(input.pageContext?.assetId) || null;
    return !!id && !!(await lookup.getAsset(input.accountId, id));
  }
  // Passage 114AB : un geste INVERSE sur un événement SUPPRIMÉ se vérifie dans les suppressions de
  // l'utilisateur ; sans aucune, la phrase suit le parcours de réponse normal, comme avant.
  if (draft.command === 'RESTORE_REFERENCE_EVENT') {
    if (draft.target.typeCode === null && draft.target.words.length === 0 && !draft.target.date) return false;
    if (!lookup.findInvalidatedReferenceEvents) return false;
    return (await lookup.findInvalidatedReferenceEvents(input.accountId, draft.target)).length > 0;
  }
  // Carte #807 (E09) : demande de déplacement d'un document — une commande dès qu'elle nomme une opération.
  if (draft.command === 'DOCUMENT_REFERENCE_EVENT_TRANSFER_REQUEST') return true;
  const cibles = draft.command === 'ASSOCIATE_REFERENCE_EVENTS' || draft.command === 'DISSOCIATE_REFERENCE_EVENTS'
    ? [draft.first, draft.second] : [draft.target];
  for (const cible of cibles) {
    // Passage 114AA : un PRONOM seul (« à celui-ci ») ne désigne un événement de référence que si le fil en
    // porte un. Sinon la phrase suit le parcours de réponse normal, exactement comme avant ce passage —
    // jamais une question sur un objet dont le fil n'a jamais parlé.
    if (cible.pronounOnly && !sameSentenceAnaphora && !input.threadReferenceEventId) return false;
    if (cible.typeCode === null) continue;
    if (!lookup.findReferenceEvents || (await lookup.findReferenceEvents(input.accountId, cible)).length === 0) return false;
  }
  return true;
}

// ── Exécution : par la façade métier, état relu avant d'écrire ─────────────

type Params<K extends ReferenceEventParams['kind']> = Extract<CommandParams, { kind: K }>;
const refuse = (a: PlannedAction, message: string): ActionResult => ({ actionId: a.actionId, status: 'REFUSED', message });
const ko = (a: PlannedAction, message: string): ActionResult => ({ actionId: a.actionId, status: 'FAILED', message });

/** Contexte de la façade : geste de l'utilisateur confirmé dans l'Assistant ; clé d'idempotence propre au plan et à l'action. */
export function writeContext(ctx: ExecutionContext, action: Pick<PlannedAction, 'actionId'>): OperationWriteContext {
  return {
    accountId: ctx.accountId,
    actor: { kind: 'USER', userId: ctx.userId, channel: 'ASSISTANT' },
    ...(ctx.planId ? { idempotencyKey: `t2.${ctx.planId}.${action.actionId}`, correlationId: `t2-plan-${ctx.planId}` } : {}),
  };
}

/** Correction d'UN champ de la façade (dates, prestataire). */
function patchOf(field: OperationPatchDateField | 'provider', value: string): OperationPatch {
  const patch: OperationPatch = {};
  patch[field] = value;
  return patch;
}

/**
 * Fin d'une action : une réussite est déclarée irréversible (aucun « Annuler » promis), et la version que CE plan
 * vient de donner aux événements écrits est retenue — celle rendue par la façade, sinon relue aussitôt — pour
 * qu'une action suivante du même plan sur le même événement ne soit pas refusée à cause de la précédente.
 */
async function terminer(
  ctx: ExecutionContext, action: PlannedAction, r: ActionResult, reason: string, ecrits: Array<{ operationId: number; version?: number }> = [],
): Promise<ActionResult> {
  if (r.status !== 'SUCCESS') return r;
  ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason });
  if (ctx.referenceEventVersions) {
    const { sqlLookup } = await import('./plan.service');
    for (const e of ecrits) {
      const version = e.version ?? (await sqlLookup.getReferenceEventState!(ctx.accountId, e.operationId).catch(() => null))?.version;
      if (version !== undefined) ctx.referenceEventVersions.set(e.operationId, version);
    }
  }
  return r;
}

/**
 * État relu : `null` → refus (absent du compte, ou supprimé) ; version différente de celle de l'aperçu → rien
 * n'est écrit — sauf si c'est CE plan qui vient de l'écrire (`referenceEventVersions`).
 */
async function relu(ctx: ExecutionContext, action: PlannedAction, operationId: number, expectedVersion: number): Promise<ReferenceEventState | ActionResult> {
  const { sqlLookup } = await import('./plan.service');
  const etat = await sqlLookup.getReferenceEventState!(ctx.accountId, operationId);
  if (!etat) return refuse(action, REFERENCE_EVENT_NOT_FOUND);
  if (etat.version !== expectedVersion && etat.version !== ctx.referenceEventVersions?.get(operationId)) return ko(action, REFERENCE_EVENT_CHANGED_SINCE_PREVIEW);
  return etat;
}
const estResultat = (v: ReferenceEventState | ActionResult): v is ActionResult => 'actionId' in v;

export const REFERENCE_EVENT_EXECUTORS = {
  /** W21 — comparables recontrôlés (un comparable apparu depuis l'aperçu : rien n'est créé), puis `createOperation`. */
  async CREATE_REFERENCE_EVENT(action: PlannedAction, ctx: ExecutionContext): Promise<ActionResult> {
    const p = action.params as Params<'reference_event_create'>;
    const { sqlLookup } = await import('./plan.service');
    const memes = await comparableEvents(sqlLookup.findReferenceEvents!, ctx.accountId, { typeCode: p.typeCode, date: p.eventDate, label: p.eventLabel, assetIds: p.eventAssetIds });
    if (memes.some((s) => !p.distinctFrom.includes(s.id))) {
      return ko(action, 'Un événement de référence comparable est apparu depuis l’aperçu : rien n’a été créé. Refaites votre demande.');
    }
    const { createOperation } = await import('@/services/business-operations/operation-write.facade');
    const r = await createOperation(writeContext(ctx, action), {
      declaration: p.declaration, type: p.typeCode ? { code: p.typeCode } : null, status: p.status,
      ...(p.dateField && p.eventDate ? { attributes: patchOf(p.dateField, p.eventDate) } : {}),
      ...(p.eventLabel ? { label: p.eventLabel } : {}),
      assetIds: p.eventAssetIds,
    });
    const nom = p.typeCode ? referenceEventLabel({ typeCode: p.typeCode, technicalLabel: p.eventLabel }) : p.eventLabel ?? 'sans intitulé';
    return terminer(ctx, action, translateWriteResult(action, r, {
      done: `Événement de référence « ${nom} » enregistré. ${NOT_YET_VISIBLE}`,
      alreadyDone: 'Cet événement de référence était déjà enregistré (même déclaration) : rien n’a été créé en double.',
      // Passage 114Z4 : la version de l'événement CRÉÉ est retenue — une action suivante du même plan
      // (« … puis relie … à celui-ci ») écrit sur l'état que ce plan vient d'établir.
    }, r.data?.operationId ?? null), 'événement de référence enregistré : il se supprime par une nouvelle demande',
    r.data?.operationId ? [{ operationId: r.data.operationId, version: r.data.version }] : []);
  },

  /** W22 — `updateOperation` : un champ, version présentée exigée par la façade (sous verrou). */
  async UPDATE_REFERENCE_EVENT(action: PlannedAction, ctx: ExecutionContext): Promise<ActionResult> {
    const p = action.params as Params<'reference_event_update'>;
    const etat = await relu(ctx, action, p.operationId, p.expectedVersion);
    if (estResultat(etat)) return etat;
    const { updateOperation } = await import('@/services/business-operations/operation-write.facade');
    const c = p.change;
    const r = await updateOperation(writeContext(ctx, action), {
      // Version exigée par la façade, sous verrou : celle de l'état qui vient d'être relu (aperçu, ou écriture de ce plan).
      operationId: p.operationId, declaration: p.declaration, expectedVersion: etat.version,
      ...(c.field === 'type' ? { type: { code: c.value } }
        : c.field === 'status' ? { status: c.value }
          : c.field === 'label' ? { label: c.value }
            : { attributes: patchOf(c.field, c.value) }),
    });
    return terminer(ctx, action, translateWriteResult(action, r, {
      done: `Événement de référence « ${etat.label} » corrigé.`,
      alreadyDone: `Événement de référence « ${etat.label} » : cette valeur était déjà enregistrée, rien n’a été modifié.`,
    }, p.operationId), 'correction d’un événement de référence : à corriger par une nouvelle demande', [{ operationId: p.operationId, version: r.data?.version }]);
  },

  /** W23 — `invalidateOperation` : invalidation logique, jamais une suppression physique. */
  async INVALIDATE_REFERENCE_EVENT(action: PlannedAction, ctx: ExecutionContext): Promise<ActionResult> {
    const p = action.params as Params<'reference_event_invalidate'>;
    const etat = await relu(ctx, action, p.operationId, p.expectedVersion);
    if (estResultat(etat)) return etat;
    const { invalidateOperation } = await import('@/services/business-operations/operation-write.facade');
    const r = await invalidateOperation(writeContext(ctx, action), { operationId: p.operationId, expectedVersion: etat.version });
    return terminer(ctx, action, translateWriteResult(action, r, {
      done: `Événement de référence « ${etat.label} » supprimé. Ses documents, ses échéances et ses fournisseurs sont conservés.`,
      alreadyDone: `L’événement de référence « ${etat.label} » était déjà supprimé : rien n’a été modifié.`,
    }, p.operationId), 'suppression d’un événement de référence : elle ne s’annule pas depuis l’assistant');
  },

  /** W24 — `associateOperations` : les deux événements relus ; relation unique par paire, jamais une fusion. */
  async ASSOCIATE_REFERENCE_EVENTS(action: PlannedAction, ctx: ExecutionContext): Promise<ActionResult> {
    const p = action.params as Params<'reference_events_associate'>;
    const from = await relu(ctx, action, p.fromOperationId, p.expectedVersions[0]);
    if (estResultat(from)) return from;
    const to = await relu(ctx, action, p.toOperationId, p.expectedVersions[1]);
    if (estResultat(to)) return to;
    const { associateOperations } = await import('@/services/business-operations/operation-write.facade');
    const r = await associateOperations(writeContext(ctx, action), { fromOperationId: p.fromOperationId, toOperationId: p.toOperationId, nature: p.nature });
    return terminer(ctx, action, translateWriteResult(action, r, {
      done: `Événements de référence « ${from.label} » et « ${to.label} » associés. Ils restent distincts.`,
      alreadyDone: `Les événements de référence « ${from.label} » et « ${to.label} » étaient déjà associés : rien n’a été modifié.`,
    }, p.fromOperationId), 'association de deux événements de référence', [{ operationId: p.fromOperationId }, { operationId: p.toOperationId }]);
  },

  /** W25 — `linkDocument` : événement ET document relus tels que présentés. */
  async LINK_DOCUMENT_REFERENCE_EVENT(action: PlannedAction, ctx: ExecutionContext): Promise<ActionResult> {
    const p = action.params as Params<'reference_event_document'>;
    const etat = await relu(ctx, action, p.operationId, p.expectedVersion);
    if (estResultat(etat)) return etat;
    const { sqlLookup } = await import('./plan.service');
    const doc = await sqlLookup.getDocumentState!(ctx.accountId, p.linkedDocumentId);
    if (!doc) return refuse(action, 'Document introuvable ou hors de votre compte.');
    if (doc.version !== p.documentVersion) return ko(action, 'Ce document a été modifié depuis l’aperçu : rien n’a été fait. Refaites votre demande.');
    const { linkDocument } = await import('@/services/business-operations/operation-write.facade');
    const r = await linkDocument(writeContext(ctx, action), { operationId: p.operationId, fileId: p.linkedDocumentId });
    return terminer(ctx, action, translateWriteResult(action, r, {
      done: `Document « ${doc.title} » rattaché à l’événement de référence « ${etat.label} ».`,
      alreadyDone: `Le document « ${doc.title} » était déjà rattaché à l’événement de référence « ${etat.label} » : rien n’a été modifié.`,
    }, p.operationId), 'rattachement d’un document à un événement de référence', [{ operationId: p.operationId }]);
  },

  /** W26 — `linkSupplier` : événement ET fournisseur relus tels que présentés. */
  async LINK_SUPPLIER_REFERENCE_EVENT(action: PlannedAction, ctx: ExecutionContext): Promise<ActionResult> {
    const p = action.params as Params<'reference_event_supplier'>;
    const etat = await relu(ctx, action, p.operationId, p.expectedVersion);
    if (estResultat(etat)) return etat;
    const { sqlLookup } = await import('./plan.service');
    const fournisseur = await sqlLookup.getSupplierState!(ctx.accountId, p.linkedSupplierId);
    if (!fournisseur) return refuse(action, 'Fournisseur introuvable ou hors de votre compte.');
    if (fournisseur.version !== p.supplierVersion) return ko(action, 'Ce fournisseur a été modifié depuis l’aperçu : rien n’a été fait. Refaites votre demande.');
    const { linkSupplier } = await import('@/services/business-operations/operation-write.facade');
    const r = await linkSupplier(writeContext(ctx, action), { operationId: p.operationId, supplierId: p.linkedSupplierId, role: p.role });
    return terminer(ctx, action, translateWriteResult(action, r, {
      done: `Fournisseur « ${fournisseur.name} » relié à l’événement de référence « ${etat.label} ».`,
      alreadyDone: `Le fournisseur « ${fournisseur.name} » était déjà relié à l’événement de référence « ${etat.label} » : rien n’a été modifié.`,
    }, p.operationId), 'lien entre un fournisseur et un événement de référence', [{ operationId: p.operationId }]);
  },
};
