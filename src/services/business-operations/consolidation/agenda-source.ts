/**
 * Sources AGENDA : un événement d'agenda SAISI ou CORRIGÉ par l'utilisateur
 * comme source d'une Opération — règles PURES (lot 47B, point 1 ; CDC
 * Opérations V1 ch. 3.1, 3.2, 6.1, 17, B4, B9, B16, C2, C4 TRG-012 à TRG-014,
 * C5, C7.2, C8, C16.1, C16.2, C19 ; recette F-020 à F-022, F-085 à F-087).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUI PEUT ÊTRE SOURCE (garde anti-blanchiment, C2 / C16.2)
 *
 *   · élément saisi à la main (`is_automatic = false`) ;
 *   · élément automatique (T4, projection) MODIFIÉ par l'utilisateur :
 *     titre / date / description (`is_automatic_modified`), ou statut posé
 *     par un geste utilisateur (dernière trace de statut = STATUS_CHANGED ;
 *     un statut posé par le système — STATUS_AUTO_COMPLETED — ne compte pas).
 *   Jamais une projection (`projection_origin = 'OPERATION'`) ni un élément
 *   T4 intacts : une sortie T4 ne prouve rien (C2, B16).
 *
 * QUOI (C2 « action métier explicitement planifiée / réalisée ; jamais pour
 * un rappel pur ») — type INTERVENTION seulement (ch. 3.1 : « Agenda :
 * intervention réellement décidée et planifiée → INTERVENTION ENVISAGED ») ;
 * un achat, un sinistre, une cession, un contrat ont leur source de saisie
 * propre (fiche, formulaire Sinistre) : l'agenda ne les corrige pas.
 *
 * CRÉATION (C5 « AGENDA action métier explicite : oui ; rappel pur
 * interdit ») — règles FERMÉES, toutes requises :
 *   1. élément saisi à la main (un élément automatique corrigé se RATTACHE,
 *      il ne crée pas : son document est déjà la preuve, T1 / T3) ;
 *   2. daté, rattaché à au moins un bien du compte, non annulé ;
 *   3. intitulé (ou type métier) d'une intervention : entretien, révision,
 *      réparation, remplacement, installation, vidange, ramonage, travaux… ;
 *   4. ni rappel (« penser à », « vérifier », « rappel », « devis »,
 *      « appeler »…, ou une question), ni échéance (« avant le »,
 *      « échéance », « expiration », « renouvellement »…) (3.2, F-020).
 *   Statut : « réalisé » posé, fait HISTORICAL, ou intitulé qui le dit
 *   (« faite », « effectué »…) → REALIZED (F-022) ; sinon ENVISAGED (F-021) —
 *   une date passée seule ne prouve pas la réalisation (17).
 *
 * CONTRIBUTION D'UNE SOURCE AGENDA (reconsolidation T3, C19 « Source
 * Agenda utilisateur prioritaire sur projection système »)
 *   · « réalisé » → REALIZED, date de réalisation = date de l'élément si
 *     elle n'est pas future (sinon inconnue : rien d'inventé, C16.1) ; la
 *     date prévue est conservée (C8) ;
 *   · « annulé » → CANCELLED seulement si AUCUNE autre preuve ne soutient
 *     l'Opération ; sinon la source est RETIRÉE et l'Opération reste
 *     (TRG-014 « ne pas annuler l'Operation si d'autres preuves existent »,
 *     F-087 « annulation d'un événement projeté : jamais source d'annulation
 *     métier ») ;
 *   · sinon ENVISAGED, date prévue = date de l'élément ;
 *   · la date saisie PRIME pour le fait qu'elle porte (date prévue, date de
 *     réalisation) ; les biens / équipements de l'élément ne reciblent pas
 *     une Opération prouvée par d'autres sources (`applyAgendaAuthority`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { normalizeText } from '../agenda-projection/model';
import type { BusinessOperationStatus } from '../model';
import type { CandidateIdentity, ConsolidatedState, SourceContribution } from './model';

/** Marqueur du locator d'une source AGENDA gérée par T3 (`locator.agenda`). */
export const AGENDA_SOURCE_LOCATOR = { agenda: 'user' } as const;

/** Élément d'agenda tel que T3 le lit (une lecture, sous verrou). */
export interface AgendaSourceItem {
  id: number;
  accountId: number;
  title: string;
  description: string | null;
  /** `start_date` (AAAA-MM-JJ). */
  date: string | null;
  endDate: string | null;
  manualStatus: string | null;
  isAutomatic: boolean;
  isAutomaticModified: boolean;
  /** `projection_origin = 'OPERATION'`. */
  projected: boolean;
  /** Dernière trace de statut posée par l'utilisateur (STATUS_CHANGED). */
  statusByUser: boolean;
  /** `business_operation_id` résolu vers la canonique (fusion), ou null. */
  businessOperationId: number | null;
  nature: string | null;
  businessType: string | null;
  /** Biens VIVANTS du compte liés à l'élément. */
  assetIds: number[];
  /** Équipements vivants liés. */
  equipmentIds: number[];
  /** Documents liés (liens, source d'origine). */
  fileIds: number[];
}

// ── Garde anti-blanchiment ─────────────────────────────────────────────────

const statut = (s: string | null | undefined): 'realise' | 'annule' | null =>
  s === 'realise' || s === 'annule' ? s : null;

/** Contenu de l'élément porté par l'utilisateur (voir l'en-tête). Pure. */
export function isUserAuthoredAgendaItem(i: Pick<AgendaSourceItem, 'isAutomatic' | 'isAutomaticModified' | 'manualStatus' | 'statusByUser'>): boolean {
  if (!i.isAutomatic) return true;
  if (i.isAutomaticModified) return true;
  return statut(i.manualStatus) !== null && i.statusByUser;
}

// ── Intention : intervention décidée, pas un rappel ────────────────────────

/** Familles d'actes d'intervention (mot normalisé → famille). */
const FAMILLES: ReadonlyArray<[RegExp, string]> = [
  [/^(entretien|entretenir|revision|reviser|maintenance)$/, 'entretien'],
  [/^(reparation|reparations|reparer|depannage|depanner)$/, 'reparation'],
  [/^(controle|diagnostic|inspection|verification)$/, 'controle'],
  [/^(remplacement|remplacer|changement)$/, 'remplacement'],
  [/^(installation|installer|pose|poser|montage)$/, 'installation'],
  [/^(travaux|renovation|chantier)$/, 'travaux'],
  [/^vidange$/, 'vidange'],
  [/^ramonage$/, 'ramonage'],
  [/^(nettoyage|detartrage|desembouage)$/, 'nettoyage'],
  [/^(elagage|taille)$/, 'elagage'],
  [/^intervention$/, 'intervention'],
];

/** Types métier de l'agenda qui décrivent une intervention (catalogue). */
const INTERVENTION_BUSINESS_TYPES: readonly string[] = ['maintenance', 'repair', 'inspection', 'dpe'];

/** Rappel / démarche préalable : pas un acte décidé (3.2, F-020). */
const RAPPEL = /\b(penser|pense|rappel|rappeler|oublier|oublie|verifier|verif|regarder|voir si|demander|demande|devis|appeler|telephoner|relancer|contacter|prendre rdv|prendre rendez vous|reserver|reflechir|comparer|chercher|trouver|eventuellement|peut etre|envisager|a prevoir|a planifier|a faire|todo)\b/;
/** Échéance : une date limite n'est pas une intervention planifiée (3.2). */
const ECHEANCE = /\b(avant|au plus tard|echeance|limite|expire|expiration|fin de|renouveler|renouvellement|validite)\b/;
/** Réalisation dite par l'intitulé (F-022 « vidange faite aujourd'hui »). */
const FAIT = /\b(fait|faite|faits|faites|effectue|effectuee|effectues|effectuees|realise|realisee|realises|realisees|termine|terminee|termines|terminees)\b/;

const MOTS_VIDES = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'd', 'l', 'au', 'aux', 'a', 'et', 'ou', 'en', 'sur', 'pour', 'par', 'avec', 'chez',
  'prevu', 'prevue', 'prevus', 'prevues', 'planifie', 'planifiee', 'aujourd', 'hui', 'demain', 'matin', 'soir', 'apres', 'midi',
  'mon', 'ma', 'mes', 'notre', 'nos', 'votre', 'vos', 'son', 'sa', 'ses',
]);

const motsDe = (texte: string): string[] => normalizeText(texte).split(' ').filter((m) => m.length >= 2);

/** Familles d'intervention citées par un texte. */
function interventionFamilies(texte: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const m of motsDe(texte ?? '')) for (const [re, f] of FAMILLES) if (re.test(m)) out.add(f);
  return out;
}

/** Mots « objet » significatifs (chaudière, toiture…) hors familles, mots vides, chiffres, mots d'état. */
function objectWords(texte: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const m of motsDe(texte ?? '')) {
    if (m.length < 4 || /^\d+$/.test(m) || MOTS_VIDES.has(m) || FAIT.test(m)) continue;
    if (FAMILLES.some(([re]) => re.test(m))) continue;
    out.add(m);
  }
  return out;
}

type AgendaIntent =
  | { kind: 'INTERVENTION'; status: Extract<BusinessOperationStatus, 'ENVISAGED' | 'REALIZED'> }
  | { kind: 'NONE'; reason: 'NOT_USER_ENTERED' | 'NO_DATE' | 'NO_ASSET' | 'CANCELLED' | 'REMINDER' | 'DEADLINE' | 'NOT_AN_INTERVENTION' };

/** L'intitulé (ou le type métier) décrit-il une intervention, hors rappel et échéance ? Pure. */
function describesIntervention(i: Pick<AgendaSourceItem, 'title' | 'businessType'>): AgendaIntent {
  const t = normalizeText(i.title);
  if (RAPPEL.test(t) || i.title.includes('?')) return { kind: 'NONE', reason: 'REMINDER' };
  if (ECHEANCE.test(t)) return { kind: 'NONE', reason: 'DEADLINE' };
  const familles = interventionFamilies(i.title);
  const parType = i.businessType !== null && INTERVENTION_BUSINESS_TYPES.includes(i.businessType);
  if (!familles.size && !parType) return { kind: 'NONE', reason: 'NOT_AN_INTERVENTION' };
  return { kind: 'INTERVENTION', status: 'ENVISAGED' };
}

/** Statut que l'élément affirme (réalisé posé, fait historique, intitulé « fait »). Pure. */
export function agendaItemStatus(i: Pick<AgendaSourceItem, 'manualStatus' | 'nature' | 'title'>): BusinessOperationStatus {
  const s = statut(i.manualStatus);
  if (s === 'realise') return 'REALIZED';
  if (s === 'annule') return 'CANCELLED';
  if (i.nature === 'HISTORICAL') return 'REALIZED';
  return FAIT.test(normalizeText(i.title)) ? 'REALIZED' : 'ENVISAGED';
}

/**
 * Un élément NON relié établit-il une INTERVENTION (création, C5) ? Règles
 * fermées de l'en-tête. Pure.
 */
export function agendaEstablishesIntervention(i: AgendaSourceItem): AgendaIntent {
  if (i.isAutomatic) return { kind: 'NONE', reason: 'NOT_USER_ENTERED' };
  if (statut(i.manualStatus) === 'annule') return { kind: 'NONE', reason: 'CANCELLED' };
  if (!i.date) return { kind: 'NONE', reason: 'NO_DATE' };
  if (!i.assetIds.length) return { kind: 'NONE', reason: 'NO_ASSET' };
  const d = describesIntervention(i);
  if (d.kind === 'NONE') return d;
  const s = agendaItemStatus(i);
  return { kind: 'INTERVENTION', status: s === 'REALIZED' ? 'REALIZED' : 'ENVISAGED' };
}

/**
 * Pré-filtre du déclencheur (C4 TRG-012, sans base) : un geste utilisateur
 * sur un élément NON relié mérite-t-il un passage T3 ? Mêmes règles que la
 * création, sur les champs connus de l'appelant. Pure.
 */
export function agendaItemMayEstablishOperation(i: {
  isAutomatic: boolean; title: string; startDate: string | null; manualStatus: string | null; assetCount: number; businessType?: string | null;
}): boolean {
  if (i.isAutomatic || !i.startDate || i.assetCount === 0 || statut(i.manualStatus) === 'annule') return false;
  return describesIntervention({ title: i.title, businessType: i.businessType ?? null }).kind === 'INTERVENTION';
}

// ── Identité et contribution ───────────────────────────────────────────────

/** Version d'une contribution (source_version) : change à chaque modification pertinente (C2). */
export function agendaSourceVersion(i: AgendaSourceItem): string {
  const h = createHash('sha256').update(JSON.stringify([
    i.title, i.date, i.endDate, statut(i.manualStatus), i.statusByUser, i.isAutomaticModified, i.nature,
    [...i.assetIds].sort((a, b) => a - b), [...i.equipmentIds].sort((a, b) => a - b),
  ])).digest('hex').slice(0, 32);
  return `ag1:${h}`;
}

/**
 * Identité candidate d'un élément (même forme qu'un candidat T1 : même
 * machine C5 / C6 / C7). `today` : AAAA-MM-JJ. Pure.
 */
export function agendaIdentity(i: AgendaSourceItem, status: BusinessOperationStatus, today: string): CandidateIdentity {
  const date = i.date;
  const prevue = i.nature !== 'HISTORICAL' ? date : null;
  // C16.1 : une réalisation future n'a pas de date connue (rien d'inventé).
  const realisee = status === 'REALIZED' && date !== null && date <= today ? date : null;
  return {
    candidateId: 0,
    candidateKey: `AGENDA:${i.id}`,
    fileId: 0,
    established: true,
    confidence: 'certain',
    type: 'INTERVENTION',
    status,
    role: null,
    summary: i.title.replace(/\s+/g, ' ').trim().slice(0, 200),
    provider: null,
    providerKey: null,
    assetIds: [...new Set(i.assetIds)].sort((a, b) => a - b),
    targetAuthority: 'USER',
    equipmentIds: [...new Set(i.equipmentIds)].sort((a, b) => a - b),
    refs: [],
    dates: {
      // C8 : la date prévue est conservée à la réalisation ; un historique n'a pas de date prévue.
      plannedDate: prevue,
      startDate: null,
      // La date de réalisation est appliquée par `applyAgendaAuthority` :
      // elle prime seulement si l'élément ENREGISTRE la réalisation, sinon
      // elle ne sert qu'à défaut d'une date prouvée par un document.
      realizedDate: null,
      endDate: null,
    },
    hints: [],
    agenda: {
      itemId: i.id,
      realizedDate: realisee,
      realizationRecord: i.nature === 'HISTORICAL' || FAIT.test(normalizeText(i.title)),
    },
  };
}

type AgendaContributionDecision =
  | { kind: 'CONTRIBUTES'; status: BusinessOperationStatus; identity: CandidateIdentity }
  | { kind: 'WITHDRAWN'; reason: 'ITEM_GONE' | 'NOT_USER_AUTHORED' | 'UNLINKED' | 'CANCELLED_OTHER_PROOF' | 'TYPE_NOT_SUPPORTED' };

/**
 * Contribution d'un élément à l'Opération `operationId` (reconsolidation).
 * `otherSupport` : l'Opération est soutenue par une autre source active que
 * les sources AGENDA (document, donnée saisie…). Pure.
 */
export function agendaContribution(
  item: AgendaSourceItem | null, p: { operationId: number; operationType: string | null; otherSupport: boolean; today: string },
): AgendaContributionDecision {
  if (!item) return { kind: 'WITHDRAWN', reason: 'ITEM_GONE' };
  if (p.operationType !== null && p.operationType !== 'INTERVENTION') return { kind: 'WITHDRAWN', reason: 'TYPE_NOT_SUPPORTED' };
  if (item.businessOperationId !== p.operationId) return { kind: 'WITHDRAWN', reason: 'UNLINKED' };
  if (!isUserAuthoredAgendaItem(item)) return { kind: 'WITHDRAWN', reason: 'NOT_USER_AUTHORED' };
  const status = agendaItemStatus(item);
  if (status === 'CANCELLED' && p.otherSupport) return { kind: 'WITHDRAWN', reason: 'CANCELLED_OTHER_PROOF' };
  return { kind: 'CONTRIBUTES', status, identity: agendaIdentity(item, status, p.today) };
}

/**
 * Autorité de la saisie Agenda sur le fait qu'elle porte (C19, B9 niveau 1)
 * — pure, appliquée à l'état consolidé d'une INTERVENTION :
 *   · date prévue : celle de l'élément (la plus récente source AGENDA) ;
 *   · date de réalisation (Opération réalisée) : celle d'un élément qui
 *     ENREGISTRE la réalisation (fait historique corrigé, « vidange faite »)
 *     prime ; celle d'une échéance marquée « réalisé » ne sert qu'à défaut
 *     d'une date prouvée (la facture dit mieux le jour de la prestation) ;
 *   · cibles : un élément ne recible pas une Opération que d'autres sources
 *     prouvent (ses biens / équipements ne valent que pour une Opération
 *     établie par l'agenda seul).
 */
export function applyAgendaAuthority(
  state: ConsolidatedState, sources: readonly SourceContribution[],
  /** D'autres sources (même non gérées par T3) prouvent l'Opération. */
  otherSupport = false,
): ConsolidatedState {
  const agenda = sources.filter((s) => s.identity.agenda).sort((a, b) => b.sourceId - a.sourceId);
  if (!agenda.length || (state.type !== null && state.type !== 'INTERVENTION')) return state;
  const out: ConsolidatedState = { ...state };
  const prevue = agenda.find((s) => s.identity.dates.plannedDate);
  if (prevue) out.plannedDate = prevue.identity.dates.plannedDate;
  if (state.status === 'REALIZED') {
    const faites = agenda.filter((s) => s.identity.status === 'REALIZED' && s.identity.agenda?.realizedDate);
    const enregistrement = faites.find((s) => s.identity.agenda!.realizationRecord);
    if (enregistrement) out.realizedDate = enregistrement.identity.agenda!.realizedDate;
    else if (out.realizedDate === null && faites.length) out.realizedDate = faites[0].identity.agenda!.realizedDate;
  }
  const autres = sources.filter((s) => !s.identity.agenda);
  if (!autres.length && otherSupport) {
    // Preuves non gérées par T3 (saisie, migration) : l'élément ne pose aucune cible.
    const ids = new Set(agenda.map((s) => s.sourceId));
    out.assets = state.assets.filter((a) => !ids.has(a.sourceId));
    out.equipments = state.equipments.filter((e) => !ids.has(e.sourceId));
  } else if (autres.length) {
    // Cibles recalculées sur les SEULES autres sources (même règle que l'état
    // consolidé : une cible explicite prime sur un rattachement inféré, C10).
    const assets: ConsolidatedState['assets'] = [];
    const vus = new Set<number>();
    for (const s of [...autres].sort((a, b) => a.sourceId - b.sourceId)) {
      for (const a of s.identity.assetIds) {
        if (vus.has(a)) continue;
        vus.add(a);
        assets.push({ assetId: a, sourceId: s.sourceId, authority: s.identity.targetAuthority ?? 'INFERENCE' });
      }
    }
    const explicites = assets.filter((a) => a.authority !== 'INFERENCE');
    if (assets.length) out.assets = explicites.length ? explicites : assets;
    const ids = new Set(agenda.map((s) => s.sourceId));
    out.equipments = state.equipments.filter((e) => !ids.has(e.sourceId));
  }
  return out;
}

// ── Rapprochement d'un élément non relié (C16.1, C7.2) ─────────────────────

/** Opération INTERVENTION candidate au rapprochement d'un élément. */
export interface AgendaMatchOperation {
  id: number;
  status: BusinessOperationStatus;
  plannedDate: string | null;
  realizedDate: string | null;
  technicalLabel: string | null;
  assetIds: number[];
  documentFileIds: number[];
  /** Un AUTRE élément saisi / corrigé par l'utilisateur la représente déjà. */
  hasOtherUserItem: boolean;
}

/** Tolérance d'un rapprochement certain (même nature d'état). */
const AGENDA_MATCH_DAYS = 3;
/** Élément prévu ↔ Opération réalisée (ou l'inverse). */
const AGENDA_MATCH_CROSS_DAYS = 7;
/** Même document lié, date différente : rapprochement certain jusqu'ici. */
const AGENDA_SAME_DOCUMENT_DAYS = 30;

const JOUR = 86_400_000;
const ecart = (a: string, b: string) => Math.abs(Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / JOUR));

/** Même acte ? `same` (familles ou objet communs), `distinct` (familles disjointes, aucun objet commun), sinon `unknown`. */
export function sameIntervention(a: string | null, b: string | null): 'same' | 'distinct' | 'unknown' {
  const fa = interventionFamilies(a);
  const fb = interventionFamilies(b);
  fa.delete('intervention');
  fb.delete('intervention');
  const oa = objectWords(a);
  const ob = objectWords(b);
  if ([...fa].some((f) => fb.has(f)) || [...oa].some((o) => ob.has(o))) return 'same';
  if (fa.size && fb.size) return 'distinct';
  return 'unknown';
}

type AgendaMatch =
  | { kind: 'MATCH'; operationId: number; reason: string }
  | { kind: 'HOLD'; reason: string; operationIds: number[] }
  | { kind: 'NONE' };

/**
 * Opération qui représente DÉJÀ l'intervention de l'élément (pure) :
 *   · même document lié (preuve de l'Opération) à ±30 j, ou sans date →
 *     certain ;
 *   · même bien, même acte (`sameIntervention`), date à ±3 j (±7 j entre un
 *     prévu et un réalisé) → certain ;
 *   · même bien, acte inconnu d'un côté, ou date proche au-delà de la
 *     tolérance (jusqu'au double), ou Opération sans date de même acte, ou
 *     déjà représentée par un autre élément de l'utilisateur → PLAUSIBLE ;
 *   · un seul certain → MATCH ; plusieurs certains, ou un plausible sans
 *     certain → HOLD (ni rattachement hasardeux, ni doublon, EXH-004) ;
 *   · aucun → NONE (la machine C5 / C6 décide alors de la création).
 * Une Opération ANNULÉE n'est jamais rapprochée (un nouvel élément est un
 * nouveau projet).
 */
export function matchAgendaItem(item: AgendaSourceItem, status: BusinessOperationStatus, ops: readonly AgendaMatchOperation[]): AgendaMatch {
  if (!item.date) return { kind: 'NONE' };
  const certains: Array<{ id: number; reason: string }> = [];
  const plausibles: number[] = [];
  const fichiers = new Set(item.fileIds);
  const biens = new Set(item.assetIds);
  for (const op of ops) {
    if (op.status === 'CANCELLED') continue;
    const memeDoc = op.documentFileIds.some((f) => fichiers.has(f));
    const memeBien = op.assetIds.some((a) => biens.has(a));
    if (!memeDoc && !memeBien) continue;
    const dateOp = op.status === 'REALIZED' ? op.realizedDate ?? op.plannedDate : op.plannedDate;
    const g = dateOp ? ecart(dateOp, item.date) : null;
    const acte = sameIntervention(item.title, op.technicalLabel);
    if (memeDoc && (g === null || g <= AGENDA_SAME_DOCUMENT_DAYS)) {
      if (op.hasOtherUserItem) plausibles.push(op.id);
      else certains.push({ id: op.id, reason: `même document${g !== null ? `, écart ${g} j` : ''}` });
      continue;
    }
    if (acte === 'distinct') continue;
    const croise = (status === 'REALIZED') !== (op.status === 'REALIZED');
    const tol = croise ? AGENDA_MATCH_CROSS_DAYS : AGENDA_MATCH_DAYS;
    if (g === null) {
      if (acte === 'same') plausibles.push(op.id);
      continue;
    }
    if (g <= tol && acte === 'same' && !op.hasOtherUserItem) {
      certains.push({ id: op.id, reason: `même bien, même intervention, écart ${g} j` });
    } else if (g <= tol * 2) {
      plausibles.push(op.id);
    }
  }
  // Un seul certain : il l'emporte sur des plausibles (même règle que C6 : le certain tranche).
  if (certains.length === 1) return { kind: 'MATCH', operationId: certains[0].id, reason: certains[0].reason };
  if (certains.length > 1) return { kind: 'HOLD', reason: 'AGENDA_SEVERAL_OPERATIONS', operationIds: certains.map((c) => c.id) };
  if (plausibles.length) return { kind: 'HOLD', reason: 'AGENDA_PLAUSIBLE_OPERATION', operationIds: [...new Set(plausibles)] };
  return { kind: 'NONE' };
}
