/**
 * BO › Comptes › fiche d'un compte › « Données du compte » (lot 75N) —
 * vocabulaire, masquage et sérialiseurs PURS.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE STRUCTURE : LE DOSSIER D'ENTITÉ
 *
 * Le tiroir, « Copier tout » (texte, JSON) et les téléchargements (JSON, CSV,
 * TXT) sont TOUS produits depuis le même `EntityDossier`, construit côté
 * serveur (`dossier.ts`), horodaté (`extractedAt`) et déjà masqué. Ce module
 * ne lit pas la base et n'importe rien de serveur : la page BO l'utilise pour
 * copier, la route pour générer les fichiers — mêmes fonctions, même sortie.
 *
 * DISTINCTION DES ABSENCES (ticket §3.B, §5.D)
 *
 *   · valeur  : valeur réellement persistée, y compris 0, '' et false ;
 *   · null    : la colonne existe et vaut NULL en base ;
 *   · absent  : la colonne / la clé n'existe pas (schéma, JSON) ;
 *   · non chargé : non extrait (borne de lecture atteinte, section en erreur) ;
 *   · masqué  : présent en base mais jamais rendu (secret, clé de stockage,
 *     nom ou URL du fichier original, contenu intégral, donnée sensible).
 *
 * ADAPTATION DU CDC BACK-OFFICE V1 (ACC-D06, ACC-D07, SEC-001/002, REC-ACC-07)
 *
 * Le BO consulte désormais les données STRUCTURÉES persistées d'un document
 * (classification, montants, dates, faits T1, preuves, unités sources,
 * analyses, liens) ; restent interdits : le fichier original (aucun lien ni
 * URL de téléchargement, aucune clé ni emplacement de stockage), son nom
 * d'origine et son texte intégral (seule la longueur est donnée), les
 * secrets et jetons, et les données marquées sensibles par le registre
 * canonique (adresse, n° de contrat ou de client d'assurance, GPS).
 *
 * Dans les lignes tabulaires, une cellule non rendue est un MARQUEUR
 * `{ "$etat": "masque" | "absent" | "non_charge", "motif": … }` : jamais un
 * `null` qui se confondrait avec un NULL de la base.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { maskSensitiveString } from '@/services/business-operations/diagnostics/model';

export const ACCOUNT_DATA_SCHEMA = 'verebona.bo.donnees-compte/1';

// ── Catégories et types d'entité ────────────────────────────────────────────

export const ENTITY_TYPES = ['asset', 'equipment', 'room', 'document', 'agenda', 'deadline', 'operation'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const CATEGORIES = ['biens', 'equipements', 'pieces', 'documents', 'echeances', 'operations'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Readonly<Record<Category, string>> = {
  biens: 'Biens', equipements: 'Équipements', pieces: 'Pièces', documents: 'Documents', echeances: 'Échéances', operations: 'Opérations',
};

/** Type d'entité principal de chaque catégorie (Échéances : agenda + historique `deadlines`). */
export const CATEGORY_TYPES: Readonly<Record<Category, readonly EntityType[]>> = {
  biens: ['asset'], equipements: ['equipment'], pieces: ['room'], documents: ['document'], echeances: ['agenda', 'deadline'], operations: ['operation'],
};

export const ENTITY_LABELS: Readonly<Record<EntityType, string>> = {
  asset: 'Bien', equipment: 'Équipement', room: 'Pièce', document: 'Document', agenda: 'Échéance',
  deadline: 'Échéance historique (deadlines)', operation: 'Opération',
};

/** Segment du nom de fichier (`verebona-compte-123-equipement-456-2026-10-20.json`). */
export const ENTITY_SLUGS: Readonly<Record<EntityType, string>> = {
  asset: 'bien', equipment: 'equipement', room: 'piece', document: 'document', agenda: 'echeance', deadline: 'echeance-historique', operation: 'operation',
};

/** Table principale de chaque type (ticket §4). */
export const ENTITY_TABLES: Readonly<Record<EntityType, string>> = {
  asset: 'assets', equipment: 'equipments', room: 'substructures', document: 'asset_files', agenda: 'agenda_items',
  deadline: 'deadlines', operation: 'business_operations',
};

export const categoryOfType = (t: EntityType): Category =>
  (CATEGORIES.find((c) => CATEGORY_TYPES[c].includes(t)) as Category);

export function isEntityType(v: unknown): v is EntityType {
  return typeof v === 'string' && (ENTITY_TYPES as readonly string[]).includes(v);
}
export function isCategory(v: unknown): v is Category {
  return typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v);
}

/** Identifiant BDD strictement positif (≤ 9 chiffres), sinon null. */
export function entityId(v: string | null | undefined): number | null {
  if (!v || !/^\d{1,9}$/.test(v)) return null;
  const n = Number(v);
  return n > 0 ? n : null;
}

/** Référence d'entité d'un lien profond (`equipment-456`) — liste blanche stricte. */
export function parseEntityRef(v: string | null | undefined): { type: EntityType; id: number } | null {
  const m = /^([a-z]+)-(\d{1,9})$/.exec(v ?? '');
  if (!m || !isEntityType(m[1])) return null;
  const id = entityId(m[2]);
  return id ? { type: m[1], id } : null;
}
export const entityRef = (type: EntityType, id: number) => `${type}-${id}`;

// ── Onglets et structure du dossier ─────────────────────────────────────────

export const TABS = ['synthese', 'bdd', 'relations', 'preuves'] as const;
export type Tab = (typeof TABS)[number];
export const TAB_LABELS: Readonly<Record<Tab, string>> = {
  synthese: 'Synthèse', bdd: 'Données BDD', relations: 'Relations', preuves: 'Preuves et historique',
};

export type CellState = 'value' | 'null' | 'absent' | 'not_loaded' | 'masked';
export const CELL_STATE_LABELS: Readonly<Record<CellState, string>> = {
  value: 'valeur', null: 'NULL en base', absent: 'absent', not_loaded: 'non chargé', masked: 'masqué',
};

/** Marqueur d'une cellule non rendue (jamais confondu avec NULL). */
export interface CellMarker { $etat: 'masque' | 'absent' | 'non_charge'; motif?: string; longueur?: number }

export function isMarker(v: unknown): v is CellMarker {
  return !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Record<string, unknown>).$etat === 'string'
    && ['masque', 'absent', 'non_charge'].includes(String((v as Record<string, unknown>).$etat));
}
export const masked = (motif: string, longueur?: number): CellMarker => (longueur === undefined ? { $etat: 'masque', motif } : { $etat: 'masque', motif, longueur });
export const absent = (motif?: string): CellMarker => (motif ? { $etat: 'absent', motif } : { $etat: 'absent' });
export const notLoaded = (motif?: string): CellMarker => (motif ? { $etat: 'non_charge', motif } : { $etat: 'non_charge' });

/** État d'une valeur brute (cellule de table ou champ). */
export function cellState(v: unknown): CellState {
  if (v === undefined) return 'absent';
  if (v === null) return 'null';
  if (isMarker(v)) return v.$etat === 'masque' ? 'masked' : v.$etat === 'absent' ? 'absent' : 'not_loaded';
  return 'value';
}

export interface DossierField {
  /** Table et colonne d'origine (ticket §3.B « Données BDD »). */
  table: string;
  column: string;
  /** Chemin dans une colonne JSON (`key_characteristics.acquisitionPrice`), le cas échéant. */
  path?: string;
  label: string;
  state: CellState;
  /** Valeur brute persistée (absente si état ≠ valeur / null). */
  raw?: unknown;
  /** Valeur métier formatée (avec unité). */
  display?: string;
  unit?: string | null;
  origin?: string | null;
  /** Origine lisible (USER, ADMIN, T1, T3, règle déterministe) quand elle est établie. */
  originLabel?: string | null;
  updatedAt?: string | null;
  note?: string | null;
}

export interface DossierTable {
  table: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  /** Nombre réel de lignes en base (null si non compté). */
  total: number | null;
  /** Toutes les lignes ont été extraites (sinon : borne atteinte, avertissement). */
  complete: boolean;
  limit: number;
}

export interface DossierRelation {
  type: EntityType;
  id: number;
  label: string;
  /** Nature du lien (« bien parent », « document source », …). */
  nature: string;
  status?: string | null;
  origin?: string | null;
  /** Table / colonne qui porte le lien. */
  via: string;
}

export interface DossierSection {
  id: string;
  tab: Tab;
  title: string;
  description?: string;
  fields?: DossierField[];
  table?: DossierTable;
  relations?: DossierRelation[];
  /** Section non chargée (erreur de lecture) : motif. */
  error?: string;
}

export interface EntityDossier {
  schema: typeof ACCOUNT_DATA_SCHEMA;
  extractedAt: string;
  accountId: number;
  entity: {
    type: EntityType;
    typeLabel: string;
    id: number;
    table: string;
    name: string;
    status: string | null;
    statusLabel: string | null;
  };
  /** false : au moins une section bornée ou en erreur (voir `warnings`). */
  complete: boolean;
  warnings: string[];
  sections: DossierSection[];
  /** Opération : détail `OperationDiagnosticsService` (rendu par `OperationDetailView`). */
  operationDetail?: unknown;
}

// ── Origines ────────────────────────────────────────────────────────────────

const ORIGIN_LABELS: Readonly<Record<string, string>> = {
  USER: 'USER (saisie utilisateur)',
  ADMIN: 'ADMIN',
  DOCUMENT_EXTRACTION: 'T1 (extraction documentaire)',
  RECONCILIATION: 'T3 (réconciliation)',
  SYSTEM_RULE: 'Règle déterministe',
  IMPORT: 'Import',
};
/** Libellé d'origine — seulement pour les codes établis ; sinon le code brut. */
export function originLabel(code: unknown): string | null {
  if (code === null || code === undefined || code === '') return null;
  const c = String(code);
  return ORIGIN_LABELS[c.toUpperCase()] ?? c;
}

// ── Masquage ────────────────────────────────────────────────────────────────

/**
 * Colonnes / clés JSON jamais rendues (ticket §8) : clés et emplacements de
 * stockage, nom et URL du fichier original (CDC BO REC-ACC-07 maintenu),
 * secrets et jetons, contenu intégral d'un document (texte extrait, réponse
 * brute du modèle — seule sa longueur est donnée).
 */
const MASK_RULES: ReadonlyArray<{ test: RegExp; motif: string; length?: boolean }> = [
  { test: /^(s3_?key|s3_?bucket|s3_?region|storage_?key|blob_?key)$/i, motif: 'clé de stockage' },
  { test: /^(filename|original_?filename|file_?name)$/i, motif: 'nom du fichier original' },
  { test: /(^url$|_url$|Url$)/, motif: 'URL de fichier ou de lien' },
  { test: /(password|secret|token|api_?key|credential|signature_?key)/i, motif: 'secret ou jeton' },
  { test: /^(iban|bic|swift|rib)$/i, motif: 'coordonnées bancaires' },
  { test: /^(extracted_text|full_text|raw_response_json|content_base64)$/i, motif: 'contenu intégral du document', length: true },
];

export function maskRuleFor(column: string): { motif: string; length?: boolean } | null {
  for (const r of MASK_RULES) if (r.test.test(column)) return r;
  return null;
}

/** Longueur d'une valeur masquée (texte : caractères ; JSON : taille sérialisée). */
const lengthOf = (v: unknown): number => (typeof v === 'string' ? v.length : JSON.stringify(v)?.length ?? 0);

/** Suffixes de métadonnées d'une clé de fiche (`<clé>__origin`…). */
const KC_META = /__(origin|updatedAt|source|sourceUnit|userValidated|evidenceId|confidence)$/;
export const kcBaseKey = (k: string) => k.replace(KC_META, '');

export interface MaskOptions {
  /** Clé canonique (ou alias) sensible au sens du registre (adresse, n° de contrat…). */
  isSensitiveKey?: (key: string) => boolean;
}

/**
 * Masquage profond d'une valeur (objet JSON, tableau, texte) : clés
 * interdites remplacées par un marqueur, IBAN masqués dans les textes, clés
 * canoniques sensibles masquées dans les fiches.
 */
export function maskDeep(value: unknown, opts: MaskOptions = {}): unknown {
  if (typeof value === 'string') return maskSensitiveString(value);
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, opts));
  if (value && typeof value === 'object' && !(value instanceof Date) && !isMarker(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const rule = maskRuleFor(k);
      if (rule && v !== null && v !== undefined) out[k] = masked(rule.motif, rule.length ? lengthOf(v) : undefined);
      else if (opts.isSensitiveKey?.(kcBaseKey(k)) && !KC_META.test(k) && v !== null && v !== undefined) out[k] = masked('donnée sensible (registre)');
      else out[k] = maskDeep(v, opts);
    }
    return out;
  }
  return value;
}

/** Colonnes de clé de champ et colonnes de valeur des tables de preuves (masquage par clé sensible). */
const KEY_COLUMNS = ['field_key', 'canonical_key', 'fact_key', 'data_key', 'target_key', 'raw_key', 'origin_field_key'] as const;
const VALUE_COLUMNS = new Set([
  'value_json', 'normalized_value', 'raw_value', 'evidence_excerpt', 'value_text', 'value_number', 'old_value', 'new_value',
  'previous_value', 'proposed_value_json', 'final_value_json', 'excerpt', 'original_payload', 'proposals_json', 'trigger_context',
]);

/**
 * Masquage d'une ligne persistée : colonnes interdites → marqueur ; si la
 * ligne porte une clé canonique sensible, ses colonnes de valeur → marqueur ;
 * le reste est masqué en profondeur (JSON).
 */
export function maskRow(row: Record<string, unknown>, opts: MaskOptions = {}): Record<string, unknown> {
  const sensitiveRow = !!opts.isSensitiveKey && KEY_COLUMNS.some((c) => typeof row[c] === 'string' && opts.isSensitiveKey!(String(row[c])));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const rule = maskRuleFor(k);
    if (rule && v !== null && v !== undefined) out[k] = masked(rule.motif, rule.length ? lengthOf(v) : undefined);
    else if (sensitiveRow && VALUE_COLUMNS.has(k) && v !== null && v !== undefined) out[k] = masked('donnée sensible (registre)');
    else out[k] = maskDeep(v, opts);
  }
  return out;
}

// ── Formatage ───────────────────────────────────────────────────────────────

const TZ = 'Europe/Paris';
const pad = (n: number) => String(n).padStart(2, '0');

function frDate(v: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}
function frDateTime(v: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  return `${p('day')}/${p('month')}/${p('year')} ${p('hour')}:${p('minute')}:${p('second')} (Paris)`;
}
/** Montant en unités mineures → « 1 399,00 € » (séparateurs normalisés, sans espace insécable). */
export function formatMinor(minor: number, currency = 'EUR'): string {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const units = Math.floor(abs / 100);
  const cents = abs % 100;
  const grouped = String(units).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const sym = currency.toUpperCase() === 'EUR' ? '€' : currency.toUpperCase();
  return `${neg ? '-' : ''}${grouped},${pad(cents)} ${sym}`;
}
/** Montant en euros (nombre décimal) → « 1 399,00 € ». */
export function formatEur(eur: number): string {
  return formatMinor(Math.round(eur * 100), 'EUR');
}

/** Texte d'une valeur brute, intégral (jamais tronqué) : JSON pour les objets. */
export function rawText(v: unknown): string {
  if (v === undefined) return '';
  if (v === null) return 'NULL';
  if (isMarker(v)) return `[${v.$etat === 'masque' ? 'masqué' : v.$etat === 'absent' ? 'absent' : 'non chargé'}${v.motif ? ` : ${v.motif}` : ''}${v.longueur !== undefined ? ` ; ${v.longueur} caractères` : ''}]`;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v);
}

/**
 * Valeur métier formatée et unité d'une colonne (heuristique de nommage du
 * schéma Verebona : `_cents`, `_minor`, `_date`, `_at`). La valeur brute est
 * TOUJOURS conservée à côté : ce formatage n'en remplace jamais aucune.
 */
export function formatColumn(column: string, v: unknown, row?: Record<string, unknown>): { display: string; unit: string | null } {
  if (v === undefined || v === null || isMarker(v)) return { display: rawText(v), unit: null };
  if (typeof v === 'boolean') return { display: v ? 'Oui' : 'Non', unit: null };
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : null;
  if (/_cents$/.test(column) && n !== null) return { display: formatMinor(n, 'EUR'), unit: 'centimes EUR' };
  if (/_minor$/.test(column) && n !== null) {
    const cur = String(row?.currency ?? row?.principal_currency ?? 'EUR').trim() || 'EUR';
    return { display: formatMinor(n, cur), unit: `unités mineures ${cur}` };
  }
  if (typeof v === 'string') {
    const d = frDate(v);
    if (d) return { display: d, unit: null };
    const dt = frDateTime(v);
    if (dt) return { display: dt, unit: null };
    return { display: v, unit: null };
  }
  if (typeof v === 'object') return { display: JSON.stringify(v), unit: 'JSON' };
  return { display: String(v), unit: null };
}

/** Champ d'une colonne persistée (onglet « Données BDD »). */
export function columnField(table: string, column: string, v: unknown, row?: Record<string, unknown>, label?: string): DossierField {
  const state = cellState(v);
  const f: DossierField = { table, column, label: label ?? column, state };
  if (state === 'value' || state === 'null') f.raw = v;
  if (state === 'masked' || state === 'not_loaded' || state === 'absent') {
    const m = v as CellMarker | undefined;
    f.note = m?.motif ? `${m.motif}${m.longueur !== undefined ? ` (${m.longueur} caractères)` : ''}` : null;
  }
  if (state === 'value') {
    const { display, unit } = formatColumn(column, v, row);
    f.display = display;
    f.unit = unit;
  }
  return f;
}

/** Tous les champs d'une ligne, dans l'ordre des colonnes de la table. */
export function rowFields(table: string, row: Record<string, unknown>): DossierField[] {
  return Object.keys(row).map((c) => columnField(table, c, row[c], row));
}

// ── Nommage des fichiers ────────────────────────────────────────────────────

/** Date du jour (Europe/Paris) d'un horodatage ISO : `2026-10-20`. */
export function parisDay(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('fr-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return parts.slice(0, 10);
}

export type ExportFormat = 'json' | 'csv' | 'txt';
export const EXPORT_FORMATS: readonly ExportFormat[] = ['json', 'csv', 'txt'];

/** `verebona-compte-123-equipement-456-2026-10-20.json` (section CSV : `…-<section>.csv`). */
export function exportFileName(d: Pick<EntityDossier, 'accountId' | 'entity' | 'extractedAt'>, format: ExportFormat, sectionId?: string | null): string {
  const section = sectionId ? `-${sectionId.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}` : '';
  return `verebona-compte-${d.accountId}-${ENTITY_SLUGS[d.entity.type]}-${d.entity.id}-${parisDay(d.extractedAt)}${section}.${format}`;
}

// ── Sérialiseurs (même structure pour la copie et le téléchargement) ─────────

export function dossierToJson(d: EntityDossier): string {
  return JSON.stringify(d, null, 2);
}

function fieldLine(f: DossierField): string {
  const where = `${f.table}.${f.column}${f.path ? ` › ${f.path}` : ''}`;
  const parts: string[] = [];
  if (f.state === 'value' || f.state === 'null') parts.push(`brut=${rawText(f.raw)}`);
  else parts.push(`état=${CELL_STATE_LABELS[f.state]}`);
  if (f.display !== undefined && f.display !== rawText(f.raw)) parts.push(`affiché=${f.display}`);
  if (f.unit) parts.push(`unité=${f.unit}`);
  if (f.origin) parts.push(`origine=${f.originLabel ?? f.origin}`);
  if (f.updatedAt) parts.push(`modifié=${f.updatedAt}`);
  if (f.note) parts.push(`note=${f.note}`);
  return `- ${f.label} [${where}] : ${parts.join(' | ')}`;
}

function relationLine(r: DossierRelation): string {
  const extra = [r.status ? `statut ${r.status}` : null, r.origin ? `origine ${r.origin}` : null, `via ${r.via}`].filter(Boolean).join(', ');
  return `- ${r.nature} : ${ENTITY_LABELS[r.type]} #${r.id} « ${r.label} » (${extra})`;
}

function tableLines(t: DossierTable): string[] {
  const out = [`Table ${t.table} — ${t.rows.length} ligne(s) extraite(s)${t.total !== null ? ` sur ${t.total}` : ''}${t.complete ? '' : ` — INCOMPLET (borne ${t.limit})`}`];
  t.rows.forEach((r, i) => {
    out.push(`  [${i + 1}] ${t.columns.map((c) => `${c}=${rawText(r[c])}`).join(' ; ')}`);
  });
  return out;
}

/** Version lisible (« Copier tout » texte, export TXT) — intégrale, sans troncature. */
export function dossierToText(d: EntityDossier): string {
  const L: string[] = [];
  L.push(`Verebona — Back-office — Données du compte #${d.accountId}`);
  L.push(`${d.entity.typeLabel} #${d.entity.id} — ${d.entity.name}`);
  L.push(`Table principale : ${d.entity.table} · Statut : ${d.entity.statusLabel ?? d.entity.status ?? 'NULL'}`);
  L.push(`Extraction : ${d.extractedAt} (format ${d.schema})`);
  L.push(d.complete ? 'Complétude : extraction complète.' : 'Complétude : EXTRACTION INCOMPLÈTE — voir les avertissements.');
  for (const w of d.warnings) L.push(`AVERTISSEMENT : ${w}`);
  for (const tab of TABS) {
    const sections = d.sections.filter((s) => s.tab === tab);
    if (!sections.length) continue;
    L.push('', `######## ${TAB_LABELS[tab]} ########`);
    for (const s of sections) {
      L.push('', `== ${s.title} ==`);
      if (s.description) L.push(s.description);
      if (s.error) L.push(`[non chargé : ${s.error}]`);
      for (const f of s.fields ?? []) L.push(fieldLine(f));
      if (s.relations) {
        if (!s.relations.length) L.push('(aucune relation)');
        for (const r of s.relations) L.push(relationLine(r));
      }
      if (s.table) L.push(...tableLines(s.table));
    }
  }
  return `${L.join('\n')}\n`;
}

/** Cellule CSV (séparateur `;`, guillemets doublés ; neutralisation des formules Excel). */
export function csvCell(v: string): string {
  // Une valeur qui commence par = + @ (ou tabulation / retour) serait
  // interprétée comme une formule par Excel : préfixe apostrophe (documenté).
  const safe = /^[=+@\t\r]/.test(v) ? `'${v}` : v;
  return /[;"\r\n]/.test(safe) || safe !== safe.trim() ? `"${safe.replace(/"/g, '""')}"` : safe;
}
const csvLine = (cells: string[]) => cells.map(csvCell).join(';');
/** BOM UTF-8 (accents lus correctement par Excel) + fins de ligne CRLF. */
const csvDoc = (lines: string[]) => `﻿${lines.join('\r\n')}\r\n`;

export const CSV_COLUMNS = ['onglet', 'section', 'table', 'ligne', 'champ', 'libelle', 'etat', 'valeur_brute', 'valeur_affichee', 'unite', 'origine', 'modifie_le', 'note'] as const;

/** CSV « long » de tout le dossier : une ligne par champ, par cellule et par relation. */
export function dossierToCsv(d: EntityDossier): string {
  const lines = [csvLine([...CSV_COLUMNS])];
  lines.push(csvLine(['meta', 'extraction', '', '', 'extractedAt', 'Horodatage d’extraction', 'valeur', d.extractedAt, '', '', '', '', d.complete ? 'complète' : `INCOMPLÈTE : ${d.warnings.join(' / ')}`]));
  for (const s of d.sections) {
    const tab = TAB_LABELS[s.tab];
    if (s.error) lines.push(csvLine([tab, s.title, '', '', '', '', 'non chargé', '', '', '', '', '', s.error]));
    for (const f of s.fields ?? []) {
      lines.push(csvLine([tab, s.title, f.table, '', f.path ? `${f.column}.${f.path}` : f.column, f.label, CELL_STATE_LABELS[f.state],
        f.state === 'value' || f.state === 'null' ? rawText(f.raw) : '', f.display ?? '', f.unit ?? '', f.originLabel ?? f.origin ?? '', f.updatedAt ?? '', f.note ?? '']));
    }
    for (const r of s.relations ?? []) {
      lines.push(csvLine([tab, s.title, r.via, String(r.id), r.type, ENTITY_LABELS[r.type], 'valeur', String(r.id), r.label, '', r.origin ?? '', '', `${r.nature}${r.status ? ` ; statut ${r.status}` : ''}`]));
    }
    if (s.table) {
      const t = s.table;
      t.rows.forEach((row, i) => {
        const ligne = row.id !== undefined && !isMarker(row.id) ? String(row.id) : String(i + 1);
        for (const c of t.columns) {
          const v = row[c];
          const st = cellState(v);
          const { display, unit } = st === 'value' ? formatColumn(c, v, row) : { display: '', unit: null };
          lines.push(csvLine([tab, s.title, t.table, ligne, c, c, CELL_STATE_LABELS[st], st === 'value' || st === 'null' ? rawText(v) : '', display, unit ?? '', '', '', isMarker(v) ? rawText(v) : '']));
        }
      });
      if (!t.complete) lines.push(csvLine([tab, s.title, t.table, '', '', '', 'non chargé', '', '', '', '', '', `INCOMPLET : ${t.rows.length} ligne(s) extraite(s) sur ${t.total ?? '?'} (borne ${t.limit})`]));
    }
  }
  return csvDoc(lines);
}

/** CSV « large » d'UNE section tabulaire (colonnes de la table conservées). */
export function sectionToCsv(s: DossierSection): string | null {
  if (s.table) {
    const t = s.table;
    const lines = [csvLine(t.columns), ...t.rows.map((r) => csvLine(t.columns.map((c) => rawText(r[c]))))];
    return csvDoc(lines);
  }
  if (s.fields) {
    const cols = ['table', 'colonne', 'chemin', 'libelle', 'etat', 'valeur_brute', 'valeur_affichee', 'unite', 'origine', 'modifie_le', 'note'];
    return csvDoc([csvLine(cols), ...s.fields.map((f) => csvLine([f.table, f.column, f.path ?? '', f.label, CELL_STATE_LABELS[f.state],
      f.state === 'value' || f.state === 'null' ? rawText(f.raw) : '', f.display ?? '', f.unit ?? '', f.originLabel ?? f.origin ?? '', f.updatedAt ?? '', f.note ?? '']))]);
  }
  if (s.relations) {
    const cols = ['type', 'id', 'libelle', 'nature', 'statut', 'origine', 'via'];
    return csvDoc([csvLine(cols), ...s.relations.map((r) => csvLine([r.type, String(r.id), r.label, r.nature, r.status ?? '', r.origin ?? '', r.via]))]);
  }
  return null;
}

/** Texte complet d'un champ copié (« Copier » d'une valeur) : la valeur brute intégrale. */
export function fieldCopyText(f: DossierField): string {
  if (f.state === 'value' || f.state === 'null') return rawText(f.raw);
  return `[${CELL_STATE_LABELS[f.state]}${f.note ? ` : ${f.note}` : ''}]`;
}
