/**
 * T3 DOCUMENT_ASSET — IDENTITÉS TYPÉES d'un document (lot 105D, ticket
 * « T3 / Cohérence / À traiter — Rattachement rétroactif après création d'un
 * bien », §D1). Module PUR : aucune base, aucun appel modèle.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUATRE NATURES, JAMAIS CONFONDUES
 *
 *   PROPERTY   identité de BIEN immobilier : adresse dont le RÔLE est celui
 *              du logement (adresse du bien, du risque assuré, des travaux,
 *              fait canonique `address1`), référence cadastrale ;
 *   VEHICLE    identité de BIEN véhicule : immatriculation, VIN ;
 *   EQUIPMENT  identité d'ÉQUIPEMENT / objet : numéro de série (l'objet),
 *              marque / modèle (le produit — jamais une identité d'objet) ;
 *   CONTRACT   identité de CONTRAT / police / dossier : n° de contrat, de
 *              police, n° ADEME du DPE ;
 *   CONTEXT    simple indice : fournisseur, ville, catégorie, marque, adresse
 *              de facturation / de livraison / d'intervention / du
 *              fournisseur, adresse sans rôle établi.
 *
 * Seules PROPERTY et VEHICLE désignent un bien ; CONTRACT ne relie deux
 * documents qu'à un SEUL saut d'un document qui porte lui-même l'identité
 * (`graph.ts`) ; CONTEXT ne crée jamais d'arête.
 *
 * ── PROVENANCE DE CHAQUE SIGNAL ────────────────────────────────────────────
 *
 * Document (`fileId`), origine (fait T1, texte de la transcription, unité
 * source), champ / zone / unités, extrait borné, rôle de la valeur,
 * normalisation appliquée, fiabilité (HIGH : fait canonique certain ; MEDIUM :
 * texte au rôle explicite ; LOW : lecture incertaine — jamais une arête).
 *
 * ── ADRESSE DU BIEN ≠ ADRESSE DE FACTURATION ───────────────────────────────
 *
 * Le rôle d'une adresse lue dans le texte est celui du libellé qui la
 * précède immédiatement (« Adresse du bien : », « Adresse de facturation : »,
 * « Livré à », « Lieu des travaux »…). Sans libellé reconnu : UNKNOWN —
 * simple contexte. Une adresse de facturation, de livraison, d'intervention
 * ou du fournisseur n'est JAMAIS l'identité d'un logement.
 *
 * Les valeurs normalisées (adresse : donnée sensible, lot 29) ne quittent
 * jamais le serveur : le contexte du modèle ne reçoit que des références
 * opaques (`decision.ts` → `crossDocumentContext`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { normalizePlate, normalizeVin, vehicleIdentifiersIn } from '@/lib/vehicle-identifiers';
import { isDiscriminantReference, normalizeAddress, normalizeCode, normalizePostalCode, normalizeText } from '../identifiers';

/** Version des règles d'extraction des identités (entre dans l'empreinte des groupes). */
export const IDENTITY_SIGNALS_VERSION = 1;

export type IdentityFamily = 'PROPERTY' | 'VEHICLE' | 'EQUIPMENT' | 'CONTRACT' | 'CONTEXT';
export type IdentityKind =
  | 'ADDRESS' | 'CADASTRAL' | 'REGISTRATION' | 'VIN' | 'SERIAL' | 'MODEL_REF' | 'CONTRACT_REF' | 'DPE_REF'
  | 'SUPPLIER' | 'CITY' | 'BRAND';
/** Rôle de la valeur dans le document. */
export type ValueRole = 'PROPERTY' | 'BILLING' | 'DELIVERY' | 'SUPPLIER' | 'INTERVENTION' | 'UNKNOWN' | 'IDENTIFIER' | 'CONTEXT';
export type SignalReliability = 'HIGH' | 'MEDIUM' | 'LOW';

export interface IdentitySignal {
  /** Identifiant stable dans le document (`<fileId>:<n>`). */
  ref: string;
  fileId: number;
  family: IdentityFamily;
  kind: IdentityKind;
  role: ValueRole;
  /** Valeur normalisée — SERVEUR SEULEMENT (adresse : sensible). */
  key: string;
  /** Libellé lisible (carte « À traiter », supervision) — jamais transmis au modèle pour une adresse. */
  display: string;
  origin: 'FACT' | 'TEXT' | 'SOURCE_UNIT' | 'EXTRACTION';
  /** Clé canonique du fait, ou zone du texte (TITLE, DESCRIPTION, BODY, SIGNAL). */
  field: string | null;
  unitIds?: string[];
  /** Extrait borné (serveur, supervision). */
  excerpt: string | null;
  /** Normalisation appliquée (traçabilité). */
  normalization: string;
  reliability: SignalReliability;
}

export interface DocumentIdentityProfile {
  fileId: number;
  title: string | null;
  documentType: string | null;
  supplier: string | null;
  multiAssetDeclared: boolean;
  signals: IdentitySignal[];
  /** Contradictions internes au document (codes stables). */
  contradictions: string[];
  /** Empreinte des signaux (sans valeur en clair). */
  digest: string;
}

/** Entrée minimale (compatible `DocumentKnowledgeSources`). */
export interface IdentityProfileInput {
  fileId: number;
  title: string | null;
  description?: string | null;
  documentType: string | null;
  supplier: string | null;
  multiAsset: boolean | null;
  texts: ReadonlyArray<{ origin: string; zone: string; text: string; unitIds?: string[]; uncertain?: boolean }>;
  facts: ReadonlyArray<{
    canonicalKey: string | null; label: string | null; subject: string | null; value: string | null; excerpt: string | null;
    rawKey?: string | null; confidence?: string | null;
  }>;
}

// ── Rôles d'adresse (libellés MAÎTRISÉS, forme normalisée) ──────────────────

/** Libellés qui précèdent une adresse, par rôle (forme `normalizeText`). Le plus proche gagne. */
export const ADDRESS_ROLE_CUES: Readonly<Record<Exclude<ValueRole, 'UNKNOWN' | 'IDENTIFIER' | 'CONTEXT'>, readonly string[]>> = {
  PROPERTY: [
    'adresse du bien', 'bien situe', 'situation du bien', 'designation du bien', 'adresse du logement', 'logement situe',
    'adresse de l immeuble', 'adresse du local', 'local situe', 'adresse du risque', 'risque assure', 'lieu du risque',
    'bien assure', 'adresse assuree', 'lieu des travaux', 'adresse des travaux', 'adresse du chantier', 'chantier',
    'adresse de la propriete', 'propriete situee', 'adresse du sinistre', 'lieu du sinistre', 'biens immobiliers',
    'adresse de l habitation', 'habitation situee', 'adresse du lot', 'adresse de la maison', 'maison situee',
    'adresse de l appartement', 'appartement situe', 'lieu de situation', 'objet de la vente', 'bien vendu', 'adresse d intervention', 'lieu d intervention',
  ],
  BILLING: [
    'adresse de facturation', 'facturation', 'facture a', 'facturee a', 'facture au nom de', 'adresse postale',
    'adresse de correspondance', 'correspondance', 'adresse du souscripteur', 'souscripteur', 'domicile', 'domicilie',
    'adresse du client', 'client', 'destinataire', 'titulaire du contrat', 'adresse du titulaire', 'redevable',
  ],
  DELIVERY: ['adresse de livraison', 'livraison', 'livre a', 'livree a', 'expedie a', 'expedition', 'retrait en magasin'],
  SUPPLIER: ['siege social', 'siege', 'siret', 'rcs', 'tva intracommunautaire', 'magasin', 'agence', 'emetteur', 'vendeur'],
  // « Lieu / adresse d'intervention » d'un artisan désigne le logement (PROPERTY ci-dessus) ; l'installation
  // d'un APPAREIL ne prouve pas son appartenance au bien (document d'équipement, exclu du groupe).
  INTERVENTION: ['adresse d installation', 'lieu d installation', 'mise en service a'],
};

/** Fenêtre (caractères normalisés) lue avant l'adresse pour en établir le rôle. */
const ROLE_WINDOW = 70;
/** Fenêtre de texte (caractères) examinée par document pour les adresses (la transcription complète est bornée par T1). */
export const IDENTITY_TEXT_WINDOW = 60_000;

const VOIES = [
  'rue', 'avenue', 'av', 'boulevard', 'bd', 'chemin', 'allee', 'impasse', 'place', 'route', 'quai', 'cours', 'square',
  'faubourg', 'fbg', 'lotissement', 'residence', 'voie', 'sentier', 'passage', 'hameau', 'lieu dit', 'clos', 'chaussee', 'mail', 'parvis',
  // Abréviations MAÎTRISÉES (mêmes formes que `normalizeAddress`).
  'r', 'ave', 'bld', 'boul', 'bvd', 'pl', 'chem', 'che', 'rte', 'imp', 'sq',
];
/** Adresse normalisée : numéro, voie, nom (1 à 7 mots), code postal, ville (facultative). */
const ADDRESS_RE = new RegExp(
  `(?:^| )(\\d{1,4}(?: (?:bis|ter|b|t))? (?:${VOIES.join('|')})(?: [a-z0-9]+){1,7}?) (\\d{5})(?: ([a-z]{2,}))?(?= |$)`,
  'g',
);

/** Libellés de champ qui terminent une voie (code postal, commune…) — jamais une partie du nom de la voie. */
const STREET_TAIL_RE = / (?:code postal|cp|commune|ville|localite|bp|cedex|adresse|tel|telephone)(?: [a-z0-9]+)*$/;

/** Rôle d'une adresse d'après le libellé le plus proche qui la précède (pure). */
export function addressRoleBefore(normalizedBefore: string): ValueRole {
  const fen = ` ${normalizedBefore.slice(-ROLE_WINDOW)} `;
  let best: { role: ValueRole; end: number; len: number } = { role: 'UNKNOWN', end: -1, len: 0 };
  for (const [role, cues] of Object.entries(ADDRESS_ROLE_CUES) as Array<[ValueRole, readonly string[]]>) {
    for (const cue of cues) {
      const at = fen.lastIndexOf(` ${cue} `);
      if (at < 0) continue;
      const end = at + cue.length + 1;
      // Le libellé qui se termine le plus près de l'adresse gagne ; à égalité, le plus long
      // (« adresse de facturation » l'emporte sur « facturation »).
      if (end > best.end || (end === best.end && cue.length > best.len)) best = { role, end, len: cue.length };
    }
  }
  return best.role;
}

/** Rôle d'un fait d'adresse d'après son libellé / sujet / clé brute (défaut : celui du bien). Pure. */
export function addressFactRole(f: { label?: string | null; subject?: string | null; rawKey?: string | null; excerpt?: string | null }): ValueRole {
  const meta = normalizeText([f.label, f.subject, f.rawKey].filter(Boolean).join(' ').replace(/([a-z])([A-Z])/g, '$1 $2'));
  const role = meta ? addressRoleBefore(meta) : 'UNKNOWN';
  if (role !== 'UNKNOWN') return role;
  if (/\b(billing|invoice|factur|customer|client|delivery|livraison|shipping|supplier|fournisseur|vendor)\b/.test(meta)) {
    return /deliver|livraison|shipping/.test(meta) ? 'DELIVERY' : /supplier|fournisseur|vendor/.test(meta) ? 'SUPPLIER' : 'BILLING';
  }
  // Fait canonique `address1` : adresse du bien selon le registre (T1 l'y a rangée).
  const ex = f.excerpt ? normalizeText(f.excerpt) : '';
  const parExtrait = ex ? addressRoleBefore(ex.split(/\d{1,4} /)[0] ?? '') : 'UNKNOWN';
  return parExtrait === 'UNKNOWN' || parExtrait === 'PROPERTY' ? 'PROPERTY' : parExtrait;
}

/** Sous-chaîne ORIGINALE (accents, casse) correspondant à une suite de mots normalisés (pure). */
export function originalSpan(text: string, normalizedTokens: readonly string[]): string | null {
  if (normalizedTokens.length === 0) return null;
  const words: Array<{ n: string; start: number; end: number }> = [];
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const n = normalizeText(m[0]);
    for (const part of n.split(' ').filter(Boolean)) words.push({ n: part, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  for (let i = 0; i + normalizedTokens.length <= words.length; i += 1) {
    let ok = true;
    for (let k = 0; k < normalizedTokens.length; k += 1) if (words[i + k].n !== normalizedTokens[k]) { ok = false; break; }
    if (ok) return text.slice(words[i].start, words[i + normalizedTokens.length - 1].end).replace(/\s+/g, ' ').trim();
  }
  return null;
}

/** Clé d'adresse : voie normalisée (abréviations maîtrisées) + code postal. */
export function addressKey(street: string, postalCode: string): string {
  return `${normalizeAddress(street)}|${normalizePostalCode(postalCode)}`;
}

interface AddressHit { street: string; postalCode: string; city: string | null; role: ValueRole; display: string; tokens: string[] }

/** Adresses lues dans un texte, avec leur rôle (pure). */
export function addressesIn(text: string): AddressHit[] {
  const norm = normalizeText(text.slice(0, IDENTITY_TEXT_WINDOW));
  const out: AddressHit[] = [];
  for (const m of norm.matchAll(ADDRESS_RE)) {
    const start = (m.index ?? 0) + (m[0].startsWith(' ') ? 1 : 0);
    // Libellé de la ligne suivante capté par la voie (« … Fictifs Code postal 69000 ») : retiré.
    const street = m[1].replace(STREET_TAIL_RE, '');
    const cp = m[2];
    const city = m[3] ?? null;
    const role = addressRoleBefore(norm.slice(0, start));
    const tokens = `${street} ${cp}${city ? ` ${city}` : ''}`.split(' ');
    const display = originalSpan(text, tokens) ?? `${street} ${cp}${city ? ` ${city}` : ''}`;
    out.push({ street, postalCode: cp, city, role, display: display.slice(0, 160), tokens });
  }
  return out;
}

const borne = (s: string | null | undefined, n: number) => (s ? s.replace(/\s+/g, ' ').trim().slice(0, n) || null : null);

/** Clés de faits par nature d'identité. */
const FACT_KEYS = {
  ADDRESS: ['address1'],
  POSTAL: ['postalCode'],
  CITY: ['city'],
  CADASTRAL: ['cadastralRef'],
  REGISTRATION: ['registrationNumber'],
  VIN: ['vin'],
  SERIAL: ['serialNumber'],
  MODEL: ['modelName', 'model'],
  BRAND: ['brand', 'make'],
  CONTRACT: ['insuranceContractNumber', 'contractNumber'],
  DPE: ['dpeAdemeNumber'],
} as const;
const has = (keys: readonly string[], k: string | null) => !!k && keys.includes(k);

/**
 * Profil d'identité d'un document depuis sa connaissance PERSISTÉE (faits,
 * transcription, unités source) — jamais le fichier, jamais T1. Pure.
 */
export function extractIdentityProfile(input: IdentityProfileInput): DocumentIdentityProfile {
  const signals: IdentitySignal[] = [];
  const seen = new Set<string>();
  const push = (s: Omit<IdentitySignal, 'ref' | 'fileId'>) => {
    const dedupe = `${s.family}|${s.kind}|${s.role}|${s.key}`;
    if (seen.has(dedupe)) {
      // Même valeur, même rôle : la provenance la plus fiable est conservée.
      const prev = signals.find((x) => `${x.family}|${x.kind}|${x.role}|${x.key}` === dedupe)!;
      if (rank(s.reliability) > rank(prev.reliability)) Object.assign(prev, { ...s, ref: prev.ref, fileId: prev.fileId });
      return;
    }
    seen.add(dedupe);
    signals.push({ ...s, ref: `${input.fileId}:${signals.length + 1}`, fileId: input.fileId });
  };
  const facts = input.facts;
  const factVals = (keys: readonly string[]) => facts.filter((f) => has(keys, f.canonicalKey) && f.value).map((f) => f.value as string);
  const postal = [...new Set(factVals(FACT_KEYS.POSTAL).map(normalizePostalCode).filter((c) => c.length === 5))];
  const cities = [...new Set(factVals(FACT_KEYS.CITY).map((c) => normalizeText(c)).filter(Boolean))];

  // ── Faits canoniques ─────────────────────────────────────────────────────
  for (const f of facts) {
    const v = f.value?.trim();
    if (!v) continue;
    const fiable: SignalReliability = f.confidence && !['certain', 'high'].includes(f.confidence) ? 'MEDIUM' : 'HIGH';
    const base = { origin: 'FACT' as const, field: f.canonicalKey, excerpt: borne(f.excerpt, 200) };
    if (has(FACT_KEYS.ADDRESS, f.canonicalKey)) {
      const role = addressFactRole(f);
      // Code postal : dans la valeur, l'extrait, sinon le fait « code postal » s'il est unique.
      const cp = /\b(\d{5})\b/.exec(v)?.[1] ?? /\b(\d{5})\b/.exec(f.excerpt ?? '')?.[1] ?? (postal.length === 1 ? postal[0] : null);
      const street = normalizeText(v.replace(/\b\d{5}\b.*$/, ''));
      if (!cp || street.split(' ').length < 2) {
        push({ ...base, family: 'CONTEXT', kind: 'CITY', role, key: cities[0] ?? street, display: v.slice(0, 160), normalization: 'normalizeText', reliability: 'LOW' });
        continue;
      }
      const fam: IdentityFamily = role === 'PROPERTY' ? 'PROPERTY' : 'CONTEXT';
      const ville = /\d{5}/.test(v) ? '' : (factVals(FACT_KEYS.CITY)[0] ?? '').trim();
      push({ ...base, family: fam, kind: 'ADDRESS', role, key: addressKey(street, cp), display: borne(`${v}${/\d{5}/.test(v) ? '' : `, ${cp}${ville ? ` ${ville}` : ''}`}`, 160)!, normalization: 'normalizeAddress+postalCode', reliability: role === 'PROPERTY' ? fiable : 'LOW' });
    } else if (has(FACT_KEYS.CADASTRAL, f.canonicalKey)) {
      const c = normalizeCode(v);
      if (c.length >= 5 && /\d/.test(c)) push({ ...base, family: 'PROPERTY', kind: 'CADASTRAL', role: 'IDENTIFIER', key: c, display: borne(v, 60)!, normalization: 'normalizeCode', reliability: fiable });
    } else if (has(FACT_KEYS.REGISTRATION, f.canonicalKey)) {
      const p = normalizePlate(v);
      if (p.length >= 5) push({ ...base, family: 'VEHICLE', kind: 'REGISTRATION', role: 'IDENTIFIER', key: p, display: borne(v, 20)!, normalization: 'normalizePlate', reliability: fiable });
    } else if (has(FACT_KEYS.VIN, f.canonicalKey)) {
      const p = normalizeVin(v);
      if (p.length === 17) push({ ...base, family: 'VEHICLE', kind: 'VIN', role: 'IDENTIFIER', key: p, display: p, normalization: 'normalizeVin', reliability: fiable });
    } else if (has(FACT_KEYS.SERIAL, f.canonicalKey)) {
      const s = normalizeCode(v);
      if (s.length >= 5 && /\d/.test(s)) push({ ...base, family: 'EQUIPMENT', kind: 'SERIAL', role: 'IDENTIFIER', key: s, display: borne(v, 40)!, normalization: 'normalizeCode', reliability: fiable });
    } else if (has(FACT_KEYS.MODEL, f.canonicalKey)) {
      push({ ...base, family: 'EQUIPMENT', kind: 'MODEL_REF', role: 'CONTEXT', key: normalizeCode(v), display: borne(v, 60)!, normalization: 'normalizeCode', reliability: 'LOW' });
    } else if (has(FACT_KEYS.BRAND, f.canonicalKey)) {
      push({ ...base, family: 'CONTEXT', kind: 'BRAND', role: 'CONTEXT', key: normalizeText(v), display: borne(v, 60)!, normalization: 'normalizeText', reliability: 'LOW' });
    } else if (has(FACT_KEYS.CONTRACT, f.canonicalKey) || has(FACT_KEYS.DPE, f.canonicalKey)) {
      const r = normalizeCode(v);
      if (isDiscriminantReference(r)) {
        push({ ...base, family: 'CONTRACT', kind: has(FACT_KEYS.DPE, f.canonicalKey) ? 'DPE_REF' : 'CONTRACT_REF', role: 'IDENTIFIER', key: r, display: borne(v, 40)!, normalization: 'normalizeCode', reliability: fiable });
      }
    }
  }

  // ── Textes (titre, description, transcription, unités source) ───────────
  for (const t of input.texts) {
    if (!t.text?.trim()) continue;
    const origin = t.origin === 'SOURCE_UNITS' || t.origin === 'UNRESOLVED_FACTS' ? 'SOURCE_UNIT' as const : t.origin === 'TRANSCRIPTION' ? 'TEXT' as const : 'EXTRACTION' as const;
    const reliability = (r: SignalReliability): SignalReliability => (t.uncertain ? 'LOW' : r);
    for (const a of addressesIn(t.text)) {
      const fam: IdentityFamily = a.role === 'PROPERTY' && !t.uncertain ? 'PROPERTY' : 'CONTEXT';
      push({
        family: fam, kind: 'ADDRESS', role: a.role, key: addressKey(a.street, a.postalCode), display: a.display, origin, field: t.zone,
        ...(t.unitIds?.length ? { unitIds: t.unitIds.slice(0, 10) } : {}), excerpt: borne(a.display, 200),
        normalization: 'normalizeAddress+postalCode', reliability: reliability(a.role === 'PROPERTY' ? 'MEDIUM' : 'LOW'),
      });
    }
    const v = vehicleIdentifiersIn(t.text.slice(0, IDENTITY_TEXT_WINDOW));
    for (const p of v.plates) {
      push({ family: t.uncertain ? 'CONTEXT' : 'VEHICLE', kind: 'REGISTRATION', role: 'IDENTIFIER', key: p, display: p, origin, field: t.zone, excerpt: null, normalization: 'normalizePlate', reliability: reliability('MEDIUM') });
    }
    for (const p of v.vins) {
      push({ family: t.uncertain ? 'CONTEXT' : 'VEHICLE', kind: 'VIN', role: 'IDENTIFIER', key: p, display: p, origin, field: t.zone, excerpt: null, normalization: 'normalizeVin', reliability: reliability('MEDIUM') });
    }
  }
  if (input.supplier?.trim()) {
    push({ family: 'CONTEXT', kind: 'SUPPLIER', role: 'CONTEXT', key: normalizeText(input.supplier), display: input.supplier.slice(0, 80), origin: 'EXTRACTION', field: 'supplier', excerpt: null, normalization: 'normalizeText', reliability: 'LOW' });
  }

  const contradictions: string[] = [];
  const proprietes = new Set(signals.filter((s) => s.family === 'PROPERTY' && s.kind === 'ADDRESS').map((s) => s.key));
  // Deux adresses de bien DISTINCTES (autre code postal, autre numéro ou autre voie) : document multibiens.
  // Une forme abrégée de la même voie (« 12 rue des Érables » / « 12 rue des Érables Fictifs », même code postal) n'en est pas une.
  if (distinctAddresses([...proprietes])) contradictions.push('MULTIPLE_PROPERTY_ADDRESSES');
  const vehicules = new Set(signals.filter((s) => s.family === 'VEHICLE' && s.kind === 'REGISTRATION').map((s) => s.key));
  if (vehicules.size > 1) contradictions.push('MULTIPLE_VEHICLES');
  if (proprietes.size > 0 && vehicules.size > 0) contradictions.push('PROPERTY_AND_VEHICLE');
  const cpContraires = postal.length > 0 && [...proprietes].some((k) => !postal.includes(k.split('|')[1]));
  if (cpContraires && postal.length === 1) contradictions.push('POSTAL_CODE_MISMATCH');

  const digest = createHash('sha256').update(JSON.stringify([
    IDENTITY_SIGNALS_VERSION, input.multiAsset === true,
    signals.map((s) => [s.family, s.kind, s.role, s.key, s.reliability]).sort((a, b) => String(a).localeCompare(String(b))), contradictions,
  ])).digest('hex').slice(0, 32);
  return {
    fileId: input.fileId, title: borne(input.title, 160), documentType: input.documentType, supplier: borne(input.supplier, 80),
    multiAssetDeclared: input.multiAsset === true, signals, contradictions, digest,
  };
}

const rank = (r: SignalReliability) => (r === 'HIGH' ? 3 : r === 'MEDIUM' ? 2 : 1);

/** Au moins deux adresses qui ne sont pas des formes d'une même voie (pure). */
export function distinctAddresses(keys: readonly string[]): boolean {
  const parts = keys.map((k) => { const [street, cp] = k.split('|'); return { tokens: street.split(' '), cp }; });
  const meme = (a: { tokens: string[]; cp: string }, b: { tokens: string[]; cp: string }) => {
    if (a.cp !== b.cp) return false;
    const [court, long] = a.tokens.length <= b.tokens.length ? [a.tokens, b.tokens] : [b.tokens, a.tokens];
    return court.length >= 3 && court.every((t, i) => long[i] === t);
  };
  for (let i = 0; i < parts.length; i += 1) for (let j = i + 1; j < parts.length; j += 1) if (!meme(parts[i], parts[j])) return true;
  return false;
}

/** Signaux d'identité de BIEN exploitables (arêtes) : PROPERTY / VEHICLE, fiabilité ≥ MEDIUM. Pure. */
export function assetIdentitySignals(p: Pick<DocumentIdentityProfile, 'signals'>): IdentitySignal[] {
  return p.signals.filter((s) => (s.family === 'PROPERTY' || s.family === 'VEHICLE') && s.reliability !== 'LOW');
}

/** Le document porte-t-il une identité d'équipement / objet (série, modèle) ? Pure. */
export function isEquipmentDocument(p: Pick<DocumentIdentityProfile, 'signals'>): boolean {
  return p.signals.some((s) => s.family === 'EQUIPMENT');
}
