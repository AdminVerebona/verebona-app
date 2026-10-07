/**
 * Identifiants canoniques discriminants d'un bien et correspondance
 * DÉTERMINISTE document → bien (lot 31B — tickets T1 « identifiants
 * canoniques » et T3 DOCUMENT_ASSET). Module PUR : aucune base, aucun appel
 * modèle.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI EST UN IDENTIFIANT (et ce qui n'en est pas un)
 *
 * Par famille, seules les clés du registre canonique qui DÉSIGNENT un bien :
 *   · IMMOBILIER : adresse (`address1`), code postal, ville, référence
 *     cadastrale ;
 *   · VEHICULE   : immatriculation, VIN, marque, modèle ;
 *   · OBJECT     : numéro de série, marque, modèle.
 * Marque, modèle, code postal et ville AIDENT le modèle (ENTITY_CONTEXT)
 * mais ne rattachent JAMAIS seuls : « Lyon » ou « Renault » désignent
 * plusieurs biens. Seuls adresse, immatriculation, VIN, numéro de série et
 * référence cadastrale produisent une correspondance certaine.
 *
 * ── DONNÉES SENSIBLES (règle du lot 29) ────────────────────────────────────
 *
 * `address1` est `sensitive` au registre : il n'est JAMAIS transmis à un
 * modèle. `promptIdentifiers` filtre par le drapeau du registre (pas par une
 * liste écrite ici) : un champ marqué sensible demain disparaît du contexte
 * T1 / T3 sans autre modification. La correspondance d'adresse est faite ICI,
 * côté serveur, entre l'adresse du bien et ce que T1 a lu dans le document
 * (faits, transcription, texte préextrait) — le modèle n'a jamais besoin de
 * connaître l'adresse du bien pour que le document lui soit rattaché.
 *
 * ── NORMALISATION ──────────────────────────────────────────────────────────
 *
 * Tolère ce qui ne change pas l'identité : casse, accents, espaces,
 * ponctuation, « n° », abréviations de voie MAÎTRISÉES (av → avenue,
 * bd → boulevard…). Plaque et VIN : `@/lib/vehicle-identifiers` (lot 29,
 * correspondance exacte après normalisation). Aucune équivalence incertaine :
 * pas de distance d'édition, pas de préfixe, pas de suppression d'articles
 * (« rue de la Paix » ≠ « rue Paix »).
 *
 * ── UNICITÉ ────────────────────────────────────────────────────────────────
 *
 *   · un seul bien correspond                → `uniqueAssetId` (certain) ;
 *   · plusieurs biens, une même valeur les désigne tous (deux lots à la même
 *     adresse)                              → A OU B : ambiguïté ;
 *   · plusieurs biens, chacun désigné par une valeur qui n'appartient qu'à
 *     lui (deux immatriculations distinctes) → A ET B possible
 *     (`multiAssetCandidate`) : c'est à T3 de conclure, jamais à T1.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { getField, type AssetFamily } from '@/services/canonical/registry';
import { normalizePlate, normalizeVin, vehicleIdentifiersIn } from '@/lib/vehicle-identifiers';

/** Clés canoniques d'identification, par famille (ordre d'affichage). */
export const IDENTIFIER_KEYS: Readonly<Record<AssetFamily, readonly string[]>> = {
  IMMOBILIER: ['address1', 'postalCode', 'city', 'cadastralRef'],
  VEHICULE: ['registrationNumber', 'vin', 'make', 'model'],
  OBJECT: ['serialNumber', 'brand', 'modelName'],
};

/** Identifiants d'un bien, lus dans sa fiche canonique (sensibles COMPRIS — serveur seulement). */
export interface AssetIdentifierRecord {
  assetId: number;
  family: AssetFamily | null;
  /** Clé canonique → valeur textuelle (absentes : non renseignées). */
  values: Record<string, string>;
}

/** Nature d'une correspondance forte. */
export type IdentifierKind = 'ADDRESS' | 'REGISTRATION' | 'VIN' | 'SERIAL' | 'CADASTRAL';

export const IDENTIFIER_KIND_LABELS: Readonly<Record<IdentifierKind, string>> = {
  ADDRESS: 'adresse',
  REGISTRATION: 'immatriculation',
  VIN: 'VIN',
  SERIAL: 'numéro de série',
  CADASTRAL: 'référence cadastrale',
};

/** Le champ peut-il être transmis à un modèle ? (drapeau `sensitive` du registre) */
export function isPromptSafeKey(key: string): boolean {
  const def = getField(key);
  return !!def && def.sensitive !== true;
}

/**
 * Identifiants transmissibles au modèle (ENTITY_CONTEXT T1, candidats T3) :
 * clés de la famille, renseignées, NON sensibles. Valeurs bornées.
 */
export function promptIdentifiers(rec: AssetIdentifierRecord | undefined): Record<string, string> {
  if (!rec) return {};
  const keys = rec.family ? IDENTIFIER_KEYS[rec.family] : [];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = rec.values[k];
    if (v && isPromptSafeKey(k)) out[k] = v.slice(0, 120);
  }
  return out;
}

// ── Normalisation ───────────────────────────────────────────────────────────

/** Minuscules, sans accents, ponctuation → espace, espaces réduits. */
export function normalizeText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\bn\s*[°º]\s*/gi, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Abréviations de voie MAÎTRISÉES (forme normalisée → forme pleine). */
const VOIE: Readonly<Record<string, string>> = {
  av: 'avenue', ave: 'avenue',
  bd: 'boulevard', bld: 'boulevard', boul: 'boulevard', bvd: 'boulevard',
  pl: 'place', chem: 'chemin', che: 'chemin', rte: 'route', imp: 'impasse',
  fbg: 'faubourg', sq: 'square', st: 'saint', ste: 'sainte', r: 'rue',
};

/** Adresse normalisée (texte normalisé + abréviations de voie). */
export function normalizeAddress(value: unknown): string {
  return normalizeText(value).split(' ').filter(Boolean).map((t) => VOIE[t] ?? t).join(' ');
}

/** Identifiant alphanumérique (série, référence) : majuscules, sans séparateurs. */
export function normalizeCode(value: unknown): string {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Code postal : chiffres seulement. */
export function normalizePostalCode(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '');
}

/**
 * Une adresse est-elle assez précise pour identifier un bien ? Au moins deux
 * mots dont un de 3 lettres et plus (« Lyon », « 12 » seuls : non).
 */
export function isUsableAddress(normalized: string): boolean {
  const tokens = normalized.split(' ').filter(Boolean);
  return tokens.length >= 2 && normalized.length >= 6 && tokens.some((t) => /^[a-z]{3,}$/.test(t));
}

// ── Correspondance ──────────────────────────────────────────────────────────

/** Ce que le serveur connaît du document (jamais le fichier : T1 l'a lu). */
export interface DocumentIdentifierEvidence {
  /** Faits T1 (clé canonique + valeur). */
  facts: Array<{ canonicalKey: string | null | undefined; value: unknown }>;
  /** Transcription, texte préextrait, signaux de T1. */
  texts: Array<string | null | undefined>;
}

export interface IdentifierMatch {
  assetId: number;
  kind: IdentifierKind;
  /** Clé canonique du bien qui a correspondu. */
  key: string;
  /** Lu dans un fait T1 (`fact`) ou dans le texte (`text`). */
  via: 'fact' | 'text';
  /** Valeur normalisée — NE QUITTE JAMAIS LE SERVEUR (adresse : sensible). */
  normalized: string;
  /** La valeur ne désigne que ce bien parmi ceux du compte. */
  exclusive: boolean;
}

export interface IdentifierResolution {
  matches: IdentifierMatch[];
  /** Biens désignés par au moins une correspondance forte (triés). */
  assetIds: number[];
  /** Exactement un bien désigné : rattachement certain. */
  uniqueAssetId: number | null;
  /** Plusieurs biens désignés : aucun choix arbitraire. */
  ambiguous: boolean;
  /** Plusieurs biens, chacun par une valeur qui lui est propre (A ET B possible). */
  multiAssetCandidate: boolean;
}

const MAX_TEXT = 200_000;
const CODE_MIN = 5;

/** Fenêtres de 1 à 3 jetons consécutifs, réduites en code (`AB 123 CD` → `AB123CD`). */
function codeWindows(text: string): Set<string> {
  const tokens = text.split(/[\s,;:()[\]{}"'«»|/\\]+/).map(normalizeCode).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    let acc = '';
    for (let w = 0; w < 3 && i + w < tokens.length; w += 1) {
      acc += tokens[i + w];
      if (acc.length > 24) break;
      if (acc.length >= CODE_MIN) out.add(acc);
    }
  }
  return out;
}

/** Valeur textuelle d'un fait (normalisée ou brute). */
const factText = (v: unknown): string => (v === null || v === undefined || typeof v === 'object' ? '' : String(v));

/**
 * L'adresse normalisée `addr` figure-t-elle dans `haystack` (normalisée,
 * bornée par des espaces) sans code postal CONTRAIRE juste après ?
 */
function addressIn(haystack: string, addr: string, postalCode: string): boolean {
  const h = ` ${haystack} `;
  const needle = ` ${addr} `;
  let from = 0;
  for (;;) {
    const i = h.indexOf(needle, from);
    if (i < 0) return false;
    const after = h.slice(i + needle.length, i + needle.length + 40);
    const cp = /(?:^|\s)(\d{5})(?:\s|$)/.exec(after)?.[1];
    // Un code postal lu juste après l'adresse et DIFFÉRENT : même rue, autre ville.
    if (!postalCode || !cp || cp === postalCode) return true;
    from = i + 1;
  }
}

/**
 * Correspondances fortes entre les identifiants des biens du compte et ce que
 * T1 a lu dans le document. Pure, déterministe, sans seuil ni score.
 */
export function resolveAssetByIdentifiers(
  records: readonly AssetIdentifierRecord[],
  evidence: DocumentIdentifierEvidence,
): IdentifierResolution {
  const raw = evidence.texts.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .join('\n').slice(0, MAX_TEXT);
  const textAddr = normalizeAddress(raw);
  const windows = codeWindows(raw);
  const vehicles = vehicleIdentifiersIn(raw);
  const textPlates = new Set(vehicles.plates);
  const textVins = new Set(vehicles.vins);

  const factsOf = (keys: string[]) => evidence.facts
    .filter((f) => f.canonicalKey && keys.includes(f.canonicalKey))
    .map((f) => factText(f.value)).filter(Boolean);
  const addressFacts = factsOf(['address1']).map(normalizeAddress);
  const postalFacts = factsOf(['postalCode']).map(normalizePostalCode).filter((c) => c.length === 5);
  const plateFacts = new Set(factsOf(['registrationNumber']).map(normalizePlate));
  const vinFacts = new Set(factsOf(['vin']).map(normalizeVin));
  const serialFacts = new Set(factsOf(['serialNumber']).map(normalizeCode));
  const cadastralFacts = new Set(factsOf(['cadastralRef']).map(normalizeCode));

  const brut: Array<Omit<IdentifierMatch, 'exclusive'>> = [];
  const add = (assetId: number, kind: IdentifierKind, key: string, via: 'fact' | 'text', normalized: string) => {
    if (!brut.some((m) => m.assetId === assetId && m.kind === kind)) brut.push({ assetId, kind, key, via, normalized });
  };

  for (const r of records) {
    const v = r.values;
    // Adresse (immobilier) — jamais la ville ou le code postal seuls.
    const addr = normalizeAddress(v.address1);
    if (addr && isUsableAddress(addr)) {
      const cp = normalizePostalCode(v.postalCode);
      const cpBien = cp.length === 5 ? cp : '';
      // Fait « code postal » lu et contraire : autre ville, pas de rattachement.
      const cpContraire = cpBien !== '' && postalFacts.length > 0 && !postalFacts.includes(cpBien);
      if (!cpContraire) {
        if (addressFacts.some((a) => addressIn(a, addr, cpBien))) add(r.assetId, 'ADDRESS', 'address1', 'fact', addr);
        else if (textAddr && addressIn(textAddr, addr, cpBien)) add(r.assetId, 'ADDRESS', 'address1', 'text', addr);
      }
    }
    // Immatriculation.
    const plate = normalizePlate(v.registrationNumber);
    if (plate.length >= CODE_MIN) {
      if (plateFacts.has(plate)) add(r.assetId, 'REGISTRATION', 'registrationNumber', 'fact', plate);
      else if (textPlates.has(plate) || windows.has(plate)) add(r.assetId, 'REGISTRATION', 'registrationNumber', 'text', plate);
    }
    // VIN (17 caractères).
    const vin = normalizeVin(v.vin);
    if (vin.length === 17) {
      if (vinFacts.has(vin)) add(r.assetId, 'VIN', 'vin', 'fact', vin);
      else if (textVins.has(vin) || windows.has(vin)) add(r.assetId, 'VIN', 'vin', 'text', vin);
    }
    // Numéro de série (au moins un chiffre : « BOSCH » n'est pas un numéro).
    const serial = normalizeCode(v.serialNumber);
    if (serial.length >= CODE_MIN && /\d/.test(serial)) {
      if (serialFacts.has(serial)) add(r.assetId, 'SERIAL', 'serialNumber', 'fact', serial);
      else if (windows.has(serial)) add(r.assetId, 'SERIAL', 'serialNumber', 'text', serial);
    }
    // Référence cadastrale.
    const cad = normalizeCode(v.cadastralRef);
    if (cad.length >= CODE_MIN && /\d/.test(cad)) {
      if (cadastralFacts.has(cad)) add(r.assetId, 'CADASTRAL', 'cadastralRef', 'fact', cad);
      else if (windows.has(cad)) add(r.assetId, 'CADASTRAL', 'cadastralRef', 'text', cad);
    }
  }

  // Exclusivité : une même valeur (nature + forme normalisée) pour plusieurs biens.
  const parValeur = new Map<string, Set<number>>();
  for (const m of brut) {
    const k = `${m.kind}:${m.normalized}`;
    parValeur.set(k, (parValeur.get(k) ?? new Set()).add(m.assetId));
  }
  const matches: IdentifierMatch[] = brut.map((m) => ({ ...m, exclusive: (parValeur.get(`${m.kind}:${m.normalized}`)?.size ?? 0) === 1 }));
  const assetIds = [...new Set(matches.map((m) => m.assetId))].sort((a, b) => a - b);
  return {
    matches,
    assetIds,
    uniqueAssetId: assetIds.length === 1 ? assetIds[0] : null,
    ambiguous: assetIds.length > 1,
    multiAssetCandidate: assetIds.length > 1 && assetIds.every((id) => matches.some((m) => m.assetId === id && m.exclusive)),
  };
}

/**
 * Empreinte des identifiants canoniques des biens d'un compte (lot 32C) :
 * même empreinte = mêmes entrées « biens » pour T3 DOCUMENT_ASSET. Sert au
 * rattrapage horaire à ne pas rejouer une abstention quand un bien a été
 * modifié SANS que ses identifiants discriminants changent. Haché (sha256) :
 * aucune valeur (adresse : sensible) n'est stockée en clair. Pure.
 */
export function identifiersFingerprint(records: readonly AssetIdentifierRecord[]): string {
  const canon = [...records]
    .sort((a, b) => a.assetId - b.assetId)
    .map((r) => [r.assetId, r.family, Object.keys(r.values).sort().map((k) => [k, r.values[k]])]);
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

/** Libellés des correspondances d'un bien, SANS valeur (transmissibles au modèle). */
export function matchSignals(resolution: IdentifierResolution, assetId: number): string[] {
  return resolution.matches
    .filter((m) => m.assetId === assetId)
    .map((m) => `${IDENTIFIER_KIND_LABELS[m.kind]} du bien identique à celle du document (contrôle serveur exact${m.exclusive ? '' : ', partagée avec un autre bien'})`);
}
