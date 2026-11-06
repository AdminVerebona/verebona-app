/**
 * Lecture DÉTERMINISTE des faits T1 persistés pour les structures CIL
 * spécialisées (lot 111U) — B5 `energy_materials`, B6 `equipments` /
 * `equipment_cil_specs`, recommandations (jamais B7).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÉFÉRENTIEL DE VOCABULAIRE, PAS DE RÈGLE PAR DOCUMENT
 *
 * T1 rend des faits génériques (`canonical_key` NULL) décomposés en sujet /
 * attribut / valeur / unité (contrat t1-contract `t1Fact`), avec preuve. Ce
 * module reconnaît, dans ces champs STRUCTURÉS (jamais dans le texte libre
 * ni dans l'extrait) :
 *   · le POSTE d'enveloppe (sujet reconnu EN TÊTE, comme les types
 *     d'équipement de `energy-equipment.ts`) → `energy_materials.category` ;
 *   · l'USAGE énergétique d'un système (même référentiel d'usages que B6) ;
 *   · l'attribut (nature, épaisseur, résistance thermique R, lambda, surface,
 *     énergie, puissance, marque, modèle) et son unité ;
 *   · la nature de la déclaration : un fait marqué recommandation, scénario,
 *     projet, devis ou échéance (DEADLINE) n'est JAMAIS une donnée constatée
 *     ni une réalisation.
 * Un fait non reconnu reste dans `document_facts` (aucune perte) : il est
 * relu au passage suivant si le référentiel s'enrichit.
 * Pur, sans accès base ; testé (L111U-U-VOCAB).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { CilEnergyUsage } from './energy-equipment';

export type CilMaterialPost = 'toiture' | 'murs_exterieurs' | 'parois_vitrees' | 'planchers_bas';
export const CIL_MATERIAL_POSTS: readonly CilMaterialPost[] = ['toiture', 'murs_exterieurs', 'parois_vitrees', 'planchers_bas'];

export type CilMaterialAttribute = 'materialNature' | 'thicknessMm' | 'thermalResistanceR' | 'lambda' | 'surfaceSqm' | 'brand' | 'reference' | 'uValue';
export type CilSystemAttribute = 'type' | 'energy' | 'powerKw' | 'brand' | 'model';

/** Fait persisté tel que relu (`document_facts`, colonnes historiques et 0218). */
export interface CilFactInput {
  id: number;
  fileId: number;
  factKey: string;
  canonicalKey?: string | null;
  rawKey?: string | null;
  subject: string | null;
  attribute: string | null;
  label: string | null;
  valueText: string | null;
  valueNumber: number | null;
  valueUnit: string | null;
  normalizedValue: string | null;
  confidence: string;
  targetType?: string | null;
  targetEntityId?: number | null;
  semanticEventNature?: string | null;
}

export type CilRecognizedFact =
  | { kind: 'material'; post: CilMaterialPost; attribute: CilMaterialAttribute; value: string | number }
  | { kind: 'system'; usage: CilEnergyUsage; attribute: CilSystemAttribute; value: string | number }
  | { kind: 'recommendation'; topic: CilMaterialPost | CilEnergyUsage | 'autre' };

export const norm = (v: unknown): string => String(v ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/([a-z])([A-Z])/g, '$1 $2')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Mots d'en-tête neutres retirés avant la reconnaissance du sujet. */
const LEADING_NEUTRAL = new Set(['isolation', 'isolant', 'composition', 'description', 'caracteristiques', 'paroi', 'parois',
  'de', 'des', 'du', 'la', 'le', 'les', 'l', 'd', 'en', 'cil', 'b5', 'b6', 'etat', 'actuel', 'existant', 'existante']);

function headOf(v: unknown): string {
  const words = norm(v).split(' ').filter(Boolean);
  let i = 0;
  while (i < words.length - 1 && LEADING_NEUTRAL.has(words[i])) i++;
  return words.slice(i).join(' ');
}

/** Reconnaissance « en tête » : égalité ou préfixe suivi d'un espace ; l'entrée la plus longue l'emporte. */
function matchHead<T>(text: string, entries: ReadonlyArray<readonly [string, T]>): T | null {
  if (!text) return null;
  let best: { len: number; v: T } | null = null;
  for (const [e, v] of entries) {
    if ((text === e || text.startsWith(`${e} `)) && (!best || e.length > best.len)) best = { len: e.length, v };
  }
  return best?.v ?? null;
}

const POSTS: ReadonlyArray<readonly [string, CilMaterialPost]> = [
  ['toiture', 'toiture'], ['toit', 'toiture'], ['toiture terrasse', 'toiture'], ['combles', 'toiture'], ['comble', 'toiture'],
  ['combles perdus', 'toiture'], ['combles amenages', 'toiture'], ['rampants', 'toiture'], ['plafond', 'toiture'], ['plafonds', 'toiture'],
  ['plancher haut', 'toiture'], ['planchers hauts', 'toiture'], ['roof', 'toiture'], ['attic', 'toiture'],
  ['murs', 'murs_exterieurs'], ['mur', 'murs_exterieurs'], ['murs exterieurs', 'murs_exterieurs'], ['mur exterieur', 'murs_exterieurs'],
  ['facade', 'murs_exterieurs'], ['facades', 'murs_exterieurs'], ['opaques', 'murs_exterieurs'], ['walls', 'murs_exterieurs'], ['wall', 'murs_exterieurs'],
  ['fenetres', 'parois_vitrees'], ['fenetre', 'parois_vitrees'], ['menuiseries', 'parois_vitrees'], ['menuiserie', 'parois_vitrees'],
  ['vitrages', 'parois_vitrees'], ['vitrage', 'parois_vitrees'], ['vitrees', 'parois_vitrees'], ['baies', 'parois_vitrees'], ['baie vitree', 'parois_vitrees'],
  ['portes fenetres', 'parois_vitrees'], ['porte fenetre', 'parois_vitrees'], ['portes', 'parois_vitrees'], ['porte', 'parois_vitrees'],
  ['porte d entree', 'parois_vitrees'], ['windows', 'parois_vitrees'], ['glazing', 'parois_vitrees'],
  ['plancher bas', 'planchers_bas'], ['planchers bas', 'planchers_bas'], ['plancher', 'planchers_bas'], ['planchers', 'planchers_bas'],
  ['dalle', 'planchers_bas'], ['sol', 'planchers_bas'], ['vide sanitaire', 'planchers_bas'], ['sous sol', 'planchers_bas'], ['floor', 'planchers_bas'],
];

const USAGES: ReadonlyArray<readonly [string, CilEnergyUsage]> = [
  ['chauffage', 'chauffage'], ['systeme de chauffage', 'chauffage'], ['installation de chauffage', 'chauffage'], ['generateur', 'chauffage'],
  ['generateur de chauffage', 'chauffage'], ['chaudiere', 'chauffage'], ['pompe a chaleur', 'chauffage'], ['pac', 'chauffage'], ['heating', 'chauffage'],
  ['eau chaude sanitaire', 'ecs'], ['ecs', 'ecs'], ['production d eau chaude', 'ecs'], ['production ecs', 'ecs'], ['chauffe eau', 'ecs'],
  ['ballon d eau chaude', 'ecs'], ['hot water', 'ecs'],
  ['ventilation', 'ventilation'], ['vmc', 'ventilation'], ['systeme de ventilation', 'ventilation'],
  ['refroidissement', 'refroidissement'], ['climatisation', 'refroidissement'], ['climatiseur', 'refroidissement'], ['cooling', 'refroidissement'],
  ['energie renouvelable', 'enr'], ['energies renouvelables', 'enr'], ['panneaux solaires', 'enr'], ['panneau solaire', 'enr'],
  ['photovoltaique', 'enr'], ['panneaux photovoltaiques', 'enr'], ['capteurs solaires', 'enr'],
];

const MATERIAL_ATTRS: ReadonlyArray<readonly [string, CilMaterialAttribute]> = [
  ['epaisseur', 'thicknessMm'], ['epaisseur isolant', 'thicknessMm'], ['epaisseur d isolant', 'thicknessMm'], ['thickness', 'thicknessMm'],
  ['resistance thermique', 'thermalResistanceR'], ['resistance', 'thermalResistanceR'], ['r', 'thermalResistanceR'], ['valeur r', 'thermalResistanceR'],
  ['thermal resistance', 'thermalResistanceR'],
  ['lambda', 'lambda'], ['conductivite thermique', 'lambda'], ['conductivite', 'lambda'],
  ['surface', 'surfaceSqm'], ['surface isolee', 'surfaceSqm'],
  ['marque', 'brand'], ['reference', 'reference'],
  ['u', 'uValue'], ['uw', 'uValue'], ['ud', 'uValue'], ['up', 'uValue'], ['coefficient u', 'uValue'], ['coefficient de transmission', 'uValue'],
  ['transmission thermique', 'uValue'],
  ['insulation thickness', 'thicknessMm'], ['insulation material', 'materialNature'], ['insulation', 'materialNature'],
  ['isolation', 'materialNature'], ['isolant', 'materialNature'], ['materiau', 'materialNature'], ['materiau isolant', 'materialNature'],
  ['nature', 'materialNature'], ['type', 'materialNature'], ['type d isolation', 'materialNature'], ['type d isolant', 'materialNature'],
  ['composition', 'materialNature'], ['description', 'materialNature'], ['type de vitrage', 'materialNature'], ['vitrage', 'materialNature'],
  ['menuiserie', 'materialNature'], ['type de menuiserie', 'materialNature'], ['materiau de menuiserie', 'materialNature'],
];

const SYSTEM_ATTRS: ReadonlyArray<readonly [string, CilSystemAttribute]> = [
  ['type', 'type'], ['systeme', 'type'], ['generateur', 'type'], ['type de generateur', 'type'], ['equipement', 'type'], ['installation', 'type'],
  ['description', 'type'], ['nature', 'type'], ['type d installation', 'type'], ['type de systeme', 'type'], ['type de ventilation', 'type'],
  ['energie', 'energy'], ['energie utilisee', 'energy'], ['source d energie', 'energy'], ['combustible', 'energy'], ['type d energie', 'energy'],
  ['energy', 'energy'],
  ['puissance', 'powerKw'], ['puissance nominale', 'powerKw'], ['power', 'powerKw'],
  ['marque', 'brand'], ['fabricant', 'brand'], ['modele', 'model'], ['model', 'model'],
];

/**
 * Marqueurs d'une déclaration NON constatée (recommandation, scénario,
 * projet, devis, estimation de travaux) — lus dans sujet / attribut /
 * libellé / clé brute normalisés, jamais dans l'extrait.
 */
const NOT_OBSERVED_MARKERS = /\b(recommand\w*|preconis\w*|conseil\w*|scenarios?|apres travaux|projets?|projete\w*|devis|a prevoir|a realiser|ameliorations?|gains?|etapes?|parcours|cout estime|estimation du cout|travaux envisages|propositions?)\b/;

function notObserved(...vals: unknown[]): boolean {
  return NOT_OBSERVED_MARKERS.test(vals.map(norm).join(' | '));
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const m = /^\s*(-?\d+(?:[.,]\d+)?)/.exec(String(v ?? ''));
  return m ? Number(m[1].replace(',', '.')) : null;
};

const unitNorm = (u: unknown) => String(u ?? '').toLowerCase().replace(/\s+/g, '').replace('²', '2').replace('·', '.');

function thicknessToMm(value: number, unit: string, raw: string): number | null {
  const u = unit || unitNorm(/[a-zA-Z]+\s*$/.exec(raw)?.[0]);
  if (u === 'mm' || u === '') return u === '' && value < 1 ? null : Math.round(value);
  if (u === 'cm') return Math.round(value * 10);
  if (u === 'm') return Math.round(value * 1000);
  return null;
}

/** Valeur textuelle d'un fait (normalisée en priorité), rognée. */
function textOf(f: CilFactInput): string | null {
  const t = (f.normalizedValue ?? f.valueText ?? (f.valueNumber != null ? String(f.valueNumber) : '')).trim();
  return t || null;
}

/** Sujet et attribut effectifs : le sujet peut être absent quand la clé brute porte l'information (`roofInsulationThickness`). */
function subjectAndAttribute(f: CilFactInput): { subject: string; attribute: string } {
  const subject = headOf(f.subject ?? '');
  const attribute = norm(f.attribute ?? '');
  if (subject) return { subject, attribute };
  // Clé brute découpée : premier(s) mot(s) = sujet, reste = attribut (ex. « murs epaisseur »).
  const key = headOf(f.rawKey ?? f.factKey ?? '');
  return { subject: key, attribute };
}

/** Reconnaissance d'un fait ; `null` : hors vocabulaire CIL (fait conservé tel quel). */
export function recognizeCilFact(f: CilFactInput): CilRecognizedFact | null {
  // Seul le fait générique ou ciblé bien / équipement est lu ; une cible
  // document, fournisseur ou pièce n'alimente pas l'enveloppe ni les systèmes du bien.
  const tt = (f.targetType ?? 'GENERIC').toUpperCase();
  if (!['GENERIC', 'ASSET', 'EQUIPMENT'].includes(tt)) return null;
  // Clé canonique : relève du moteur T3 du registre — sauf `heatingType`, qui type le générateur de chauffage.
  if (f.canonicalKey && f.canonicalKey !== 'heatingType') return null;

  const { subject, attribute } = subjectAndAttribute(f);
  const recommendation = f.semanticEventNature === 'DEADLINE' || notObserved(f.subject, f.attribute, f.label, f.rawKey);

  if (f.canonicalKey === 'heatingType') {
    if (recommendation) return { kind: 'recommendation', topic: 'chauffage' };
    const v = textOf(f);
    return v ? { kind: 'system', usage: 'chauffage', attribute: 'type', value: v } : null;
  }

  const post = matchHead(subject, POSTS);
  const usage = post ? null : matchHead(subject, USAGES);
  if (!post && !usage) return null;
  if (recommendation) return { kind: 'recommendation', topic: post ?? usage ?? 'autre' };

  // Attribut : celui déclaré, sinon le reste de la clé après le sujet, sinon l'unité.
  const attrText = attribute || (() => {
    const s = norm(f.subject ?? '') ? '' : headOf(f.rawKey ?? f.factKey ?? '');
    const entry = post ? POSTS.find(([e, p]) => p === post && (s === e || s.startsWith(`${e} `)))?.[0]
      : USAGES.find(([e, u]) => u === usage && (s === e || s.startsWith(`${e} `)))?.[0];
    return entry ? s.slice(entry.length).trim() : '';
  })();
  const unit = unitNorm(f.valueUnit);
  const raw = textOf(f) ?? '';

  if (post) {
    let a = matchHead(attrText, MATERIAL_ATTRS);
    if (!a) {
      if (/m2\.?k\/w|m2k\/w/.test(unit)) a = 'thermalResistanceR';
      else if (/w\/\(?m\.?k\)?/.test(unit)) a = 'lambda';
      else if (unit === 'mm' || unit === 'cm') a = 'thicknessMm';
      else if (!attrText && raw && num(raw) == null) a = 'materialNature';
    }
    if (!a) return null;
    if (a === 'materialNature' || a === 'brand' || a === 'reference') {
      return raw ? { kind: 'material', post, attribute: a, value: raw } : null;
    }
    const n = f.valueNumber ?? num(raw);
    if (n == null || n < 0) return null;
    if (a === 'thicknessMm') {
      const mm = thicknessToMm(n, unit, raw);
      return mm != null && mm > 0 ? { kind: 'material', post, attribute: a, value: mm } : null;
    }
    if (a === 'surfaceSqm' && unit && !/^m2$/.test(unit)) return null;
    return { kind: 'material', post, attribute: a, value: n };
  }

  // Système énergétique
  let a = matchHead(attrText, SYSTEM_ATTRS);
  if (!a) {
    if (unit === 'kw' || unit === 'w') a = 'powerKw';
    else if (!attrText && raw && num(raw) == null) a = 'type';
  }
  if (!a) return null;
  if (a === 'powerKw') {
    const n = f.valueNumber ?? num(raw);
    if (n == null || n <= 0) return null;
    const kw = unit === 'w' ? n / 1000 : n;
    return { kind: 'system', usage: usage!, attribute: a, value: Math.round(kw * 100) / 100 };
  }
  return raw ? { kind: 'system', usage: usage!, attribute: a, value: raw } : null;
}

/** Comparaison de deux valeurs reconnues (texte normalisé, nombres à 1 % près). */
export function sameCilValue(a: string | number, b: string | number): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 0.01;
  return norm(a) === norm(b);
}

// ── B2 — contexte de constitution (lot 111U, deuxième passe) ─────────────────

export type CilTriggerType = 'construction' | 'renovation_energetique' | 'volontaire';

export type CilContextFact =
  | { kind: 'trigger'; value: CilTriggerType }
  | { kind: 'triggerDate'; value: string }
  | { kind: 'authorization'; value: 'permis_de_construire' | 'declaration_prealable' };

/** Sujets qui désignent le carnet lui-même (seuls à pouvoir dater sa constitution). */
const CARNET_SUBJECTS: ReadonlyArray<readonly [string, true]> = [
  ['carnet d information du logement', true], ['carnet d information', true], ['cil', true],
];
const AUTH_SUBJECTS: ReadonlyArray<readonly [string, 'permis_de_construire' | 'declaration_prealable']> = [
  ['permis de construire', 'permis_de_construire'],
  ['declaration prealable', 'declaration_prealable'], ['declaration prealable de travaux', 'declaration_prealable'],
];
const MOTIF_ATTRS = new Set(['motif', 'contexte', 'motif de constitution', 'contexte de constitution', 'objet', 'nature des travaux', 'nature du projet', 'objet des travaux']);
const DATE_ATTRS = new Set(['date de constitution', 'date d etablissement', 'date de creation']);
const TRIGGER_VALUES: ReadonlyArray<readonly [string, CilTriggerType]> = [
  ['construction neuve', 'construction'], ['construction', 'construction'], ['construction d une maison', 'construction'],
  ['construction d un logement', 'construction'], ['renovation energetique', 'renovation_energetique'],
  ['travaux de renovation energetique', 'renovation_energetique'], ['volontaire', 'volontaire'], ['demarche volontaire', 'volontaire'],
];

/**
 * Fait EXPLICITE sur le contexte du carnet (B2) ; `null` sinon. Jamais une
 * déduction : un permis établit l'autorisation, et le motif « construction »
 * seulement si l'objet déclaré des travaux est une construction ; la date de
 * constitution n'est lue que sur un fait désignant le carnet lui-même.
 */
export function recognizeCilContextFact(f: CilFactInput): CilContextFact | null {
  if (f.canonicalKey) return null;
  const tt = (f.targetType ?? 'GENERIC').toUpperCase();
  if (!['GENERIC', 'ASSET'].includes(tt)) return null;
  if (f.semanticEventNature === 'DEADLINE' || notObserved(f.subject, f.attribute, f.label, f.rawKey)) return null;
  const subject = norm(f.subject ?? '');
  const attribute = norm(f.attribute ?? '');
  const raw = textOf(f);
  if (!raw) return null;
  const carnet = matchHead(subject, CARNET_SUBJECTS);
  const auth = matchHead(subject, AUTH_SUBJECTS);
  if (!carnet && !auth) return null;
  if (MOTIF_ATTRS.has(attribute)) {
    const t = matchHead(norm(raw), TRIGGER_VALUES);
    // Un permis ne qualifie que la construction (une extension, un ravalement n'en sont pas).
    if (t && (carnet || t === 'construction')) return { kind: 'trigger', value: t };
    return auth ? { kind: 'authorization', value: auth } : null;
  }
  if (carnet && DATE_ATTRS.has(attribute) && /^\d{4}-\d{2}-\d{2}/.test(raw)) return { kind: 'triggerDate', value: raw.slice(0, 10) };
  return auth ? { kind: 'authorization', value: auth } : null;
}
