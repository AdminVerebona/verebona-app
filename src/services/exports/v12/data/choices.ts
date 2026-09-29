/**
 * Choix de l'utilisateur pour un dossier (sections, pièces, modes PDF/ZIP) —
 * CDC V12 §6 (moteur de sélection déterministe), §17.2 (payload de
 * génération), §24 (matrice par type d'élément).
 *
 * Trois origines, une seule forme normalisée (`ExportChoices`) figée dans le
 * snapshot (§16.3) :
 *   · `user`          — payload V12 de l'écran de préparation (lot suivant) :
 *                       chaque élément coché est un choix EXPLICITE, un
 *                       document sensible peut donc y figurer (DEC-006) ;
 *   · `legacy_drawer` — options du tiroir historique (`customDocIds`,
 *                       `includePhotos`) : ce tiroir pré-coche tout, ses
 *                       coches ne sont pas des choix explicites — un
 *                       document sensible n'y est JAMAIS retenu ;
 *   · `default`       — pré-sélection du CDC, en attendant l'écran.
 *
 * Règles communes : SEL-GEN-001 (non coché = absent partout), SEL-GEN-002
 * (coché ⇒ mode PDF ou ZIP), SEL-GEN-005 (non intégrable demandé en PDF ⇒
 * ZIP, ou exclu si l'utilisateur a choisi un PDF seul — ALT-002),
 * SEL-GEN-007 (sensible jamais pré-coché), garde-fou « occupant » (jamais
 * retenu, quelle que soit l'origine).
 */

import type { DossierCode } from '@/services/exports/catalog';
import type { ExportSource, SourceDocument, SourceEvent, SourcePhoto } from './source';
import { fileFormatOf, isIntegrable, type DocKind } from './documents';

export type OutputFormat = 'PDF' | 'ZIP';
export type ItemMode = 'PDF' | 'ZIP';
export type ChoiceSourceType = 'document' | 'photo' | 'event' | 'agenda';
export type ChoicesOrigin = 'user' | 'legacy_drawer' | 'default';

export interface ChoiceItem {
  sourceType: ChoiceSourceType;
  sourceId: number;
  selected: boolean;
  mode?: ItemMode;
}

export interface ExportChoices {
  outputFormat: OutputFormat;
  origin: ChoicesOrigin;
  /** Sections optionnelles et leur état (absent = état par défaut du dossier). */
  sections: Record<string, boolean>;
  items: ChoiceItem[];
  acknowledgements: { pdfOnlyExcludesZipItems: boolean };
}

// ─── Sections optionnelles par dossier (défauts §6.2) ───────────────────────

/** Sections décochables et leur état par défaut. */
export const DEFAULT_SECTIONS: Readonly<Record<DossierCode, Readonly<Record<string, boolean>>>> = {
  CIL: { documents: true },
  // DOSSIER_COMPLET-RULE-002 : coûts et valeurs non inclus par défaut.
  DOSSIER_COMPLET: { finance: false, history: true, deadlines: true, contracts: true, documents: true, photos: true },
  // VENTE-PDF-07/08 : suivi et documents proposés non précochés.
  VENTE: { highlights: true, photos: true, followUp: false, documents: true },
  // LOCATION-PDF-07 : suivi non précoché ; jamais de coûts (RULE-004).
  LOCATION: { equipments: true, photos: true, followUp: false, documents: true },
  // ASSURANCE_SOUSCRIPTION-RULE-004 : protections dans une section décochable.
  ASSURANCE_SOUSCRIPTION: { protections: true, condition: true, documents: true, photos: true },
  ASSURANCE_SINISTRE: { timeline: true, damages: true, photos: true, actions: true, documents: true, exchanges: true },
};

/** Plafonds de photos pré-cochées (§6.2) : 3-4 vente/location, 6-8 complet/sinistre. */
export const PHOTO_CAPS: Readonly<Record<DossierCode, number>> = {
  CIL: 0, DOSSIER_COMPLET: 8, VENTE: 4, LOCATION: 4, ASSURANCE_SOUSCRIPTION: 4, ASSURANCE_SINISTRE: 8,
};

/** Natures de pièces pré-cochées par dossier (matrice §24 ; le reste est « proposé non coché »). */
export const PRESELECTED_KINDS: Readonly<Record<DossierCode, ReadonlySet<DocKind>>> = {
  CIL: new Set<DocKind>(['DPE', 'AUDIT_ENERGETIQUE', 'GAZ', 'ELECTRICITE', 'ERNMT', 'PLAN_CONSTRUCTION', 'RESEAU', 'ENERGIE_TECHNIQUE']),
  DOSSIER_COMPLET: new Set<DocKind>(['FACTURE', 'GARANTIE', 'CONTRAT']),
  VENTE: new Set<DocKind>(),
  LOCATION: new Set<DocKind>(),
  // RULE-002 : attestations d'assurance existantes proposées non cochées ; RULE-003 : preuves de valeur précochées.
  ASSURANCE_SOUSCRIPTION: new Set<DocKind>(['FACTURE', 'GARANTIE', 'EXPERTISE']),
  // « précoché si lié au sinistre » : voir `isLinkedToClaim`.
  ASSURANCE_SINISTRE: new Set<DocKind>(['FACTURE', 'DEVIS', 'SINISTRE', 'ECHANGE_ASSUREUR', 'RAPPORT_ENTRETIEN', 'EXPERTISE']),
};

// ─── Natures d'événements ───────────────────────────────────────────────────

export type EventKind = 'ENTRETIEN' | 'TRAVAUX' | 'GARANTIE' | 'SINISTRE' | 'AUTRE';

const EVENT_WORDS: Array<[EventKind, RegExp]> = [
  ['SINISTRE', /sinistre|d[ée]g[aâ]t|fuite|inondation|incendie|vol\b|cambriol|bris|accident|expert/i],
  ['GARANTIE', /garantie|extension de garantie/i],
  ['TRAVAUX', /travaux|r[ée]novation|installation|remplacement|pose|isolation|am[ée]nagement/i],
  ['ENTRETIEN', /entretien|r[ée]vision|contr[oô]le|vidange|ramonage|maintenance|v[ée]rification|diagnostic|nettoyage|r[ée]paration/i],
];

/** Nature d'un événement : catégorie historique si connue, sinon mots du titre. */
export function eventKind(e: Pick<SourceEvent, 'category' | 'title'>): EventKind {
  const c = (e.category ?? '').toLowerCase();
  if (/sinistre/.test(c)) return 'SINISTRE';
  if (/garantie/.test(c)) return 'GARANTIE';
  if (/travaux|renovation|amelioration/.test(c)) return 'TRAVAUX';
  if (/entretien|maintenance|controle|revision|reparation/.test(c)) return 'ENTRETIEN';
  for (const [k, re] of EVENT_WORDS) if (re.test(e.title)) return k;
  return 'AUTRE';
}

/** Événement passé et non annulé (historique). */
export const isPastEvent = (e: SourceEvent, today: string): boolean =>
  e.status !== 'annule' && !!e.date && e.date <= today && !e.forecast;

/** Échéance à venir (agenda). */
export const isUpcoming = (e: SourceEvent, today: string): boolean =>
  e.status !== 'annule' && e.status !== 'realise' && !!e.date && e.date > today;

/**
 * Date du sinistre, ISO ou null : saisie (`claim.occurredOn`), sinon date de
 * l'événement sinistre de l'agenda lié dans la fiche (`claim.claimEventKey`,
 * RULE-001) — même repli que le mappeur (`linkedClaimEvent`).
 */
export function claimDate(source: ExportSource): string | null {
  const iso = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
  const typed = iso(source.additionalInfo.claim?.occurredOn);
  if (typed) return typed;
  const key = source.additionalInfo.claim?.claimEventKey;
  if (typeof key !== 'string' || !key) return null;
  const e = source.events.find((x) => x.key === key && x.status !== 'annule');
  return iso(e?.date);
}

/** Lien au sinistre (ASSURANCE_SINISTRE-RULE-004, matrice §24) : nature sinistre, ou datée du sinistre ou après. */
export function isLinkedToClaim(date: string | null, kind: DocKind | EventKind, source: ExportSource): boolean {
  if (kind === 'SINISTRE' || kind === 'ECHANGE_ASSUREUR') return true;
  const d0 = claimDate(source);
  return !!d0 && !!date && date >= d0;
}

// ─── Candidats et pré-sélection ─────────────────────────────────────────────

/** Section de rattachement d'un événement, selon le dossier (null : non proposé). */
export function eventSection(code: DossierCode, e: SourceEvent, today: string): string | null {
  const k = eventKind(e);
  switch (code) {
    case 'DOSSIER_COMPLET': return isUpcoming(e, today) ? 'deadlines' : isPastEvent(e, today) ? 'history' : null;
    case 'VENTE':
    case 'LOCATION': return isPastEvent(e, today) && (k === 'ENTRETIEN' || k === 'TRAVAUX') ? 'followUp' : null;
    case 'ASSURANCE_SOUSCRIPTION': return isPastEvent(e, today) && (k === 'ENTRETIEN' || k === 'TRAVAUX') ? 'condition' : null;
    // Tout événement daté est proposé ; seuls ceux liés au sinistre sont pré-cochés.
    case 'ASSURANCE_SINISTRE': return e.status !== 'annule' && !!e.date ? 'timeline' : null;
    default: return null;
  }
}

function preselectEvent(code: DossierCode, e: SourceEvent, source: ExportSource, today: string): boolean {
  const k = eventKind(e);
  switch (code) {
    case 'DOSSIER_COMPLET': return isUpcoming(e, today) || k === 'ENTRETIEN' || k === 'GARANTIE';
    case 'ASSURANCE_SOUSCRIPTION': return k === 'ENTRETIEN';
    case 'ASSURANCE_SINISTRE': return isLinkedToClaim(e.date, k, source);
    // Vente, location : « proposés non précochés » (la section elle-même est décochée).
    default: return false;
  }
}

function preselectDocument(code: DossierCode, d: SourceDocument, source: ExportSource): boolean {
  if (d.sensitive || d.occupantData) return false; // SEL-GEN-007, garde-fou occupant
  if (!PRESELECTED_KINDS[code].has(d.kind)) return false;
  if (code === 'ASSURANCE_SINISTRE') return isLinkedToClaim(d.date, d.kind, source);
  return true;
}

/** Photo intégrable au PDF (SEL-GEN-003) : JPG, PNG, WebP. */
export const isPhotoIntegrable = (p: Pick<SourcePhoto, 'mimeType' | 'fileName'>): boolean =>
  isIntegrable(fileFormatOf(p.mimeType, p.fileName));

function preselectPhotos(code: DossierCode, photos: SourcePhoto[], source: ExportSource): Set<number> {
  const cap = PHOTO_CAPS[code];
  // Seules les photos intégrables sont pré-cochées (elles vont dans le PDF).
  let eligible = photos.filter(isPhotoIntegrable);
  if (code === 'ASSURANCE_SINISTRE') {
    // « 6-8 photos liées au sinistre par défaut ; autres photos proposées non cochées. »
    const d0 = claimDate(source);
    eligible = d0 ? eligible.filter((p) => !!p.date && p.date >= d0) : [];
  }
  return new Set(eligible.slice(0, cap).map((p) => p.id));
}

/** Mode d'une pièce retenue ; null si elle ne peut pas être livrée (PDF seul + non intégrable). */
export function resolveMode(requested: ItemMode | undefined, integrable: boolean, outputFormat: OutputFormat): ItemMode | null {
  if (requested === 'ZIP') return outputFormat === 'ZIP' ? 'ZIP' : null;
  if (integrable) return 'PDF';
  return outputFormat === 'ZIP' ? 'ZIP' : null; // SEL-GEN-005 / ALT-002
}

/** Pré-sélection du CDC (§6.2, §24) pour un dossier. */
export function buildDefaultChoices(code: DossierCode, source: ExportSource, opts: { outputFormat?: OutputFormat; today: string }): ExportChoices {
  const outputFormat = opts.outputFormat ?? 'PDF';
  const items: ChoiceItem[] = [];
  for (const d of source.documents) {
    if (!preselectDocument(code, d, source)) continue;
    const mode = resolveMode(undefined, d.integrable, outputFormat);
    if (mode) items.push({ sourceType: 'document', sourceId: d.id, selected: true, mode });
  }
  for (const id of preselectPhotos(code, source.photos, source)) items.push({ sourceType: 'photo', sourceId: id, selected: true, mode: 'PDF' });  for (const e of source.events) {
    if (!eventSection(code, e, opts.today)) continue;
    if (preselectEvent(code, e, source, opts.today)) items.push({ sourceType: e.source, sourceId: e.id, selected: true });
  }
  return { outputFormat, origin: 'default', sections: { ...DEFAULT_SECTIONS[code] }, items, acknowledgements: { pdfOnlyExcludesZipItems: false } };
}

/** Options du tiroir historique (`POST /api/assets/[id]/exports`). */
export interface LegacyDrawerOptions {
  customDocIds?: unknown;
  includePhotos?: unknown;
  includeEquipments?: unknown;
  customSections?: unknown;
}

/**
 * Tiroir historique → choix : documents cochés (hors sensibles et occupants,
 * ce tiroir pré-cochant tout), photos selon `includePhotos` avec les
 * plafonds du dossier, événements et sections par défaut.
 */
export function choicesFromLegacyOptions(code: DossierCode, source: ExportSource, options: LegacyDrawerOptions, opts: { outputFormat: OutputFormat; today: string }): ExportChoices {
  const base = buildDefaultChoices(code, source, opts);
  const ids = Array.isArray(options.customDocIds) ? new Set(options.customDocIds.map(Number).filter(Number.isFinite)) : null;
  let items = base.items;
  if (ids) {
    items = items.filter((i) => i.sourceType !== 'document');
    for (const d of source.documents) {
      if (!ids.has(d.id) || d.sensitive || d.occupantData) continue;
      const mode = resolveMode(undefined, d.integrable, opts.outputFormat);
      if (mode) items.push({ sourceType: 'document', sourceId: d.id, selected: true, mode });
    }
  }
  if (options.includePhotos === false) items = items.filter((i) => i.sourceType !== 'photo');
  return { ...base, origin: 'legacy_drawer', items };
}

// ─── Payload V12 (§17.2) ────────────────────────────────────────────────────

export interface ChoicesPayloadIssue { path: string; message: string }

const SOURCE_TYPES = new Set<ChoiceSourceType>(['document', 'photo', 'event', 'agenda']);

/**
 * Normalise le payload §17.2 : `{ outputFormat, sections: [{ id, enabled,
 * items: [{ sourceType, sourceId, selected, mode }] }], acknowledgements }`
 * (les éléments peuvent aussi être fournis à plat dans `items`). Les
 * éléments inconnus du bien sont ignorés par les mappeurs.
 */
export function parseChoicesPayload(code: DossierCode, raw: unknown): { ok: true; choices: ExportChoices } | { ok: false; issues: ChoicesPayloadIssue[] } {
  const issues: ChoicesPayloadIssue[] = [];
  const body = (raw ?? {}) as Record<string, unknown>;
  const outputFormat = body.outputFormat === 'ZIP' ? 'ZIP' : body.outputFormat === 'PDF' || body.outputFormat == null ? 'PDF' : null;
  if (!outputFormat) issues.push({ path: 'outputFormat', message: 'PDF ou ZIP attendu.' });
  const sections: Record<string, boolean> = { ...DEFAULT_SECTIONS[code] };
  const items: ChoiceItem[] = [];
  const pushItem = (it: unknown, path: string) => {
    const o = (it ?? {}) as Record<string, unknown>;
    const sourceType = String(o.sourceType ?? '') as ChoiceSourceType;
    const sourceId = Number(o.sourceId);
    if (!SOURCE_TYPES.has(sourceType)) { issues.push({ path: `${path}.sourceType`, message: 'Type de source inconnu.' }); return; }
    if (!Number.isSafeInteger(sourceId) || sourceId <= 0) { issues.push({ path: `${path}.sourceId`, message: 'Identifiant invalide.' }); return; }
    const mode = o.mode === 'ZIP' ? 'ZIP' : o.mode === 'PDF' ? 'PDF' : undefined;
    if (o.mode != null && !mode) { issues.push({ path: `${path}.mode`, message: 'PDF ou ZIP attendu.' }); return; }
    items.push({ sourceType, sourceId, selected: o.selected !== false, mode });
  };
  if (body.sections != null && !Array.isArray(body.sections)) issues.push({ path: 'sections', message: 'Liste attendue.' });
  (Array.isArray(body.sections) ? body.sections : []).forEach((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : '';
    if (id && id in sections && typeof o.enabled === 'boolean') sections[id] = o.enabled;
    if (Array.isArray(o.items)) o.items.forEach((it, j) => pushItem(it, `sections[${i}].items[${j}]`));
  });
  if (Array.isArray(body.items)) body.items.forEach((it, j) => pushItem(it, `items[${j}]`));
  if (items.length > 5000) issues.push({ path: 'items', message: 'Trop d’éléments.' });
  if (issues.length) return { ok: false, issues };
  const ack = (body.acknowledgements ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    choices: { outputFormat: outputFormat!, origin: 'user', sections, items, acknowledgements: { pdfOnlyExcludesZipItems: ack.pdfOnlyExcludesZipItems === true } },
  };
}

// ─── Plan de sélection (appliqué aux données) ───────────────────────────────

export type ExclusionReason =
  | 'not_selected' | 'section_disabled' | 'sensitive_not_explicit' | 'occupant_data' | 'zip_only_pdf_output'
  | 'missing' | 'corrupted' | 'protected' | 'unreadable' | 'too_large';

export interface PlannedDocument { doc: SourceDocument; mode: ItemMode }
export interface PlannedPhoto { photo: SourcePhoto; mode: ItemMode }
export interface PlannedExclusion { sourceType: ChoiceSourceType; sourceId: number; label: string; reason: ExclusionReason }

export interface SelectionPlan {
  documents: PlannedDocument[];
  photos: PlannedPhoto[];
  /** Clés `event:12` / `agenda:3` retenues. */
  events: Set<string>;
  sections: Record<string, boolean>;
  /** Exclusions décidées par la sélection (traçabilité `export_generation_items`). */
  excluded: PlannedExclusion[];
}

const key = (t: ChoiceSourceType, id: number) => `${t}:${id}`;

/** Applique des choix normalisés aux données du bien. */
export function planSelection(code: DossierCode, source: ExportSource, choices: ExportChoices, today: string): SelectionPlan {
  const byKey = new Map(choices.items.map((i) => [key(i.sourceType, i.sourceId), i]));
  const sections = { ...DEFAULT_SECTIONS[code], ...choices.sections };
  const on = (s: string) => sections[s] !== false;
  const excluded: PlannedExclusion[] = [];
  const documents: PlannedDocument[] = [];
  const photos: PlannedPhoto[] = [];
  const events = new Set<string>();

  for (const d of source.documents) {
    const it = byKey.get(key('document', d.id));
    if (!it?.selected) continue;
    const label = d.title;
    if (!on('documents')) { excluded.push({ sourceType: 'document', sourceId: d.id, label, reason: 'section_disabled' }); continue; }
    if (d.occupantData) { excluded.push({ sourceType: 'document', sourceId: d.id, label, reason: 'occupant_data' }); continue; }
    if (d.sensitive && choices.origin !== 'user') { excluded.push({ sourceType: 'document', sourceId: d.id, label, reason: 'sensitive_not_explicit' }); continue; }
    const mode = resolveMode(it.mode, d.integrable, choices.outputFormat);
    if (!mode) { excluded.push({ sourceType: 'document', sourceId: d.id, label, reason: 'zip_only_pdf_output' }); continue; }
    documents.push({ doc: d, mode });
  }
  for (const p of source.photos) {
    const it = byKey.get(key('photo', p.id));
    if (!it?.selected) continue;
    const label = p.caption ?? `Photo ${p.id}`;
    if (!on('photos')) { excluded.push({ sourceType: 'photo', sourceId: p.id, label, reason: 'section_disabled' }); continue; }
    // Même règle que les documents : une photo non intégrable (HEIC…) va au ZIP
    // (SEL-GEN-005) ; une photo en mode ZIP n'est pas livrée par un « PDF seul » (ALT-002).
    const mode = resolveMode(it.mode, isPhotoIntegrable(p), choices.outputFormat);
    if (!mode) { excluded.push({ sourceType: 'photo', sourceId: p.id, label, reason: 'zip_only_pdf_output' }); continue; }
    photos.push({ photo: p, mode });
  }
  for (const e of source.events) {
    const it = byKey.get(key(e.source, e.id));
    if (!it?.selected) continue;
    const section = eventSection(code, e, today);
    if (!section) continue;
    if (!on(section)) { excluded.push({ sourceType: e.source, sourceId: e.id, label: e.title, reason: 'section_disabled' }); continue; }
    events.add(e.key);
  }
  return { documents, photos, events, sections, excluded };
}
