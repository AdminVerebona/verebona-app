/**
 * Outils communs des mappeurs « bien + informations complémentaires + choix
 * → contrat de données d'un template » (README des maquettes).
 *
 * Principes (CDC §7.2) :
 *   · PDF-TXT-001 : aucune valeur inventée — un champ absent reste vide (et le
 *     composant le masque) ; aucun texte n'est « déduit » ;
 *   · PDF-TXT-002 : les vides sont rendus `null`, jamais « — » ni « Non
 *     renseigné » (hors exceptions du design, portées par les templates) ;
 *   · l'estimation Verebona et les données d'occupation ne sont pas dans
 *     `ExportSource` : aucun mappeur ne peut les transmettre ;
 *   · les identifiants (n° de série, VIN, immatriculation) sont masqués comme
 *     dans le design (`fmt.mask`).
 */

import { fmt, dot, isEmpty } from '../../html/components';
import type { DocItem, ExportInfo, PhotoItem, Nullable } from '../../types';
import type { ExportSource, SourceDocument, SourceEquipment, SourceEvent, InfoSection } from '../source';
import type { SelectionPlan, PlannedDocument, PlannedPhoto } from '../choices';
import type { ResolvedFiles } from '../resolved';
import { photoFileKey } from '../resolved';
import { documentTone, IMAGE_FORMATS } from '../documents';
import { assetFamilyLabel, assetCategoryLabel } from '@/lib/asset-taxonomy';
import { assetStatusLabel } from '@/lib/asset-status';
import { occupancyUsageLabel } from '@/lib/assets/occupancy';
import { CANONICAL_FIELDS, getField } from '@/services/canonical/registry';
import type { ListItem } from '@/lib/assets/additional-infos';

/** Méta de génération (en-tête, couverture, page Références). */
export interface GenerationMeta {
  reference: string;
  /** Date-heure ISO avec décalage, heure de Paris. */
  generatedAt: string;
  preparedBy: string | null;
  templateLabel: string;
  zipName: string | null;
  label: string;
}

export interface MapInput {
  source: ExportSource;
  plan: SelectionPlan;
  /** `null` : aperçu HTML sans fichiers (tests) — pages inconnues, cadres d'annexe génériques. */
  resolved: ResolvedFiles | null;
  meta: GenerationMeta;
  /** Date du jour (Paris), `YYYY-MM-DD`. */
  today: string;
}

export const exportInfo = (m: MapInput, type: string): ExportInfo => ({
  type,
  label: m.meta.label,
  reference: m.meta.reference,
  generatedAt: m.meta.generatedAt,
  preparedBy: m.meta.preparedBy,
  templateVersion: m.meta.templateLabel,
  zipName: m.meta.zipName,
});

// ─── Lecture tolérante ──────────────────────────────────────────────────────

export const str = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

export const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Caractéristique du bien (`key_characteristics`, sans estimation ni occupation). */
export const kc = (s: ExportSource, key: string): string | null => str(s.asset.characteristics[key]);
export const kcNum = (s: ExportSource, key: string): number | null => num(s.asset.characteristics[key]);

/** Champ d'une sous-rubrique des informations complémentaires. */
export const info = (sec: InfoSection | undefined, key: string): string | null => str(sec?.[key]);
/** Montant en centimes (0 est une valeur, IC-GEN-008). */
export const infoCents = (sec: InfoSection | undefined, key: string): number | null => {
  const v = num(sec?.[key]);
  return v == null ? null : Math.round(v);
};

/**
 * Liste structurée d'une sous-rubrique (schéma v2). Lecture tolérante : `[]`
 * si absente, lignes non objet écartées (le service a déjà assaini).
 */
export const infoList = (sec: InfoSection | undefined, key: string): ListItem[] => {
  const v = sec?.[key];
  return Array.isArray(v) ? v.filter((x): x is ListItem => !!x && typeof x === 'object' && !Array.isArray(x)) : [];
};

/** Identifiants numériques d'une cellule de liste (`photoIds`, `documentIds`) ou d'une référence unique. */
export const cellIds = (v: unknown): number[] =>
  (Array.isArray(v) ? v : v == null ? [] : [v]).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);

/** Libellé d'une option (liste déroulante du dictionnaire). */
export const optionLabel = (options: ReadonlyArray<{ value: string; label: string }>, v: unknown): string | null => {
  const s = str(v);
  return s ? options.find((o) => o.value === s)?.label ?? humanize(s) : null;
};

/** Lignes non vides d'un texte libre (listes saisies une par ligne). */
export const textLines = (v: unknown): string[] =>
  (str(v) ?? '').split(/\r?\n|;\s*/).map((l) => l.replace(/^[-•*·]\s*/, '').trim()).filter(Boolean);

/** Code technique → libellé lisible (« EN_SERVICE » → « En service »). */
export function humanize(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  if (!/^[A-Z0-9_]+$/.test(s) && !/^[a-z0-9_]+$/.test(s)) return s;
  const t = s.replace(/_/g, ' ').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// Lot 32 (PO-Q11) : statuts officiels ; une ancienne valeur non migrée est
// exportée sous son statut officiel (`normalizeAssetStatus`).
export const statusLabel = (s: ExportSource): string | null => (s.asset.status ? assetStatusLabel(s.asset.status) : null);

/** État déclaré (fiche bien). */
export const conditionLabel = (s: ExportSource): string | null =>
  humanize(kc(s, 'generalCondition') ?? kc(s, 'condition') ?? s.asset.generalCondition);

/** Usage déclaré (« Résidence principale », « Mis en location »…) — jamais l'occupant. */
export const usageLabel = (s: ExportSource): string | null =>
  occupancyUsageLabel(s.asset.characteristics.occupancyUsage) ?? humanize(kc(s, 'primaryUse'));

// ─── Identité du bien ───────────────────────────────────────────────────────

/** Catégorie (« Appartement », « Voiture », « Équipement de sport »). */
export const categoryName = (s: ExportSource): string | null =>
  assetCategoryLabel({ category: s.asset.category, subtype: s.asset.subtype, objectCategory: s.asset.objectCategory });

/** Sur-titre « Immobilier · Appartement ». */
export const categoryLabel = (s: ExportSource): string =>
  dot(assetFamilyLabel(s.asset.category === 'OBJECT' ? 'OBJECT' : s.asset.category) || null, categoryName(s));

/** Lignes du titre de couverture : nom du bien (le CSS gère le retour à la ligne). */
export const titleLines = (s: ExportSource): string[] => [s.asset.name];

export const cityLine = (s: ExportSource): string => dot(`${s.asset.postalCode ?? ''} ${s.asset.city ?? ''}`.trim());

export const roomsLabel = (s: ExportSource): string | null => {
  const r = kcNum(s, 'roomCount');
  const b = kcNum(s, 'bedroomCount');
  return dot(r != null ? `${r} pièce${r > 1 ? 's' : ''}` : '', b != null ? `${b} chambre${b > 1 ? 's' : ''}` : '') || null;
};

export const heatingLabel = (s: ExportSource): string | null => dot(humanize(kc(s, 'heatingType')), humanize(kc(s, 'mainEnergy'))) || null;

/** Identifiant masqué comme dans le design (n° de série, VIN, immatriculation). */
export const masked = (v: unknown, opts?: { start?: number; end?: number; dots?: number }): string | null => str(fmt.mask(v, opts)) ;

/**
 * Numéro de série (CDC 15, décision D-N) : imprimé SEULEMENT dans les
 * dossiers CIL et assurance (souscription, sinistre) — retiré des autres.
 */
const SERIAL_NUMBER_EXPORTS: ReadonlySet<string> = new Set(['CIL', 'ASSURANCE_SOUSCRIPTION', 'ASSURANCE_SINISTRE']);
export const serialNumberAllowed = (s: Pick<ExportSource, 'exportType'>): boolean => SERIAL_NUMBER_EXPORTS.has(s.exportType);

/** Consommation énergétique du DPE, au format du design (« 142 kWh/m²/an »). */
export function energyConsumptionLabel(s: ExportSource): string | null {
  const v = kc(s, 'energyConsumption') ?? kc(s, 'dpeConsumption');
  if (v == null) return null;
  const n = num(v);
  return n == null ? v : `${fmt.number(n, 1)} kWh/m²/an`;
}

/** Unités du registre → écriture française du design. */
const UNIT_LABELS: Record<string, string> = { cm3: 'cm³', m2: 'm²', 'kWh/m2/an': 'kWh/m²/an' };

/** Rang d'une clé dans le registre : ordre d'affichage stable des champs d'équipement. */
const REGISTRY_RANK = new Map(CANONICAL_FIELDS.map((d, i) => [d.key, i] as const));

/**
 * Champs d'équipement jamais repris dans la ligne de caractéristiques : déjà
 * en colonne (marque, modèle). Les montants sont écartés par
 * `equipmentFieldValue` (aucun coût dans les tableaux d'équipement).
 */
const EQUIPMENT_SPEC_SKIPPED = new Set(['name', 'brand', 'modelName']);

/**
 * Valeur d'un champ canonique d'équipement au format du dossier (dates
 * JJ/MM/AAAA, nombres français + unité du registre, libellés d'énumération).
 * `null` : vide, montant, ou valeur structurée (jamais imprimée telle quelle).
 */
export function equipmentFieldValue(key: string, value: unknown): string | null {
  if (isEmpty(value) || (typeof value === 'object' && value !== null)) return null;
  const def = getField(key);
  switch (def?.valueType) {
    case 'money_eur':
    case 'money_cents':
    case 'json':
      return null;
    case 'date':
      return str(fmt.date(value));
    case 'number': {
      const n = num(value);
      if (n == null) return str(value);
      const unit = def.unit ? UNIT_LABELS[def.unit] ?? def.unit : '';
      return `${fmt.number(n, 2)}${unit ? ` ${unit}` : ''}`;
    }
    case 'boolean':
      return value === true || value === 'true' ? 'Oui' : value === false || value === 'false' ? 'Non' : str(value);
    case 'enum':
      return str(def.enumLabels?.[String(value)]) ?? humanize(value);
    default:
      return str(value);
  }
}

/**
 * Caractéristiques d'un équipement pour les tableaux d'équipement EXISTANTS
 * (CDC 15, D-N) : champs renseignés de sa fiche canonique (puissance, COP,
 * fluide frigorigène, compteur, entretien, garantie…) dans l'ordre du
 * registre, « Libellé : valeur » joints par « · ». Le numéro de série n'y
 * figure que dans les dossiers CIL et assurance, masqué comme dans le design.
 * Lecture historique (sans fiche canonique) : énergie seule.
 */
export function equipmentSpecs(s: ExportSource, e: SourceEquipment): string | null {
  const parts: string[] = [];
  const energy = humanize(e.energyType);
  const fields = (e.fields ?? [])
    .filter((f) => !EQUIPMENT_SPEC_SKIPPED.has(f.key))
    .slice().sort((a, b) => (REGISTRY_RANK.get(a.key) ?? 1e6) - (REGISTRY_RANK.get(b.key) ?? 1e6));
  if (energy && !fields.some((f) => /energ/i.test(f.key))) parts.push(`Énergie : ${energy}`);
  for (const f of fields) {
    if (f.key === 'serialNumber') {
      if (!serialNumberAllowed(s)) continue;
      const v = masked(f.value, { start: 12, end: 3, dots: 3 });
      if (v) parts.push(`${f.label} : ${v}`);
      continue;
    }
    const v = equipmentFieldValue(f.key, f.value);
    if (v) parts.push(`${f.label} : ${v}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

/** Point focal sûr pour `object-position` (évite toute injection CSS). */
export function safeFocus(v: unknown): string {
  const s = str(v);
  return s && /^\d{1,3}% \d{1,3}%$/.test(s) ? s : '50% 50%';
}

/**
 * Lignes « Informations principales » adaptées à la famille, quand la famille
 * du bien n'est pas celle du design du dossier (`asset.infoRows`).
 */
export function familyInfoRows(s: ExportSource): Array<{ label: string; value: Nullable<string | number> }> {
  if (s.family === 'IMMOBILIER') {
    return [
      { label: 'Type', value: categoryName(s) },
      { label: 'Surface habitable', value: fmt.area(kcNum(s, 'livingArea')) },
      { label: 'Adresse', value: s.asset.address },
      { label: 'Pièces', value: roomsLabel(s) },
      { label: 'Ville', value: cityLine(s) },
      { label: 'Étage', value: kc(s, 'floor') },
      { label: 'Année de construction', value: kcNum(s, 'constructionYear') },
      { label: 'État', value: conditionLabel(s) },
      { label: 'DPE / GES', value: dot(kc(s, 'dpeClass'), kc(s, 'gesClass')) },
      { label: 'Chauffage', value: heatingLabel(s) },
      { label: 'Surface du terrain', value: fmt.area(kcNum(s, 'landArea')) },
      { label: 'Niveaux', value: kcNum(s, 'levels') },
    ];
  }
  if (s.family === 'VEHICULE') {
    const mileage = kcNum(s, 'mileage') ?? s.asset.mileageOrHours;
    return [
      { label: 'Marque · modèle', value: dot(kc(s, 'make'), kc(s, 'model')) },
      { label: 'Kilométrage', value: dot(fmt.km(mileage), kc(s, 'mileageDate') ? `relevé ${fmt.date(kc(s, 'mileageDate'))}` : '') },
      { label: 'Année', value: kcNum(s, 'year') },
      { label: 'Motorisation', value: dot(kc(s, 'engine') ?? s.asset.engineInfo, humanize(kc(s, 'fuelType'))) },
      { label: "Date d'achat", value: fmt.date(s.asset.purchaseDate) },
      { label: 'Puissance', value: kcNum(s, 'powerKw') != null ? `${fmt.number(kcNum(s, 'powerKw'))} kW` : '' },
      { label: 'N° de série (VIN)', value: masked(kc(s, 'vin')) },
      { label: 'Immatriculation', value: masked(s.asset.registrationNumber ?? kc(s, 'registrationNumber'), { start: 2, end: 2, dots: 3 }) },
      { label: 'Première mise en circulation', value: fmt.date(kc(s, 'firstRegistrationDate')) },
      { label: 'État déclaré', value: conditionLabel(s) },
      { label: 'Places', value: kcNum(s, 'seats') },
      { label: 'Usage', value: humanize(kc(s, 'primaryUse')) },
    ];
  }
  return [
    { label: 'Catégorie', value: categoryName(s) },
    { label: 'Marque · modèle', value: dot(kc(s, 'brand'), kc(s, 'modelName')) },
    // D-N : numéro de série seulement dans les dossiers CIL et assurance.
    ...(serialNumberAllowed(s) ? [{ label: 'Numéro de série', value: masked(kc(s, 'serialNumber'), { start: 12, end: 3, dots: 3 }) }] : []),
    { label: "Date d'achat", value: fmt.date(s.asset.purchaseDate) },
    { label: 'Dimensions', value: kc(s, 'dimensions') ?? s.asset.dimensions },
    { label: 'Poids', value: kc(s, 'weight') },
    { label: 'État', value: conditionLabel(s) },
    { label: 'Lieu de conservation', value: kc(s, 'storageLocation') },
    { label: 'Provenance', value: dot(humanize(kc(s, 'acquisitionMode')), kc(s, 'provenance')) },
    { label: 'Accessoires', value: kc(s, 'accessories') },
  ];
}

/** Résumé factuel du bien : description saisie, sinon phrase composée des seules données présentes. */
export function factualSummary(s: ExportSource): string | null {
  const own = str(s.asset.description);
  if (own) return own;
  const parts: string[] = [];
  const cat = categoryName(s);
  if (s.family === 'IMMOBILIER') {
    const area = kcNum(s, 'livingArea');
    const rooms = kcNum(s, 'roomCount');
    const year = kcNum(s, 'constructionYear');
    const head = [cat ?? s.asset.name, rooms != null ? `de ${rooms} pièce${rooms > 1 ? 's' : ''}` : '', area != null ? `(${fmt.area(area)})` : '']
      .filter(Boolean).join(' ');
    parts.push(`${head}${s.asset.city ? ` situé à ${s.asset.city}` : ''}${year ? `, construit en ${year}` : ''}.`);
  } else if (s.family === 'VEHICULE') {
    const mm = dot(kc(s, 'make'), kc(s, 'model')).replace(' · ', ' ');
    const year = kcNum(s, 'year');
    const km = kcNum(s, 'mileage') ?? s.asset.mileageOrHours;
    parts.push(`${[cat, mm].filter(Boolean).join(' ') || s.asset.name}${year ? ` de ${year}` : ''}${km != null ? `, ${fmt.km(km)} au compteur` : ''}.`);
  } else {
    const mm = [kc(s, 'brand'), kc(s, 'modelName')].filter(Boolean).join(' ');
    parts.push(`${[cat, mm].filter(Boolean).join(' ') || s.asset.name}${s.asset.purchaseDate ? `, acquis le ${fmt.date(s.asset.purchaseDate)}` : ''}.`);
  }
  const cond = conditionLabel(s);
  if (cond) parts.push(`État déclaré : ${cond.toLowerCase()}.`);
  return parts.join(' ').trim() || null;
}

// ─── Pièces et photos ───────────────────────────────────────────────────────

/** Identifiant d'une pièce dans les données (`docId` des tableaux). */
export const docRef = (id: number): string => `d${id}`;

/** Pièce retenue → `DocItem` (état de fichier résolu, aperçu d'annexe). */
export function toDocItem(pd: PlannedDocument, section: string, m: MapInput, extra: Partial<DocItem> = {}): DocItem {
  const d = pd.doc;
  const r = m.resolved?.documents.get(d.id);
  const failed = !!m.resolved && (!r || r.status !== 'ok');
  const isImage = IMAGE_FORMATS.has(d.format.toUpperCase());
  const pages = r?.pages ?? (isImage ? 1 : null);
  let preview: DocItem['preview'];
  if (pd.mode === 'PDF' && r?.status === 'ok') {
    preview = isImage
      ? { kind: 'image', pages: [{ src: r.imageUrl ?? null }] }
      : { kind: 'pdf', pages: Array.from({ length: r.pages ?? 1 }, () => ({ overlay: true })) };
  } else if (pd.mode === 'PDF') {
    preview = { kind: isImage ? 'image' : 'pdf' };
  }
  return {
    id: docRef(d.id),
    section,
    title: d.title,
    typeLabel: d.typeLabel || null,
    date: d.date,
    pages,
    format: d.format,
    mode: pd.mode,
    selected: true,
    sensitive: d.sensitive,
    occupantData: d.occupantData,
    // SEL-GEN-006 / ZIP-008 : fichier manquant, protégé ou illisible exclu partout.
    corrupted: failed,
    tone: documentTone(d.kind) ?? null,
    fileName: d.fileName,
    sizeBytes: d.sizeBytes,
    preview,
    ...extra,
  };
}

/** Pièces retenues dans l'ordre (date croissante, puis titre). */
export const sortedDocuments = (m: MapInput, filter: (d: SourceDocument) => boolean = () => true): PlannedDocument[] =>
  m.plan.documents.filter((pd) => filter(pd.doc))
    .slice().sort((a, b) => String(a.doc.date ?? '').localeCompare(String(b.doc.date ?? '')) || a.doc.title.localeCompare(b.doc.title));

/** Photo retenue → `PhotoItem` (clé de fichier résolue par `ctx.asset`). */
export function toPhotoItem(pp: PlannedPhoto, m: MapInput, extra: Partial<PhotoItem> = {}): PhotoItem {
  const p = pp.photo;
  const r = m.resolved?.photos.get(p.id);
  return {
    id: `p${p.id}`,
    file: photoFileKey(p.id),
    caption: str(p.caption),
    focus: safeFocus(null),
    selected: pp.mode === 'PDF',
    sensitive: false,
    corrupted: !!m.resolved && (!r || r.status !== 'ok'),
    cover: p.isPrimary,
    ...extra,
  };
}

export const plannedPhotos = (m: MapInput): PlannedPhoto[] => m.plan.photos.filter((pp) => pp.mode === 'PDF');

/** Événements retenus d'une section (ordre chronologique). */
export function selectedEvents(m: MapInput, predicate: (e: SourceEvent) => boolean = () => true): SourceEvent[] {
  return m.source.events
    .filter((e) => m.plan.events.has(e.key) && predicate(e))
    .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
}

export const sectionOn = (m: MapInput, id: string): boolean => m.plan.sections[id] !== false;

export { isEmpty };
