/**
 * Lot 113AM (Trello #739) — RÔLE des adresses d'un document qui correspondent
 * à l'adresse d'un bien du compte. Module PUR : aucune base, aucun appel modèle.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AVANT : une adresse lue n'importe où dans le document (souscripteur,
 * destinataire, facturation…) et égale à celle d'une Maison du compte était
 * une correspondance « exacte » : T1 en faisait un candidat VÉRIFIÉ certain
 * (`mergeIdentifierCandidates`) → lien MENTIONED vers la Maison, ou même
 * PRIMARY + colonne quand le bien du document n'était pas un choix humain ;
 * T3 DOCUMENT_ASSET en faisait un rattachement déterministe
 * (`IDENTIFIER_EXACT:ADDRESS`). C'est l'origine du lien #331 (doc 126).
 *
 * MAINTENANT : chaque correspondance d'adresse est QUALIFIÉE, à partir des
 * sorties T1 existantes, dans cet ordre :
 *   1. un fait T1 portant cette adresse et CIBLÉ (cible vérifiée) : sur CE
 *      bien → PROPERTY_LOCATION ; sur un autre bien → OTHER_ASSET_LOCATION ;
 *      sur un fournisseur → ISSUER (la sortie structurée de T1 l'emporte) ;
 *   2. le libellé lu par T1 qui précède IMMÉDIATEMENT l'adresse (libellé du
 *      fait, ou même ligne / ligne précédente de la transcription), lu avec
 *      les libellés MAÎTRISÉS existants de l'identité documentaire
 *      (`ADDRESS_ROLE_CUES`, lot 105D — aucune règle nouvelle par mot-clé) :
 *      « adresse du bien / du risque / des travaux… » → PROPERTY_LOCATION,
 *      « souscripteur / destinataire / facturation… » → CORRESPONDENCE, etc. ;
 *   3. sinon UNQUALIFIED (ou DOCUMENT_PARTY : fait ciblé sur le document).
 * Seule PROPERTY_LOCATION fait de l'adresse une preuve
 * (`admitDocumentAssetLink`) ; les autres correspondances restent des INDICES
 * (revue du rattachement #711), jamais un lien ni une question.
 *
 * Les valeurs d'adresse (sensibles, lot 29) ne quittent jamais ce module :
 * la sortie ne porte que des biens, des rôles et des provenances.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { AddressRole } from '@/services/documents/document-asset-links/admission';
import { normalizeAddress, type AssetIdentifierRecord, type IdentifierMatch, type IdentifierResolution } from './identifiers';
import { ADDRESS_ROLE_CUES, type ValueRole } from './identity/signals';

/** Fait T1 tel que persisté ou projeté (seules les colonnes utiles). */
export interface AddressRoleFact {
  canonicalKey: string | null | undefined;
  value: unknown;
  label?: string | null;
  subject?: string | null;
  rawKey?: string | null;
  targetType?: string | null;
  targetEntityId?: number | null;
}

export interface AddressQualification {
  assetId: number;
  role: AddressRole;
  /** Provenance de la qualification (jamais la valeur). */
  source: 'FACT_TARGET' | 'FACT_LABEL' | 'TEXT_LABEL' | 'NONE';
  via: 'fact' | 'text';
}

/** Clés canoniques portant une adresse de bien. */
const ADDRESS_FACT_KEYS: readonly string[] = ['address1'];

const ROLE_OF: Readonly<Partial<Record<ValueRole, AddressRole>>> = {
  PROPERTY: 'PROPERTY_LOCATION', BILLING: 'CORRESPONDENCE', DELIVERY: 'DELIVERY', SUPPLIER: 'ISSUER', INTERVENTION: 'INSTALLATION',
};

/** Libellés existants, normalisés comme une adresse (même forme que le texte comparé). */
const CUES: ReadonlyArray<{ cue: string; role: AddressRole }> = Object.entries(ADDRESS_ROLE_CUES)
  .flatMap(([role, cues]) => (cues as readonly string[]).map((c) => ({ cue: normalizeAddress(c), role: ROLE_OF[role as ValueRole]! })))
  .filter((c) => c.cue && c.role)
  .sort((a, b) => b.cue.length - a.cue.length);

/** Mots outils tolérés entre un libellé et l'adresse (« Chantier au 12 rue… », « Lieu des travaux : à 12 rue… »). */
const MOTS_OUTILS = new Set(['au', 'aux', 'a', 'en', 'du', 'de', 'des', 'la', 'le', 'les', 'l', 'sis', 'sise', 'situe', 'situee']);

/**
 * Rôle du libellé qui TERMINE `prefix` (le libellé précède immédiatement
 * l'adresse, mots outils mis à part), sinon null. Pure.
 */
export function adjacentAddressRole(prefix: string): AddressRole | null {
  const mots = normalizeAddress(prefix).split(' ').filter(Boolean);
  for (let i = 0; i < 3 && mots.length > 0 && MOTS_OUTILS.has(mots[mots.length - 1]); i += 1) mots.pop();
  if (mots.length === 0) return null;
  const p = ` ${mots.join(' ')} `;
  for (const { cue, role } of CUES) if (p.endsWith(` ${cue} `)) return role;
  return null;
}

/**
 * Rôle d'un LIBELLÉ de champ (« Adresse du bien loué », « Souscripteur ») :
 * libellé maîtrisé qu'il contient, le plus proche de sa fin. Pure.
 */
export function labelAddressRole(label: string): AddressRole | null {
  const m = ` ${normalizeAddress(label.replace(/([a-z])([A-Z])/g, '$1 $2'))} `;
  if (!m.trim()) return null;
  let best: { role: AddressRole; end: number; len: number } | null = null;
  for (const { cue, role } of CUES) {
    const at = m.lastIndexOf(` ${cue} `);
    if (at < 0) continue;
    const fin = at + cue.length;
    if (!best || fin > best.end || (fin === best.end && cue.length > best.len)) best = { role, end: fin, len: cue.length };
  }
  return best?.role ?? null;
}

/** Rôle porté par le libellé d'un fait (libellé, sujet, clé brute) — le libellé entier est lu. Pure. */
function factLabelRole(f: AddressRoleFact): AddressRole | null {
  return labelAddressRole([f.label, f.subject, f.rawKey].filter(Boolean).join(' '));
}

const contient = (haystack: string, addr: string) => ` ${haystack} `.includes(` ${addr} `);

/**
 * Rôle d'une occurrence d'adresse dans une ligne lue par T1 : libellé « … : »
 * qui la précède dans la ligne (ou ligne précédente terminée par « : »), sinon
 * libellé qui la précède immédiatement. Pure.
 */
function occurrenceRole(segments: string[], k: number, avant: string, precedente: string): AddressRole | null {
  if (avant) return adjacentAddressRole(avant);
  if (k > 0) {
    const label = segments.slice(0, k).reverse().find((x) => x.trim()) ?? '';
    return labelAddressRole(label);
  }
  const prec = precedente.trim();
  if (!prec) return null;
  if (prec.endsWith(':')) return labelAddressRole(prec.replace(/:\s*$/, '').split(':').pop() ?? '');
  return adjacentAddressRole(prec);
}

/** Rôles lus dans le texte pour l'adresse `addr` (forme normalisée). Pure. */
function textRoles(texts: ReadonlyArray<string | null | undefined>, addr: string): AddressRole[] {
  const out: AddressRole[] = [];
  for (const t of texts) {
    if (typeof t !== 'string' || !t.trim()) continue;
    let precedente = '';
    for (const brute of t.split(/\r?\n/)) {
      if (!brute.trim()) continue;
      const segments = brute.split(':');
      segments.forEach((seg, k) => {
        const h = ` ${normalizeAddress(seg)} `;
        let from = 0;
        for (;;) {
          const i = h.indexOf(` ${addr} `, from);
          if (i < 0) break;
          out.push(occurrenceRole(segments, k, h.slice(0, i).trim(), precedente) ?? 'UNQUALIFIED');
          from = i + 1;
        }
      });
      precedente = brute;
    }
  }
  return out;
}

/**
 * Rôle d'UNE adresse normalisée (`addr`, forme `normalizeAddress`) vis-à-vis
 * du bien `assetId`, d'après les faits T1 et la transcription (pure).
 */
export function qualifyAddressValue(p: {
  addr: string;
  assetId: number;
  facts: readonly AddressRoleFact[];
  texts: ReadonlyArray<string | null | undefined>;
  /** Provenance par défaut si aucune occurrence n'est retrouvée. */
  via?: 'fact' | 'text';
}): AddressQualification {
  const { addr, assetId } = p;
  const faits = addr ? p.facts.filter((f) => f.canonicalKey && ADDRESS_FACT_KEYS.includes(f.canonicalKey)
    && contient(normalizeAddress(typeof f.value === 'string' || typeof f.value === 'number' ? String(f.value) : ''), addr)) : [];
  // 1. Sortie structurée de T1 : cible vérifiée du fait.
  if (faits.some((f) => f.targetType === 'ASSET' && f.targetEntityId === assetId)) {
    return { assetId, role: 'PROPERTY_LOCATION', source: 'FACT_TARGET', via: 'fact' };
  }
  const cible = faits.find((f) => (f.targetType === 'ASSET' && f.targetEntityId != null) || f.targetType === 'SUPPLIER');
  if (cible) return { assetId, role: cible.targetType === 'SUPPLIER' ? 'ISSUER' : 'OTHER_ASSET_LOCATION', source: 'FACT_TARGET', via: 'fact' };
  // 2. Libellés lus par T1 (fait, puis transcription).
  const roles: Array<{ role: AddressRole; source: AddressQualification['source']; via: 'fact' | 'text' }> = [
    ...faits.map((f) => ({ role: factLabelRole(f) ?? (f.targetType === 'DOCUMENT' ? 'DOCUMENT_PARTY' as const : 'UNQUALIFIED' as const), source: 'FACT_LABEL' as const, via: 'fact' as const })),
    ...(addr ? textRoles(p.texts, addr) : []).map((role) => ({ role, source: 'TEXT_LABEL' as const, via: 'text' as const })),
  ];
  const lieu = roles.find((r) => r.role === 'PROPERTY_LOCATION');
  const retenu = lieu ?? roles.find((r) => r.role !== 'UNQUALIFIED' && r.role !== 'DOCUMENT_PARTY') ?? roles[0];
  return retenu && retenu.role !== 'UNQUALIFIED'
    ? { assetId, role: retenu.role, source: retenu.source, via: retenu.via }
    : { assetId, role: retenu?.role ?? 'UNQUALIFIED', source: 'NONE', via: retenu?.via ?? p.via ?? 'text' };
}

/**
 * Qualifie chaque correspondance d'ADRESSE de `resolution` (pure). Une
 * correspondance d'une autre nature (immatriculation, VIN, série, cadastre)
 * n'est pas concernée.
 */
export function qualifyAddressMatches(p: {
  records: readonly AssetIdentifierRecord[];
  matches: readonly IdentifierMatch[];
  facts: readonly AddressRoleFact[];
  texts: ReadonlyArray<string | null | undefined>;
}): AddressQualification[] {
  const out: AddressQualification[] = [];
  for (const m of p.matches) {
    if (m.kind !== 'ADDRESS' || out.some((q) => q.assetId === m.assetId)) continue;
    const rec = p.records.find((r) => r.assetId === m.assetId);
    const addr = normalizeAddress(rec?.values.address1 ?? '') || m.normalized;
    out.push(qualifyAddressValue({ addr, assetId: m.assetId, facts: p.facts, texts: p.texts, via: m.via }));
  }
  return out;
}

/**
 * Résolution « admissible » : les correspondances d'adresse non qualifiées
 * « lieu du bien » sont RETIRÉES (elles restent des indices), unicité et
 * ambiguïté recalculées comme `resolveAssetByIdentifiers`. Pure.
 */
export function qualifiedIdentification(
  resolution: IdentifierResolution,
  qualifications: readonly AddressQualification[],
): { resolution: IdentifierResolution; excluded: AddressQualification[] } {
  const lieu = new Set(qualifications.filter((q) => q.role === 'PROPERTY_LOCATION').map((q) => q.assetId));
  const matches = resolution.matches.filter((m) => m.kind !== 'ADDRESS' || lieu.has(m.assetId));
  const assetIds = [...new Set(matches.map((m) => m.assetId))].sort((a, b) => a - b);
  return {
    resolution: {
      matches,
      assetIds,
      uniqueAssetId: assetIds.length === 1 ? assetIds[0] : null,
      ambiguous: assetIds.length > 1,
      multiAssetCandidate: assetIds.length > 1 && assetIds.every((id) => matches.some((m) => m.assetId === id && m.exclusive)),
    },
    excluded: qualifications.filter((q) => q.role !== 'PROPERTY_LOCATION'),
  };
}

/** Raccourci : qualification + résolution admissible (pure). */
export function admissibleIdentification(p: {
  records: readonly AssetIdentifierRecord[];
  resolution: IdentifierResolution;
  facts: readonly AddressRoleFact[];
  texts: ReadonlyArray<string | null | undefined>;
}): { resolution: IdentifierResolution; qualifications: AddressQualification[]; excluded: AddressQualification[] } {
  const qualifications = qualifyAddressMatches({ records: p.records, matches: p.resolution.matches, facts: p.facts, texts: p.texts });
  const q = qualifiedIdentification(p.resolution, qualifications);
  return { resolution: q.resolution, qualifications, excluded: q.excluded };
}

/** Rôle qualifié d'une adresse pour un bien (`UNQUALIFIED` si aucune qualification). Pure. */
export function addressRoleOf(qualifications: readonly AddressQualification[], assetId: number): AddressRole {
  return qualifications.find((q) => q.assetId === assetId)?.role ?? 'UNQUALIFIED';
}

/**
 * Lot 113AM (#739, « rattachement utilisateur existant ») : identification
 * réduite aux biens `keep` (bien choisi par l'utilisateur, biens désignés par
 * le modèle). Une correspondance vers un AUTRE bien reste un indice (revue du
 * rattachement), jamais un candidat ni un lien. Pure.
 */
export function restrictIdentification(resolution: IdentifierResolution, keep: ReadonlySet<number>): IdentifierResolution {
  const matches = resolution.matches.filter((m) => keep.has(m.assetId));
  if (matches.length === resolution.matches.length) return resolution;
  const assetIds = [...new Set(matches.map((m) => m.assetId))].sort((a, b) => a - b);
  return {
    matches, assetIds, uniqueAssetId: assetIds.length === 1 ? assetIds[0] : null, ambiguous: assetIds.length > 1,
    multiAssetCandidate: assetIds.length > 1 && assetIds.every((id) => matches.some((m) => m.assetId === id && m.exclusive)),
  };
}
