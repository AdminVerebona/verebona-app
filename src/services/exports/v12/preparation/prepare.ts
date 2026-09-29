/**
 * Préparation déterministe d'un dossier — CDC V12 §3.1 (étape 2), §5,
 * §6 (moteur de sélection), §17.1 (`prepare`), §24 (matrice par type).
 *
 * Fonction PURE des données du bien (`ExportSource`) : sections du PDF dans
 * l'ordre des templates, éléments proposés (documents, photos une par une,
 * événements du suivi et de l'agenda) avec leur pré-sélection, leur
 * compatibilité et leurs modes, état des blocs CIL, estimation, alertes et
 * actions possibles. Mêmes règles que la génération (`choices.ts`) :
 *
 *   · DEC-006 / SEL-GEN-007 : un document sensible est proposé, jamais pré-coché ;
 *   · DEC-005 / SEL-GEN-003-005 : formats intégrables PDF, JPG, PNG, WebP ; les
 *     autres ne proposent que le mode ZIP (bascule automatique) ;
 *   · §6.2 : plafonds de photos pré-cochées (4 vente / location / souscription,
 *     8 complet / sinistre), vente et location : documents et suivi proposés
 *     non cochés, finances du dossier complet décochées ;
 *   · garde-fou occupant : les pièces locatives ne sont jamais proposées ;
 *   · SEL-GEN-010 : une section optionnelle sans élément retenu est désactivée.
 */

import {
  DOSSIER_DESCRIPTIONS, DOSSIER_LABELS, DOSSIER_SHORT_LABELS, DOSSIER_ADDITIONAL_SECTIONS, EXPORT_FAMILY_LABELS,
  type DossierCode,
} from '@/services/exports/catalog';
import { CIL_ACTION_REQUIRED_MESSAGE, isBlockBlocking } from '@/services/exports/cil-preparation.service';
import type { ExportSource, SourceDocument, SourceEvent, SourcePhoto } from '../data/source';
import {
  buildDefaultChoices, DEFAULT_SECTIONS, PHOTO_CAPS, eventKind, eventSection, isPhotoIntegrable, isUpcoming, planSelection,
  type ChoiceItem, type ExportChoices,
} from '../data/choices';
import { mapDossierData } from '../data/mappers';
import { cilSection } from '../data/mappers/cil';
import { categoryName } from '../data/mappers/common';
import { templateVersion } from '../templates';
import { THRESHOLDS } from '../thresholds';
import { maxFileBytes } from '../render/media';
import { docCompatibility, estimateSelection, unavailability } from './estimate';
import { prepMessage, type PrepMessage } from './messages';
import { INFO_HOST_SECTION, PREP_SECTIONS, type PrepSectionDef } from './sections';
import type { CilBlockDto, Compatibility, EstimateDto, ItemMode, PrepItem, PrepRow, PrepSection, PreparationDto } from './types';
import {
  ACTION_STATUS_OPTIONS, CHARGE_KIND_OPTIONS, CHARGE_PERIOD_OPTIONS, EXCHANGE_CHANNEL_OPTIONS, EXCHANGE_PARTY_OPTIONS,
  RETAINED_VALUE_SOURCE_OPTIONS,
} from '@/lib/assets/additional-infos';

const EVENT_KIND_LABELS: Record<ReturnType<typeof eventKind>, string> = {
  ENTRETIEN: 'Entretien', TRAVAUX: 'Travaux', GARANTIE: 'Garantie', SINISTRE: 'Sinistre', AUTRE: 'Événement',
};

/** Blocs CIL qui peuvent être déclarés non applicables (§20 : B1, B2 et B8 ne le peuvent pas). */
const CIL_NOT_APPLICABLE_ALLOWED = new Set(['B3', 'B4', 'B5', 'B6', 'B7', 'B9']);

const key = (t: string, id: number) => `${t}:${id}`;

function fileError(c: Compatibility | null): string | null {
  if (c === 'missing') return 'Fichier introuvable : il ne peut pas être joint au dossier.';
  if (c === 'too_large') return `Fichier de plus de ${Math.round(maxFileBytes() / (1024 * 1024))} Mo : il ne peut pas être joint au dossier.`;
  return null;
}

const allowedModesOf = (c: Compatibility): ItemMode[] => (c === 'integrable' ? ['PDF', 'ZIP'] : c === 'zip_only' ? ['ZIP'] : []);

function documentItem(code: DossierCode, d: SourceDocument, cur: ChoiceItem | undefined, rec: ChoiceItem | undefined): PrepItem {
  const compatibility = docCompatibility(d);
  const allowedModes = allowedModesOf(compatibility);
  const selectable = allowedModes.length > 0;
  const recommendedMode: ItemMode | null = selectable ? (rec?.mode ?? allowedModes[0]) : null;
  const requested = cur?.mode && allowedModes.includes(cur.mode) ? cur.mode : null;
  return {
    key: key('document', d.id),
    sourceType: 'document',
    sourceId: d.id,
    type: 'document',
    label: d.title,
    typeLabel: d.typeLabel || null,
    source: 'Documents du bien',
    date: d.date,
    format: d.format,
    sizeBytes: d.sizeBytes,
    compatibility,
    sensitive: d.sensitive,
    allowedModes,
    selectable,
    recommended: !!rec?.selected,
    recommendedMode,
    selected: selectable && !!cur?.selected,
    mode: selectable ? (requested ?? recommendedMode) : null,
    fileId: d.id,
    detail: code === 'CIL' ? `Bloc ${cilSection(d)}` : d.supplier,
    error: fileError(compatibility),
  };
}

function photoItem(p: SourcePhoto, index: number, cur: ChoiceItem | undefined, rec: ChoiceItem | undefined): PrepItem {
  const compatibility: Compatibility = unavailability(p) ?? (isPhotoIntegrable(p) ? 'integrable' : 'zip_only');
  const allowedModes = allowedModesOf(compatibility);
  const selectable = allowedModes.length > 0;
  const recommendedMode: ItemMode | null = selectable ? (rec?.mode ?? allowedModes[0]) : null;
  const requested = cur?.mode && allowedModes.includes(cur.mode) ? cur.mode : null;
  const format = (p.mimeType ?? '').split('/')[1]?.toUpperCase().replace('JPEG', 'JPG') || (p.fileName?.split('.').pop()?.toUpperCase() ?? null);
  return {
    key: key('photo', p.id),
    sourceType: 'photo',
    sourceId: p.id,
    type: 'photo',
    label: p.caption?.trim() || p.fileName?.replace(/\.[a-z0-9]{2,5}$/i, '') || `Photo ${index + 1}`,
    typeLabel: 'Photo',
    source: 'Photos du bien',
    date: p.date,
    format,
    sizeBytes: p.sizeBytes,
    compatibility,
    sensitive: false,
    allowedModes,
    selectable,
    recommended: !!rec?.selected,
    recommendedMode,
    selected: selectable && !!cur?.selected,
    mode: selectable ? (requested ?? recommendedMode) : null,
    fileId: p.fileId,
    detail: p.isPrimary ? 'Photo principale' : null,
    error: fileError(compatibility),
  };
}

function eventItem(e: SourceEvent, today: string, cur: ChoiceItem | undefined, rec: ChoiceItem | undefined): PrepItem {
  const upcoming = isUpcoming(e, today);
  return {
    key: key(e.source, e.id),
    sourceType: e.source,
    sourceId: e.id,
    type: 'event',
    label: e.title,
    typeLabel: EVENT_KIND_LABELS[eventKind(e)],
    source: e.source === 'agenda' ? 'Agenda du bien' : 'Historique du bien',
    date: e.date,
    format: null,
    sizeBytes: null,
    compatibility: null,
    sensitive: false,
    allowedModes: [],
    selectable: true,
    recommended: !!rec?.selected,
    recommendedMode: null,
    selected: !!cur?.selected,
    mode: null,
    fileId: null,
    detail: [e.provider, upcoming ? 'À venir' : null].filter(Boolean).join(' · ') || null,
    error: null,
  };
}


type Row = Record<string, unknown>;
const list = (sec: Record<string, unknown> | undefined, k: string): Row[] =>
  (Array.isArray(sec?.[k]) ? (sec![k] as unknown[]) : []).filter((x): x is Row => !!x && typeof x === 'object' && !Array.isArray(x));
const txt = (v: unknown): string | null => (v == null || String(v).trim() === '' ? null : String(v).trim());
const ids = (v: unknown): number[] => (Array.isArray(v) ? v : v == null ? [] : [v]).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
const euros = (v: unknown): string | null => (typeof v === 'number' && Number.isFinite(v)
  ? new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: v % 100 ? 2 : 0 }).format(v / 100) : null);
const opt = (options: ReadonlyArray<{ value: string; label: string }>, v: unknown): string | null => {
  const s = txt(v);
  return s ? options.find((o) => o.value === s)?.label ?? s : null;
};
const dateFr = (v: unknown): string | null => {
  const s = txt(v);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10).split('-').reverse().join('/') : null;
};
const join = (...xs: Array<string | null | undefined>) => xs.filter(Boolean).join(' · ') || null;
const rowId = (r: Row, i: number) => txt(r.id) ?? String(i + 1);

/**
 * Lignes structurées (schéma v2 des informations complémentaires) qui
 * alimentent une section de l'écran — mêmes sources que les mappeurs.
 */
export function sectionRows(code: DossierCode, id: string, source: ExportSource): PrepRow[] {
  const ai = source.additionalInfo as unknown as Record<string, Record<string, unknown> | undefined>;
  const docs = (v: unknown) => ids(v).map((n) => `document:${n}`);
  const photos = (v: unknown) => ids(v).map((n) => `photo:${n}`);
  if (code === 'VENTE' && id === 'highlights') {
    return list(ai.commercial, 'highlights').slice(0, 4).filter((r) => txt(r.title))
      .map((r, i) => ({ id: rowId(r, i), label: txt(r.title)!, detail: txt(r.text), linked: [] }));
  }
  if (code === 'ASSURANCE_SOUSCRIPTION' && id === 'protections') {
    return list(ai.insurance, 'protectionItems').filter((r) => txt(r.title))
      .map((r, i) => ({ id: rowId(r, i), label: txt(r.title)!, detail: txt(r.text), linked: [] }));
  }
  if (code === 'ASSURANCE_SOUSCRIPTION' && id === 'value') {
    return list(ai.insurance, 'insuredItems').filter((r) => txt(r.label))
      .map((r, i) => ({ id: rowId(r, i), label: txt(r.label)!, detail: join(euros(r.valueCents), ids(r.documentId).length ? null : 'Déclaratif, sans justificatif'), linked: docs(r.documentId) }));
  }
  if (code === 'DOSSIER_COMPLET' && id === 'finance') {
    const f = ai.finance;
    const rows: PrepRow[] = [];
    if (typeof f?.retainedValueCents === 'number') rows.push({ id: 'retained', label: 'Valeur retenue', detail: join(euros(f.retainedValueCents), opt(RETAINED_VALUE_SOURCE_OPTIONS, f.retainedValueSource), dateFr(f.retainedValueDate)), linked: [] });
    if (typeof f?.acquisitionFeesCents === 'number') rows.push({ id: 'fees', label: 'Frais d’acquisition', detail: euros(f.acquisitionFeesCents), linked: [] });
    list(f, 'charges').forEach((r, i) => rows.push({
      id: `charge-${rowId(r, i)}`, label: txt(r.label) ?? opt(CHARGE_KIND_OPTIONS, r.kind) ?? 'Charge',
      detail: join(euros(r.amountCents), opt(CHARGE_PERIOD_OPTIONS, r.period), txt(r.year)), linked: [],
    }));
    return rows;
  }
  if (code === 'ASSURANCE_SINISTRE') {
    const c = ai.claim;
    if (id === 'damages') {
      return list(c, 'damages').filter((r) => txt(r.zone))
        .map((r, i) => ({ id: rowId(r, i), label: join(txt(r.zone), txt(r.element))!, detail: join(txt(r.finding), euros(r.estimatedAmountCents)), linked: [...photos(r.photoIds), ...docs(r.documentIds)] }));
    }
    if (id === 'actions') {
      return list(c, 'actions').filter((r) => txt(r.title))
        .map((r, i) => ({ id: rowId(r, i), label: txt(r.title)!, detail: join(dateFr(r.date), opt(ACTION_STATUS_OPTIONS, r.status), txt(r.performedBy)), linked: docs(r.invoiceDocumentId) }));
    }
    if (id === 'exchanges') {
      return list(c, 'exchanges').filter((r) => txt(r.summary))
        .map((r, i) => ({ id: rowId(r, i), label: txt(r.summary)!, detail: join(dateFr(r.date), opt(EXCHANGE_PARTY_OPTIONS, r.party), opt(EXCHANGE_CHANNEL_OPTIONS, r.channel)), linked: docs(r.documentId) }));
    }
  }
  return [];
}

/**
 * Sections alimentées par les informations complémentaires : leur contenu
 * dans le PDF, calculé par le MAPPEUR lui-même (même règle que la
 * génération : dommages structurés seulement, actions structurées ou
 * mesures sur plusieurs lignes, échanges structurés + courriers RETENUS…),
 * la section étant supposée cochée. `null` : section sans contenu mappé.
 */
export function mappedFilled(code: DossierCode, source: ExportSource, choices: ExportChoices, today: string): Record<string, boolean> {
  const allOn = Object.fromEntries(Object.keys(DEFAULT_SECTIONS[code]).map((k) => [k, true]));
  const plan = planSelection(code, source, { ...choices, outputFormat: 'ZIP', sections: { ...choices.sections, ...allOn } }, today);
  const meta = { reference: '', generatedAt: `${today}T00:00:00+00:00`, preparedBy: null, templateLabel: '', zipName: null, label: '' };
  const d = mapDossierData(code, { source, plan, resolved: null, meta, today }) as unknown as Record<string, unknown>;
  const len = (v: unknown) => (Array.isArray(v) ? v.length > 0 : false);
  const fin = d.finance as { lines?: unknown[]; charges?: unknown[]; retainedValue?: { amountCents?: number | null } } | null | undefined;
  const energy = (d.energy ?? {}) as Record<string, unknown>;
  switch (code) {
    case 'ASSURANCE_SINISTRE': return { damages: len(d.damages), actions: len(d.actions), exchanges: len(d.exchanges) };
    case 'VENTE': return { highlights: len(d.highlights) };
    case 'ASSURANCE_SOUSCRIPTION': return { protections: len(d.protections) };
    case 'LOCATION': return { equipments: len(d.equipments) || Object.values(energy).some((v) => v != null && v !== '') };
    case 'DOSSIER_COMPLET': return { finance: !!fin && (len(fin.lines) || len(fin.charges) || fin.retainedValue?.amountCents != null) };
    default: return {};
  }
}

function cilBlocks(source: ExportSource): PreparationDto['cil'] {
  const cil = source.cil;
  if (!cil) return null;
  const p = cil.profile;
  const b2Complete = !!p && (p.triggerType !== 'inconnu' || !!p.triggerDate || !!p.authorizationType || !!p.voluntaryReason);
  const blocks: CilBlockDto[] = cil.readiness.blocks.map((b) => ({
    id: b.id,
    label: b.label,
    status: b.status,
    blocking: b.blocking || b.id === 'B1' || b.id === 'B3' || b.id === 'B8',
    blocksGeneration: isBlockBlocking(b),
    missingItems: b.missingItems,
    canMarkNotApplicable: CIL_NOT_APPLICABLE_ALLOWED.has(b.id),
  }));
  // B2 : contexte de constitution (profil CIL), non bloquant (§20).
  const b2: CilBlockDto = {
    id: 'B2', label: 'Contexte de constitution du CIL', status: b2Complete ? 'complete' : 'unknown', blocking: false, blocksGeneration: false,
    missingItems: [], canMarkNotApplicable: false,
  };
  const at = blocks.findIndex((b) => b.id === 'B3');
  blocks.splice(at < 0 ? 1 : at, 0, b2);
  return { globalStatus: cil.readiness.globalStatus, percentage: cil.readiness.completion.percentage, blocks };
}

/** Choix normalisés depuis l'état des sections (ce que l'écran enverra). */
export function choicesFromSections(sections: PrepSection[]): ExportChoices {
  const items: ChoiceItem[] = [];
  const toggles: Record<string, boolean> = {};
  for (const s of sections) {
    if (s.toggleable) toggles[s.id] = s.enabled;
    for (const it of s.items) {
      if (!it.selected || !it.selectable) continue;
      items.push({ sourceType: it.sourceType, sourceId: it.sourceId, selected: true, ...(it.mode ? { mode: it.mode } : {}) });
    }
  }
  return { outputFormat: 'ZIP', origin: 'user', sections: toggles, items, acknowledgements: { pdfOnlyExcludesZipItems: false } };
}

/** Messages §5.4 déduits d'une estimation (MSG-PREP-004, 005, 008). */
export function estimateMessages(e: EstimateDto): PrepMessage[] {
  const out: PrepMessage[] = [];
  if (e.blocking.some((b) => b.code === 'DOCS_BLOCKING')) out.push(prepMessage('MSG-PREP-004', 'blocking'));
  if (e.unavailable.length) out.push(prepMessage('MSG-PREP-005', 'warning'));
  if (e.longGeneration) out.push(prepMessage('MSG-PREP-008', 'info'));
  return out;
}

export interface PrepareContext {
  today: string;
  /** Choix déjà faits (`includeCurrentSelections`) ; sinon pré-sélection du CDC. */
  choices?: ExportChoices | null;
  lastGeneration: PreparationDto['lastGeneration'];
}

export function buildPreparation(code: DossierCode, source: ExportSource, ctx: PrepareContext): PreparationDto {
  const { today } = ctx;
  // Pré-sélection du CDC, en format ZIP : une pièce pré-cochée non intégrable
  // est retenue en mode ZIP (« PDF si intégrable, sinon ZIP », §24).
  const recommended = buildDefaultChoices(code, source, { outputFormat: 'ZIP', today });
  const current = ctx.choices ?? recommended;
  const recByKey = new Map(recommended.items.map((i) => [key(i.sourceType, i.sourceId), i]));
  const curByKey = new Map(current.items.map((i) => [key(i.sourceType, i.sourceId), i]));
  const toggles = { ...DEFAULT_SECTIONS[code], ...current.sections };

  // Garde-fou occupant : pièces locatives jamais proposées.
  const docs = source.documents.filter((d) => !d.occupantData)
    .slice().sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')) || a.title.localeCompare(b.title));
  const documentItems = docs.map((d) => documentItem(code, d, curByKey.get(key('document', d.id)), recByKey.get(key('document', d.id))));
  const photoItems = code === 'CIL' ? [] : source.photos.map((p, i) => photoItem(p, i, curByKey.get(key('photo', p.id)), recByKey.get(key('photo', p.id))));
  const eventsBySection = new Map<string, PrepItem[]>();
  for (const e of source.events.slice().sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')))) {
    const s = eventSection(code, e, today);
    if (!s) continue;
    const list = eventsBySection.get(s) ?? [];
    list.push(eventItem(e, today, curByKey.get(key(e.source, e.id)), recByKey.get(key(e.source, e.id))));
    eventsBySection.set(s, list);
  }

  const itemsOf = (def: PrepSectionDef): PrepItem[] =>
    def.items === 'document' ? documentItems : def.items === 'photo' ? photoItems : def.items === 'event' ? (eventsBySection.get(def.id) ?? []) : [];

  const sections: PrepSection[] = PREP_SECTIONS[code].map((def) => {
    const items = itemsOf(def);
    const rows = sectionRows(code, def.id, source);
    const toggleable = !def.required && !!def.toggle;
    const defaultEnabled = def.required ? true : DEFAULT_SECTIONS[code][def.toggle ?? ''] !== false;
    let enabled = def.required ? true : toggles[def.toggle ?? ''] !== false;
    // SEL-GEN-010 : section à éléments sans élément retenu → désactivée.
    if (toggleable && def.items && !items.some((i) => i.selected)) enabled = false;
    const recommendedSection = def.required || (defaultEnabled && (!def.items || items.some((i) => i.recommended)));
    return {
      id: def.id,
      label: def.label,
      description: def.description,
      required: def.required,
      toggleable,
      enabled,
      defaultEnabled,
      recommended: recommendedSection,
      itemType: def.items ?? null,
      items,
      infoSections: DOSSIER_ADDITIONAL_SECTIONS[code].filter((k) => INFO_HOST_SECTION[k] === def.id),
      cil: !!def.cil,
      fedBy: def.fedBy ?? null,
      fedFilled: null as boolean | null,
      rows,
      hasSensitive: items.some((i) => i.sensitive),
    };
  });

  // Contenu réel des sections alimentées par les informations (règles du mappeur).
  const filledBy = mappedFilled(code, source, choicesFromSections(sections), today);
  for (const sec of sections) if (sec.fedBy) sec.fedFilled = sec.id in filledBy ? filledBy[sec.id] : null;

  const cil = code === 'CIL' ? cilBlocks(source) : null;
  const cilBlocked = cil?.globalStatus === 'action_required';
  const { dto: estimate } = estimateSelection(code, source, choicesFromSections(sections), today);

  const empty = documentItems.length === 0 && photoItems.length === 0 && eventsBySection.size === 0;
  const messages: PrepMessage[] = [];
  if (empty) messages.push(prepMessage('MSG-PREP-001', 'info'));
  // Pièce recommandée mais inutilisable : signalée (elle sera exclue).
  if ([...documentItems, ...photoItems].some((i) => i.recommended && !i.selectable)) messages.push(prepMessage('MSG-PREP-005', 'warning'));
  for (const m of estimateMessages(estimate)) if (!messages.some((x) => x.code === m.code)) messages.push(m);

  const canGeneratePdf = !cilBlocked && estimate.blocking.length === 0;
  return {
    assetId: source.asset.id,
    exportType: code,
    status: 'ready_pristine',
    dossier: { code, label: DOSSIER_LABELS[code], shortLabel: DOSSIER_SHORT_LABELS[code], description: DOSSIER_DESCRIPTIONS[code], templateVersion: templateVersion(code) },
    asset: { id: source.asset.id, name: source.asset.name, family: source.family, familyLabel: EXPORT_FAMILY_LABELS[source.family], categoryLabel: categoryName(source) },
    eligibility: cilBlocked
      ? { status: 'partial', message: CIL_ACTION_REQUIRED_MESSAGE }
      : { status: 'ready', message: null },
    lastGeneration: ctx.lastGeneration,
    sections,
    photoCap: PHOTO_CAPS[code],
    additionalInfo: { sections: [...DOSSIER_ADDITIONAL_SECTIONS[code]], updatedAt: source.additionalInfo.updatedAt },
    cil,
    estimate,
    actions: { canGeneratePdf, canGenerateZip: canGeneratePdf && estimate.outputFormat === 'ZIP' },
    messages,
    thresholds: { ...THRESHOLDS },
    empty,
  };
}
