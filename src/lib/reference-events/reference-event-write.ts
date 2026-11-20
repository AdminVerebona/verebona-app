/**
 * Carte #744, travaux D — ÉCRITURE (CDC « Opérations / Agenda V2.0 » §14,
 * §19, §20 ; AC41, AC44, AC45, AC47, AC48 pour leur partie « page ») —
 * gestes d'écriture de la PAGE d'un événement de référence : textes, lecture
 * des demandes et traduction des résultats. PUR (aucune dépendance serveur) :
 * partagé par les routes, les composants et les tests.
 *
 * Règles :
 *   · chaque résultat de la façade (`OperationWriteResult`) est traduit en
 *     une phrase pour l'utilisateur — jamais un code brut à l'écran. La table
 *     `REFERENCE_EVENT_WRITE_MESSAGES` couvre TOUS les codes (type exhaustif) ;
 *   · le mot « Opération » n'apparaît jamais ;
 *   · aucune règle métier ici : la façade décide. Ce fichier ne fait que
 *     lire une demande (forme, bornes) et nommer le résultat ;
 *   · décisions du PO du 15/11/2026 : (1) la suppression s'annule SANS
 *     rattacher de nouveau les événements de l'Agenda détachés — la
 *     confirmation le dit avant ; (2) corriger l'intitulé ne demande ni
 *     déclaration ni motif.
 *
 * Tous les textes de ce fichier sont NOUVEAUX : « à valider par le PO »
 * (fiche de recette 114O, section « Travaux D — écriture »).
 */
import type { OperationWriteCode, OperationWriteResult } from '@/services/business-operations/graph/model';
import type { ReferenceEventDateRole, ReferenceEventRelationDirection } from './reference-event-page';

// ── Gestes ─────────────────────────────────────────────────────────────────

export const REFERENCE_EVENT_GESTURES = [
  'correct', 'delete', 'restore', 'linkAgenda', 'unlinkAgenda', 'linkDocument', 'unlinkDocument',
  'linkSupplier', 'unlinkSupplier', 'associate', 'dissociate', 'split',
  // Carte #744, travaux D — contenu : la note libre de l'utilisateur, enregistrée ou retirée (deux réussites distinctes).
  'notes', 'notesCleared',
] as const;
export type ReferenceEventGesture = (typeof REFERENCE_EVENT_GESTURES)[number];

/** Message de réussite de chaque geste (une écriture a eu lieu). */
export const REFERENCE_EVENT_SUCCESS: Readonly<Record<ReferenceEventGesture, string>> = {
  correct: 'Correction enregistrée.',
  delete: 'Opération supprimée.',
  restore: 'Suppression annulée. Les événements de l’Agenda détachés n’ont pas été rattachés de nouveau.',
  linkAgenda: 'Événement rattaché.',
  unlinkAgenda: 'Événement détaché. Il reste dans votre agenda.',
  linkDocument: 'Document rattaché.',
  unlinkDocument: 'Document retiré de cette opération. Le fichier est conservé.',
  linkSupplier: 'Fournisseur relié.',
  unlinkSupplier: 'Fournisseur retiré de cette opération. Sa fiche est conservée.',
  associate: 'Opérations associées.',
  dissociate: 'Opérations dissociées.',
  split: 'Opération scindée. La nouvelle est associée à celle-ci.',
  notes: 'Note enregistrée.',
  notesCleared: 'Note retirée.',
};

/** Phrase utilisateur de CHAQUE code de résultat de la façade (exhaustif : un code ajouté ne compile pas sans son texte). */
export const REFERENCE_EVENT_WRITE_MESSAGES: Readonly<Record<OperationWriteCode, string>> = {
  OK: 'Modification enregistrée.',
  NO_CHANGE: 'Rien n’a changé : c’était déjà enregistré ainsi.',
  NEW_EVIDENCE_AFTER_REFUSAL: 'Ce lien avait été refusé. Il doit d’abord être confirmé dans « À traiter ».',
  VERSION_MISMATCH: 'Cette opération a été modifiée entre-temps. La fiche vient d’être actualisée : vérifiez-la, puis recommencez si besoin.',
  IDEMPOTENCY_KEY_REUSED: 'Cette demande a déjà été envoyée. Actualisez la fiche avant de recommencer.',
  INVALID_INPUT: 'La saisie n’est pas valide. Vérifiez les champs, puis réessayez.',
  READ_ONLY_ACCOUNT: 'Votre compte est en lecture seule : cette modification n’est pas possible.',
  NOT_A_MEMBER: 'Vous n’avez pas accès à ce compte.',
  NOT_FOUND_IN_ACCOUNT: 'Cet élément est introuvable dans votre compte.',
  OPERATION_INACTIVE: 'Cette opération a été supprimée ou regroupée : elle ne peut plus être modifiée.',
  REFLEXIVE: 'Une opération ne peut pas être reliée à elle-même.',
  NATURE_TYPE_MISMATCH: 'Ce lien ne correspond pas au type de ces opérations. Choisissez « Associée à ».',
  EVIDENCE_REQUIRED: 'Cette action n’est pas possible ici.',
  USER_REJECTED: 'Ce lien a été refusé : il n’est pas recréé.',
  USER_RELATION_PROTECTED: 'Ce lien a été posé par vous : il n’est pas modifié automatiquement.',
  LINKED_ELSEWHERE: 'Cet événement de l’Agenda est déjà rattaché ailleurs et n’a pas pu être partagé.',
  NOT_LINKED: 'Ce document n’est pas rattaché à cette opération.',
  SPLIT_PART_NOT_LINKED: 'Un des éléments choisis n’est plus rattaché à cette opération. La fiche vient d’être actualisée : refaites votre choix.',
  SPLIT_NOTHING_TO_MOVE: 'Choisissez au moins un élément à déplacer vers la nouvelle opération.',
  TYPE_MISMATCH: 'Ces deux opérations ne sont pas de même nature : elles ne peuvent pas être réunies. Rien n’a été modifié.',
  USER_ONLY: 'Cette action n’est pas possible ici.',
  TYPE_DETAILS_PRESENT: 'Le type ne peut pas être changé : cette opération porte des informations propres à son type actuel (contrat, financement ou sinistre).',
  STATUS_TRANSITION_REFUSED: 'Cette action n’est pas possible ici.',
  NOT_RESTORABLE: 'Cette suppression ne peut plus être annulée.',
  DUPLICATE_DECLARATION: 'Cette déclaration est déjà enregistrée.',
  TECHNICAL_FAILURE: 'L’enregistrement n’a pas abouti. Rien n’a été modifié. Réessayez dans un instant.',
};

/**
 * Carte #806 §1 (décision du PO du 17/11/2026) : le geste « Déplacer un document vers une autre opération » est
 * RETIRÉ (écran, API, Assistant). Un ancien client qui appelle encore la route reçoit cette phrase : rien n'est écrit.
 */
export const REFERENCE_EVENT_MOVE_REMOVED = 'Le déplacement direct d’un document n’existe plus. Retirez le document de cette opération, puis rattachez-le à l’autre opération.';

/** Requête illisible (corps absent, identifiant invalide) : même phrase que INVALID_INPUT. */
export const REFERENCE_EVENT_INVALID_REQUEST = REFERENCE_EVENT_WRITE_MESSAGES.INVALID_INPUT;

export interface ReferenceEventWriteOutcome {
  /** Statut HTTP de la réponse. */
  http: number;
  ok: boolean;
  changed: boolean;
  /** Phrase affichée à l'utilisateur (jamais un code). */
  message: string;
  /** Code générique de l'API (`apiError`) pour un refus ; null pour une réussite. */
  apiCode: 'INVALID_INPUT' | 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_STATE' | 'INTERNAL_ERROR' | null;
}

/**
 * Traduit le résultat d'une commande de la façade pour la réponse de la
 * route : statut HTTP, phrase utilisateur. Réussite : 200 (avec ou sans
 * écriture) ; version périmée, clé réutilisée, arbitrage requis, événement
 * supprimé : 409 ; introuvable dans le compte : 404 ; droits : 403 ; saisie
 * ou règle d'intégrité : 422 ; panne : 500 (rien n'a été écrit).
 */
export function referenceEventWriteOutcome(gesture: ReferenceEventGesture, r: Pick<OperationWriteResult<unknown>, 'status' | 'code' | 'changed'>): ReferenceEventWriteOutcome {
  const texte = REFERENCE_EVENT_WRITE_MESSAGES[r.code] ?? REFERENCE_EVENT_WRITE_MESSAGES.TECHNICAL_FAILURE;
  if (r.status === 'APPLIED') {
    return { http: 200, ok: true, changed: r.changed, message: r.changed ? REFERENCE_EVENT_SUCCESS[gesture] : REFERENCE_EVENT_WRITE_MESSAGES.NO_CHANGE, apiCode: null };
  }
  if (r.status === 'FAILED') return { http: 500, ok: false, changed: false, message: REFERENCE_EVENT_WRITE_MESSAGES.TECHNICAL_FAILURE, apiCode: 'INTERNAL_ERROR' };
  if (r.status === 'CONFLICT' || r.status === 'ARBITRATION_REQUIRED') return { http: 409, ok: false, changed: false, message: texte, apiCode: 'INVALID_STATE' };
  if (r.code === 'NOT_FOUND_IN_ACCOUNT') return { http: 404, ok: false, changed: false, message: texte, apiCode: 'NOT_FOUND' };
  if (r.code === 'READ_ONLY_ACCOUNT' || r.code === 'NOT_A_MEMBER') return { http: 403, ok: false, changed: false, message: texte, apiCode: 'FORBIDDEN' };
  if (r.code === 'OPERATION_INACTIVE' || r.code === 'NOT_RESTORABLE') return { http: 409, ok: false, changed: false, message: texte, apiCode: 'INVALID_STATE' };
  return { http: 422, ok: false, changed: false, message: texte, apiCode: 'INVALID_INPUT' };
}

/** Corps d'une réponse d'écriture réussie. */
export interface ReferenceEventWriteResponse {
  ok: true;
  changed: boolean;
  message: string;
  /** Version de l'événement de référence après le geste, quand la commande la rend (corriger, supprimer, annuler). */
  version: number | null;
  /** Événement de référence CRÉÉ par le geste (scission) : la page propose de l'ouvrir. Absent sinon. */
  newOperationId?: number | null;
}

// ── Lecture des demandes (forme et bornes seulement) ───────────────────────

const estObjet = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Identifiant entier positif porté par un corps JSON ou un paramètre d'adresse ; null sinon. */
export function positiveIdOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? v : null;
  if (typeof v === 'string' && /^\d{1,15}$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

/** Version attendue : absente (undefined) ou entier positif ; null : invalide. */
export function expectedVersionOf(v: unknown): number | undefined | null {
  if (v === undefined || v === null || v === '') return undefined;
  return positiveIdOf(v);
}

/** Champ de date de la façade pour chaque rôle de date affiché par la page. */
export const REFERENCE_EVENT_DATE_FIELDS: Readonly<Record<ReferenceEventDateRole, 'plannedDate' | 'startDate' | 'realizedDate' | 'endDate'>> = {
  PLANNED: 'plannedDate', START: 'startDate', REALIZED: 'realizedDate', END: 'endDate',
};

export const REFERENCE_EVENT_LABEL_MAX = 200;

export interface ReferenceEventCorrection {
  expectedVersion?: number;
  label?: string;
  /** Code du type choisi dans le référentiel (validé par la route contre le référentiel). */
  typeCode?: string;
  dates?: Partial<Record<'plannedDate' | 'startDate' | 'realizedDate' | 'endDate', string>>;
}

/**
 * Lit la demande « corriger » : seuls l'intitulé, le type et les dates par
 * rôle sont admis ; chaque champ fourni porte une valeur (on POSE, on
 * n'efface pas) ; au moins un champ. null : demande invalide. La valeur des
 * dates et du type est contrôlée par la façade (date réelle, référentiel).
 */
export function parseReferenceEventCorrection(body: unknown): ReferenceEventCorrection | null {
  if (!estObjet(body)) return null;
  const admis = new Set(['expectedVersion', 'label', 'typeCode', 'dates']);
  if (Object.keys(body).some((k) => !admis.has(k))) return null;
  const out: ReferenceEventCorrection = {};
  const version = expectedVersionOf(body.expectedVersion);
  if (version === null) return null;
  if (version !== undefined) out.expectedVersion = version;
  if (body.label !== undefined) {
    if (typeof body.label !== 'string') return null;
    const t = body.label.replace(/\s+/g, ' ').trim();
    if (!t || t.length > REFERENCE_EVENT_LABEL_MAX) return null;
    out.label = t;
  }
  if (body.typeCode !== undefined) {
    if (typeof body.typeCode !== 'string' || !/^[A-Z_]{2,40}$/.test(body.typeCode)) return null;
    out.typeCode = body.typeCode;
  }
  if (body.dates !== undefined) {
    if (!estObjet(body.dates)) return null;
    const champs = new Set<string>(Object.values(REFERENCE_EVENT_DATE_FIELDS));
    const dates: NonNullable<ReferenceEventCorrection['dates']> = {};
    for (const [k, v] of Object.entries(body.dates)) {
      if (!champs.has(k) || typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
      dates[k as keyof typeof dates] = v;
    }
    if (Object.keys(dates).length) out.dates = dates;
  }
  if (out.label === undefined && out.typeCode === undefined && out.dates === undefined) return null;
  return out;
}

/** État du formulaire « Corriger » (dates au format AAAA-MM-JJ, '' : champ vide). */
export interface ReferenceEventCorrectionForm {
  label: string;
  /** Code du type choisi ; '' : aucun choix. */
  typeCode: string;
  dates: Readonly<Record<ReferenceEventDateRole, string>>;
}

/** Ce que la page affiche avant correction (lu dans la fiche). */
export interface ReferenceEventCorrectionCurrent {
  version: number;
  ownLabel: string | null;
  typeCode: string | null;
  dates: ReadonlyArray<{ role: ReferenceEventDateRole; date: string }>;
}

/** Formulaire prérempli avec l'état affiché. */
export function referenceEventCorrectionForm(current: ReferenceEventCorrectionCurrent): ReferenceEventCorrectionForm {
  const date = (role: ReferenceEventDateRole): string => current.dates.find((d) => d.role === role)?.date ?? '';
  return {
    label: current.ownLabel ?? '', typeCode: current.typeCode ?? '',
    dates: { PLANNED: date('PLANNED'), START: date('START'), REALIZED: date('REALIZED'), END: date('END') },
  };
}

/**
 * Demande « corriger » à envoyer : SEULEMENT ce qui a changé, avec la version
 * que la page a lue. Refus dits à l'utilisateur avant tout envoi : effacer un
 * intitulé ou une date déjà enregistrés (la correction pose, elle n'efface
 * pas), intitulé trop long, aucune modification.
 */
export function buildReferenceEventCorrection(
  current: ReferenceEventCorrectionCurrent, form: ReferenceEventCorrectionForm,
): { ok: true; body: ReferenceEventCorrection } | { ok: false; error: string } {
  const L = REFERENCE_EVENT_WRITE_LABELS;
  const body: ReferenceEventCorrection = { expectedVersion: current.version };
  const label = form.label.replace(/\s+/g, ' ').trim();
  if (!label && current.ownLabel) return { ok: false, error: L.labelEraseRefused };
  if (label.length > REFERENCE_EVENT_LABEL_MAX) return { ok: false, error: L.labelTooLong };
  if (label && label !== current.ownLabel) body.label = label;
  if (form.typeCode && form.typeCode !== current.typeCode) body.typeCode = form.typeCode;
  const dates: NonNullable<ReferenceEventCorrection['dates']> = {};
  for (const role of Object.keys(REFERENCE_EVENT_DATE_FIELDS) as ReferenceEventDateRole[]) {
    const avant = current.dates.find((d) => d.role === role)?.date ?? '';
    const apres = form.dates[role].trim();
    if (!apres && avant) return { ok: false, error: L.dateEraseRefused };
    if (apres && apres !== avant) dates[REFERENCE_EVENT_DATE_FIELDS[role]] = apres;
  }
  if (Object.keys(dates).length) body.dates = dates;
  if (body.label === undefined && body.typeCode === undefined && body.dates === undefined) return { ok: false, error: L.nothingToSave };
  return { ok: true, body };
}

// ── Scission (CDC §7, §14 ; AC46) ──────────────────────────────────────────

/** Natures de faits qu'une scission peut déplacer, dans l'ordre d'affichage de la fenêtre. */
export const REFERENCE_EVENT_SPLIT_PARTS = ['agenda', 'document', 'supplier'] as const;
export type ReferenceEventSplitPart = (typeof REFERENCE_EVENT_SPLIT_PARTS)[number];

export interface ReferenceEventSplitRequest {
  expectedVersion?: number;
  /** Intitulé du nouvel événement de référence. */
  label?: string;
  agendaItemIds?: number[];
  fileIds?: number[];
  supplierIds?: number[];
}

/** Liste d'identifiants d'une part de scission : bornée, dédoublonnée, ordre d'affichage conservé. `null` : invalide. */
const idArray = (v: unknown): number[] | null => {
  if (!Array.isArray(v) || v.length > 100) return null;
  const out: number[] = [];
  for (const x of v) {
    const id = positiveIdOf(x);
    if (id === null) return null;
    if (!out.includes(id)) out.push(id);
  }
  return out;
};

/**
 * Lit la demande « scinder » : intitulé du nouvel événement de référence et
 * listes de faits qui partent (événements de l'Agenda, justificatifs,
 * fournisseurs). Au moins un fait. null : demande invalide. Le rattachement
 * réel de chaque fait, les droits et la version sont contrôlés par la façade.
 */
export function parseReferenceEventSplit(body: unknown): ReferenceEventSplitRequest | null {
  if (!estObjet(body)) return null;
  const admis = new Set(['expectedVersion', 'label', 'agendaItemIds', 'fileIds', 'supplierIds']);
  if (Object.keys(body).some((k) => !admis.has(k))) return null;
  const out: ReferenceEventSplitRequest = {};
  const version = expectedVersionOf(body.expectedVersion);
  if (version === null) return null;
  if (version !== undefined) out.expectedVersion = version;
  if (body.label !== undefined) {
    if (typeof body.label !== 'string') return null;
    const t = body.label.replace(/\s+/g, ' ').trim();
    if (!t || t.length > REFERENCE_EVENT_LABEL_MAX) return null;
    out.label = t;
  }
  let total = 0;
  for (const champ of ['agendaItemIds', 'fileIds', 'supplierIds'] as const) {
    if (body[champ] === undefined) continue;
    const ids = idArray(body[champ]);
    if (ids === null) return null;
    out[champ] = ids;
    total += ids.length;
  }
  if (total === 0) return null;
  return out;
}

/** Un fait de la fiche, désignable dans la fenêtre « Scinder ». */
export interface ReferenceEventSplitItem { part: ReferenceEventSplitPart; id: number; title: string }

/** Ce que la page affiche et qui peut partir (lu dans la fiche). */
export interface ReferenceEventSplitCurrent {
  version: number;
  agendaItems: ReadonlyArray<{ id: number; title: string }>;
  documents: ReadonlyArray<{ fileId: number; title: string }>;
  suppliers: ReadonlyArray<{ id: number; name: string }>;
}

/** État de la fenêtre « Scinder ». */
export interface ReferenceEventSplitForm {
  label: string;
  agendaItemIds: readonly number[];
  fileIds: readonly number[];
  supplierIds: readonly number[];
}

export const REFERENCE_EVENT_SPLIT_EMPTY_FORM: ReferenceEventSplitForm = { label: '', agendaItemIds: [], fileIds: [], supplierIds: [] };

/** Tous les faits de la fiche qui peuvent partir, par nature, dans l'ordre de la page. */
export function referenceEventSplitItems(current: ReferenceEventSplitCurrent): ReferenceEventSplitItem[] {
  return [
    ...current.agendaItems.map((a) => ({ part: 'agenda' as const, id: a.id, title: a.title })),
    ...current.documents.map((d) => ({ part: 'document' as const, id: d.fileId, title: d.title })),
    ...current.suppliers.map((s) => ({ part: 'supplier' as const, id: s.id, title: s.name })),
  ];
}

/** APERÇU avant d'écrire : ce qui part vers le nouvel événement de référence, ce qui reste sur celui-ci. */
export interface ReferenceEventSplitPreview {
  moved: ReferenceEventSplitItem[];
  kept: ReferenceEventSplitItem[];
}

const estDesigne = (form: ReferenceEventSplitForm, i: ReferenceEventSplitItem): boolean =>
  (i.part === 'agenda' ? form.agendaItemIds : i.part === 'document' ? form.fileIds : form.supplierIds).includes(i.id);

/** Aperçu de la scission (pur, sans serveur) : rien n'est encore écrit. */
export function referenceEventSplitPreview(current: ReferenceEventSplitCurrent, form: ReferenceEventSplitForm): ReferenceEventSplitPreview {
  const tout = referenceEventSplitItems(current);
  return { moved: tout.filter((i) => estDesigne(form, i)), kept: tout.filter((i) => !estDesigne(form, i)) };
}

/**
 * Demande « scinder » à envoyer, avec la version que la page a lue. Refus dits
 * à l'utilisateur AVANT tout envoi : aucun intitulé, intitulé trop long, aucun
 * fait désigné, et « tout ne peut pas partir » (un événement de référence
 * scindé de TOUT ce qu'il porte ne serait plus qu'une enveloppe vide : c'est
 * une suppression, pas une scission — choix par défaut n° 2 de ce passage).
 */
export function buildReferenceEventSplit(
  current: ReferenceEventSplitCurrent, form: ReferenceEventSplitForm,
): { ok: true; body: ReferenceEventSplitRequest; preview: ReferenceEventSplitPreview } | { ok: false; error: string } {
  const L = REFERENCE_EVENT_WRITE_LABELS;
  const label = form.label.replace(/\s+/g, ' ').trim();
  if (!label) return { ok: false, error: L.splitLabelRequired };
  if (label.length > REFERENCE_EVENT_LABEL_MAX) return { ok: false, error: L.labelTooLong };
  const preview = referenceEventSplitPreview(current, form);
  if (preview.moved.length === 0) return { ok: false, error: L.splitNothingChosen };
  if (preview.kept.length === 0) return { ok: false, error: L.splitAllChosen };
  const body: ReferenceEventSplitRequest = { expectedVersion: current.version, label };
  const agendaItemIds = preview.moved.filter((i) => i.part === 'agenda').map((i) => i.id);
  const fileIds = preview.moved.filter((i) => i.part === 'document').map((i) => i.id);
  const supplierIds = preview.moved.filter((i) => i.part === 'supplier').map((i) => i.id);
  if (agendaItemIds.length) body.agendaItemIds = agendaItemIds;
  if (fileIds.length) body.fileIds = fileIds;
  if (supplierIds.length) body.supplierIds = supplierIds;
  return { ok: true, body, preview };
}

// ── Association entre deux événements de référence ─────────────────────────

/** Natures qu'une association posée depuis la page peut porter (celles du graphe). */
export const REFERENCE_EVENT_ASSOCIATION_NATURES = ['ASSOCIATED', 'FINANCING', 'CLAIM_REPAIR'] as const;
export type ReferenceEventAssociationNature = (typeof REFERENCE_EVENT_ASSOCIATION_NATURES)[number];

/**
 * Type exigé de l'événement de référence d'ORIGINE d'un lien orienté — miroir,
 * pour l'écran, de `RELATION_SOURCE_TYPE` (`graph/model.ts`, qui fait foi et
 * refuse tout écart : test d'alignement `l114o-fiche-ecriture.test.ts`).
 */
export const REFERENCE_EVENT_ASSOCIATION_SOURCE_TYPE: Readonly<Record<ReferenceEventAssociationNature, string | null>> = {
  ASSOCIATED: null, FINANCING: 'FINANCING', CLAIM_REPAIR: 'CLAIM',
};

export interface ReferenceEventAssociationOption {
  nature: ReferenceEventAssociationNature;
  /** Sens lu depuis la page : OUTGOING = cet événement de référence est l'origine du lien. */
  direction: ReferenceEventRelationDirection;
}

/**
 * Liens proposables entre la page (`selfType`) et l'événement de référence
 * choisi (`otherType`) : toujours « Associée à » ; un lien orienté seulement
 * quand son origine a le type exigé (intégrité : la façade le recontrôle).
 */
export function referenceEventAssociationOptions(selfType: string | null, otherType: string | null): ReferenceEventAssociationOption[] {
  const out: ReferenceEventAssociationOption[] = [{ nature: 'ASSOCIATED', direction: 'UNDIRECTED' }];
  for (const nature of REFERENCE_EVENT_ASSOCIATION_NATURES) {
    const exige = REFERENCE_EVENT_ASSOCIATION_SOURCE_TYPE[nature];
    if (exige === null) continue;
    if (selfType === exige) out.push({ nature, direction: 'OUTGOING' });
    if (otherType === exige) out.push({ nature, direction: 'INCOMING' });
  }
  return out;
}

export interface ReferenceEventAssociationRequest {
  otherId: number;
  nature: ReferenceEventAssociationNature;
  direction: 'OUTGOING' | 'INCOMING' | 'UNDIRECTED';
}

/** Lit la demande « associer » ; null : invalide. Défaut : « Associée à ». */
export function parseReferenceEventAssociation(body: unknown): ReferenceEventAssociationRequest | null {
  if (!estObjet(body)) return null;
  const otherId = positiveIdOf(body.otherId);
  if (otherId === null) return null;
  const nature = body.nature === undefined ? 'ASSOCIATED' : body.nature;
  if (typeof nature !== 'string' || !(REFERENCE_EVENT_ASSOCIATION_NATURES as readonly string[]).includes(nature)) return null;
  const n = nature as ReferenceEventAssociationNature;
  const direction = body.direction === undefined ? (n === 'ASSOCIATED' ? 'UNDIRECTED' : 'OUTGOING') : body.direction;
  if (direction !== 'OUTGOING' && direction !== 'INCOMING' && direction !== 'UNDIRECTED') return null;
  // Un lien orienté a un sens ; « Associée à » n'en a pas.
  if ((n === 'ASSOCIATED') !== (direction === 'UNDIRECTED')) return null;
  return { otherId, nature: n, direction };
}

// ── Candidats (choix d'un objet à relier) ──────────────────────────────────

export const REFERENCE_EVENT_CANDIDATE_KINDS = ['agenda', 'document', 'supplier', 'reference'] as const;
export type ReferenceEventCandidateKind = (typeof REFERENCE_EVENT_CANDIDATE_KINDS)[number];

export function isReferenceEventCandidateKind(v: unknown): v is ReferenceEventCandidateKind {
  return typeof v === 'string' && (REFERENCE_EVENT_CANDIDATE_KINDS as readonly string[]).includes(v);
}

/** Nombre de candidats rendus par recherche ; au-delà, `more` invite à préciser. */
export const REFERENCE_EVENT_CANDIDATE_LIMIT = 20;

export interface ReferenceEventCandidate {
  id: number;
  title: string;
  /** Date propre de l'objet (événement, document, événement de référence) ; null : sans date. */
  date: string | null;
  /** Type de l'événement de référence candidat (liens orientés proposables) ; null pour les autres natures. */
  typeCode: string | null;
}

export interface ReferenceEventCandidateList {
  items: ReferenceEventCandidate[];
  /** D'autres résultats existent : l'écran invite à préciser la recherche (aucune limite silencieuse). */
  more: boolean;
}

/** Option du choix de type (référentiel des types, nom utilisateur existant). */
export interface ReferenceEventTypeOption { code: string; label: string }

// ── Textes de l'écran ──────────────────────────────────────────────────────

export const REFERENCE_EVENT_WRITE_LABELS = {
  // Corriger
  correct: 'Corriger',
  correctTitle: 'Corriger cette opération',
  correctHint: 'L’ancienne et la nouvelle valeur sont conservées dans l’historique. Aucune justification ne vous est demandée.',
  labelField: 'Intitulé',
  labelPlaceholder: 'Par exemple : Remplacement de la chaudière',
  typeField: 'Type',
  typeUnset: 'Non précisé',
  datesLegend: 'Dates',
  dateEraseRefused: 'Une date déjà enregistrée peut être remplacée, mais pas effacée ici.',
  labelEraseRefused: 'Un intitulé déjà enregistré peut être remplacé, mais pas effacé ici.',
  labelTooLong: 'L’intitulé ne peut pas dépasser 200 caractères.',
  nothingToSave: 'Aucune modification à enregistrer.',
  save: 'Enregistrer',
  cancel: 'Annuler',
  close: 'Fermer',
  // Supprimer / annuler
  delete: 'Supprimer',
  deleteTitle: 'Supprimer cette opération ?',
  deleteKept: 'Rien n’est effacé : ses documents, ses fournisseurs et les événements de l’Agenda que vous avez saisis sont conservés. Ces événements sont détachés et restent dans votre agenda, à leur date, avec leurs rappels.',
  deleteProjected: 'Les événements que Verebona avait ajoutés à votre agenda à partir de cette opération peuvent en être retirés.',
  deleteUndo: 'Vous pourrez annuler la suppression juste après. L’opération reviendra alors sans ses événements de l’Agenda : ils ne seront pas rattachés de nouveau.',
  deleteConfirm: 'Supprimer',
  deletedTitle: 'Opération supprimée',
  deletedBody: 'Ses documents, ses fournisseurs et vos événements de l’Agenda sont conservés.',
  deletedUndoHint: 'Si vous annulez, elle revient sans ses événements de l’Agenda : ils ne seront pas rattachés de nouveau. Cette possibilité disparaît si vous quittez ou rechargez cette page.',
  undoDelete: 'Annuler la suppression',
  // Relier
  addTitle: 'Compléter',
  linkAgenda: 'Rattacher un événement',
  linkDocument: 'Rattacher un document',
  linkSupplier: 'Relier un fournisseur',
  associate: 'Associer une opération',
  unlinkAgenda: 'Détacher',
  unlinkDocument: 'Retirer',
  unlinkSupplier: 'Retirer',
  dissociate: 'Dissocier',
  // Confirmations des retraits
  unlinkAgendaTitle: 'Détacher cet événement ?',
  unlinkAgendaBody: 'Seul le lien est retiré. L’événement reste dans votre agenda, à sa date, avec ses rappels et ses documents. Il ne sera pas rattaché de nouveau automatiquement.',
  unlinkDocumentTitle: 'Retirer ce document ?',
  unlinkDocumentBody: 'Seul le lien est retiré : le fichier est conservé, ainsi que ses autres rattachements. Il ne sera pas rattaché de nouveau automatiquement à cette opération.',
  unlinkSupplierTitle: 'Retirer ce fournisseur ?',
  unlinkSupplierBody: 'Seul le lien est retiré : la fiche du fournisseur et ses documents sont conservés. Il ne sera pas relié de nouveau automatiquement.',
  // Scinder (CDC §7, §14 ; AC46)
  split: 'Scinder',
  splitTitle: 'Scinder cette opération',
  splitHint: 'Choisissez ce qui appartient à une autre réalité : une seconde opération est créée et reçoit ce que vous désignez. Rien n’est effacé, rien n’est copié ; les deux restent associées.',
  splitLabelField: 'Intitulé de la nouvelle opération',
  splitLabelPlaceholder: 'Par exemple : Remplacement du ballon d’eau chaude',
  splitPartsLegend: 'Ce qui part vers la nouvelle opération',
  splitPartAgenda: 'Événements de l’Agenda',
  splitPartDocument: 'Justificatifs',
  splitPartSupplier: 'Fournisseurs',
  splitLabelRequired: 'Donnez un intitulé à la nouvelle opération.',
  splitNothingChosen: 'Choisissez au moins un élément à déplacer.',
  splitAllChosen: 'Tout ne peut pas partir : laissez au moins un élément sur cette opération.',
  splitTypeNote: 'La nouvelle opération reprend le type et les biens de celle-ci. Vous pourrez la corriger ensuite.',
  splitPreviewTitle: 'Avant d’enregistrer',
  splitPreviewMoved: 'Part vers la nouvelle opération',
  splitPreviewKept: 'Reste sur cette opération',
  splitPreviewHint: 'Les événements de l’Agenda gardent leur date et leurs rappels ; les fichiers ne sont pas copiés. Les montants d’un justificatif déplacé ne sont pris en compte dans la nouvelle opération qu’après la prochaine analyse automatique. Ce que vous séparez ne sera pas regroupé de nouveau automatiquement.',
  splitConfirm: 'Scinder',
  splitReview: 'Vérifier',
  dissociateTitle: 'Dissocier ces deux opérations ?',
  dissociateBody: 'Seul le lien est retiré : les deux opérations, leurs documents et leurs événements sont conservés. Elles ne seront pas associées de nouveau automatiquement.',
  confirm: 'Confirmer',
  // Choix d'un objet
  pickerSearch: 'Rechercher',
  pickerSearchPlaceholder: 'Titre ou nom',
  pickerEmpty: 'Aucun résultat dans votre compte.',
  pickerMore: 'D’autres résultats existent : précisez votre recherche.',
  pickerError: 'La liste n’a pas pu être chargée. Réessayez.',
  pickerLoading: 'Chargement…',
  pickerAgendaTitle: 'Rattacher un événement de votre agenda',
  pickerAgendaHint: 'L’événement garde sa date, ses rappels et ses documents. S’il est déjà rattaché à une autre opération, il sera partagé entre les deux.',
  pickerDocumentTitle: 'Rattacher un document',
  pickerDocumentHint: 'Le document reste à sa place. Ses montants ne sont pris en compte ici qu’après la prochaine analyse automatique.',
  pickerSupplierTitle: 'Relier un fournisseur',
  pickerSupplierHint: 'Le fournisseur est relié comme prestataire. Rien d’autre n’est créé.',
  pickerReferenceTitle: 'Associer une opération',
  pickerReferenceHint: 'Les deux opérations restent distinctes : rien n’est fusionné, aucun montant n’est ajouté.',
  associationNature: 'Nature du lien',
  associateConfirm: 'Associer',
  undatedCandidate: 'Sans date',
  networkError: 'La demande n’a pas abouti. Vérifiez votre connexion, actualisez la fiche, puis réessayez si besoin.',
  busy: 'Enregistrement…',
  back: 'Retour au choix',
} as const;
