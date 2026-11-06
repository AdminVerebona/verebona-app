/**
 * Lot 111X — seconde chance T3 des COORDONNÉES d'un fournisseur : décision
 * DÉTERMINISTE par champ, à partir de la connaissance documentaire ACTIVE
 * (`collectSupplierKnowledge`). Pure, testée.
 *
 * Pour chaque champ (téléphone, e-mail, site, adresse, TVA, IBAN) :
 *   · candidats lus par FORMAT dans les éléments (données structurées T1,
 *     faits `target_type = SUPPLIER`, faits non intégrés, unités sources,
 *     texte persisté), avec preuve (document, extraction, fait / unité) ;
 *   · attribution à l'ÉMETTEUR seulement : fait ciblé sur ce fournisseur, ou
 *     unité qui porte son ancre (SIRET / SIREN, TVA dérivée du SIREN, nom)
 *     sans marque du destinataire ; un n° de TVA dont le SIREN est celui du
 *     fournisseur est attribué quelle que soit l'unité ; un e-mail qui nomme
 *     le fournisseur aussi ;
 *   · une valeur ÉTABLIE = une seule valeur distincte, au moins une preuve
 *     certaine (unité COVERED / UNRESOLVED, fait certain, donnée structurée) ;
 *     unité UNCERTAIN seule, fait probable seul → `UNCERTAIN_ONLY` ;
 *     plusieurs valeurs distinctes → `EVIDENCE_CONFLICT` (abstention) ;
 *   · rien n'est inventé : aucun candidat → `NO_EVIDENCE`.
 * Le besoin d'un DÉCOUPAGE par l'IA (KNOWLEDGE_QUERY) est signalé quand une
 * unité de l'émetteur annonce un champ vide (libellé) sans valeur lisible.
 */
import { createHash } from 'node:crypto';
import {
  ADDRESS_FIELDS, SUPPLIER_COORDINATE_FIELDS, anchoredToSupplier, emailNamesSupplier, markedAsRecipient, maskIban, nameTokens, plain,
  readContactValues, readPostalAddresses, type SupplierCoordinateField,
} from '@/services/suppliers/supplier-contact-reading';
import type { SupplierKnowledge, SupplierKnowledgeItem, SupplierRow } from './collect';
import { SUPPLIER_COORDINATES_RULES_VERSION } from './contract';

export interface CoordinateEvidence {
  ref: string;
  fileId: number;
  layer: SupplierKnowledgeItem['layer'];
  sourceId: number;
  unitId: string | null;
  extractionId: number | null;
  page: number | null;
  confidence: 'certain' | 'probable' | 'conflictual';
  /** Motif d'attribution à l'émetteur. */
  attribution: 'TARGETED_FACT' | 'ANCHORED_UNIT' | 'VAT_SIREN' | 'EMAIL_NAMES_SUPPLIER' | 'STRUCTURED';
}

export type CoordinateStatus = 'ESTABLISHED' | 'NO_EVIDENCE' | 'UNCERTAIN_ONLY' | 'EVIDENCE_CONFLICT' | 'NEEDS_SPLIT';

export interface CoordinateFinding {
  field: SupplierCoordinateField;
  status: CoordinateStatus;
  /** Valeur établie (forme enregistrée). */
  value: string | null;
  /** Valeurs distinctes relevées (IBAN masqué). */
  candidates: string[];
  evidence: CoordinateEvidence[];
  /** Éléments de l'émetteur à découper (NEEDS_SPLIT). */
  splitRefs?: string[];
}

/** Indices de libellé d'un champ (signalent une valeur à découper quand aucune n'est lisible). */
const FIELD_CUES: Partial<Record<SupplierCoordinateField, RegExp>> = {
  phone: /\b(?:t[ée]l(?:[ée]phone)?|portable|mobile)\s*\.?\s*[:：]/i,
  email: /\b(?:e-?mail|courriel|mail)\s*[:：]/i,
  vatNumber: /\b(?:tva(?:\s+intracom\w*)?|n°\s*(?:de\s+)?tva|vat)\s*[:：]/i,
  website: /\b(?:site(?:\s+(?:web|internet))?|web)\s*[:：]/i,
  iban: /\biban\s*[:：]/i,
  addressLine1: /\b(?:adresse|si[èe]ge(?:\s+social)?)\s*[:：]/i,
};

const forme = (field: SupplierCoordinateField, v: string) =>
  field === 'phone' ? v.replace(/^\+33/, '0') : field === 'addressLine1' || field === 'city' ? plain(v) : v.toLowerCase();

interface Candidate { field: SupplierCoordinateField; value: string; ev: CoordinateEvidence }

/** Décision par champ (pure). Voir l'en-tête. */
export function decideSupplierCoordinates(k: Pick<SupplierKnowledge, 'supplier' | 'items' | 'recipient'>): CoordinateFinding[] {
  const s = k.supplier;
  const anchor = { name: s.name, siren: s.siren ?? (s.siret ? s.siret.slice(0, 9) : null), siret: s.siret };
  const siren = anchor.siren;
  const candidates: Candidate[] = [];
  const split = new Map<SupplierCoordinateField, Set<string>>();
  const ev = (i: SupplierKnowledgeItem, attribution: CoordinateEvidence['attribution']): CoordinateEvidence => ({
    ref: i.ref, fileId: i.fileId, layer: i.layer, sourceId: i.sourceId, unitId: i.unitId, extractionId: i.extractionId, page: i.page,
    confidence: i.confidence, attribution,
  });
  const membres = new Set(k.recipient.emails.map((e) => e.toLowerCase()));

  for (const i of k.items) {
    const ciblé = i.layer === 'FACT' && (i.targetEntityId === s.id
      || (i.targetEntityId == null && (!i.targetLabel || anchoredToSupplier(i.targetLabel, anchor) || nameTokens(s.name).some((w) => plain(i.targetLabel!).includes(w)))));
    const structure = i.layer === 'STRUCTURED';
    const destinataire = markedAsRecipient(i.text, k.recipient);
    const ancre = !destinataire && (structure || ciblé || anchoredToSupplier(i.text, anchor));
    const attribution: CoordinateEvidence['attribution'] = structure ? 'STRUCTURED' : ciblé ? 'TARGETED_FACT' : 'ANCHORED_UNIT';
    const valeurs = readContactValues(i.text);
    for (const v of valeurs) {
      if (v.excluded || v.field === 'siret' || v.field === 'siren') continue;
      if (v.field === 'vatNumber') {
        const vatSiren = v.value.slice(4);
        if (siren && vatSiren === siren) candidates.push({ field: 'vatNumber', value: v.value, ev: ev(i, ancre ? attribution : 'VAT_SIREN') });
        else if (!siren && ancre) candidates.push({ field: 'vatNumber', value: v.value, ev: ev(i, attribution) });
        continue;
      }
      if (v.field === 'email') {
        if (membres.has(v.value)) continue;
        if (ancre) candidates.push({ field: 'email', value: v.value, ev: ev(i, attribution) });
        else if (!destinataire && emailNamesSupplier(v.value, s.name)) candidates.push({ field: 'email', value: v.value, ev: ev(i, 'EMAIL_NAMES_SUPPLIER') });
        continue;
      }
      if (!ancre) continue;
      candidates.push({ field: v.field, value: v.value, ev: ev(i, attribution) });
    }
    if (ancre) {
      const adresses = readPostalAddresses(i.text);
      // Plusieurs adresses dans une même unité : jamais tranché (émetteur et destinataire mêlés).
      if (adresses.length === 1) {
        const a = adresses[0];
        const e = ev(i, attribution);
        candidates.push({ field: 'addressLine1', value: a.addressLine1, ev: e }, { field: 'postalCode', value: a.postalCode, ev: e }, { field: 'city', value: a.city, ev: e });
      } else if (adresses.length > 1) {
        for (const a of adresses) candidates.push({ field: 'addressLine1', value: a.addressLine1, ev: { ...ev(i, attribution), confidence: 'conflictual' } });
      }
      for (const [field, re] of Object.entries(FIELD_CUES) as Array<[SupplierCoordinateField, RegExp]>) {
        if (!re.test(i.text)) continue;
        const lisible = field === 'addressLine1' ? adresses.length > 0 : valeurs.some((v) => v.field === field);
        if (!lisible && i.layer !== 'FACT') (split.get(field) ?? split.set(field, new Set()).get(field)!).add(i.ref);
      }
    }
  }

  const out: CoordinateFinding[] = [];
  for (const field of SUPPLIER_COORDINATE_FIELDS) {
    const mine = candidates.filter((c) => c.field === field);
    const fiables = mine.filter((c) => c.ev.confidence === 'certain');
    const distinctes = new Map<string, string>();
    for (const c of fiables) if (!distinctes.has(forme(field, c.value))) distinctes.set(forme(field, c.value), c.value);
    const toutes = new Map<string, string>();
    for (const c of mine) if (!toutes.has(forme(field, c.value))) toutes.set(forme(field, c.value), c.value);
    const masquer = (v: string) => (field === 'iban' ? maskIban(v)! : v);
    const base = { field, candidates: [...toutes.values()].map(masquer), evidence: mine.map((c) => c.ev) };
    if (mine.length === 0) {
      const refs = split.get(field);
      out.push(refs?.size ? { ...base, status: 'NEEDS_SPLIT', value: null, splitRefs: [...refs] } : { ...base, status: 'NO_EVIDENCE', value: null });
    } else if (mine.some((c) => c.ev.confidence === 'conflictual') && field === 'addressLine1' && distinctes.size !== 1) {
      out.push({ ...base, status: 'EVIDENCE_CONFLICT', value: null });
    } else if (distinctes.size === 0) {
      out.push({ ...base, status: 'UNCERTAIN_ONLY', value: null });
    } else if (distinctes.size > 1) {
      out.push({ ...base, status: 'EVIDENCE_CONFLICT', value: null });
    } else {
      const [valeur] = [...distinctes.values()];
      out.push({ ...base, status: 'ESTABLISHED', value: valeur, evidence: fiables.filter((c) => forme(field, c.value) === forme(field, valeur)).map((c) => c.ev) });
    }
  }
  // Adresse : les trois parties viennent de la MÊME preuve ; sinon aucune n'est établie.
  const parts = out.filter((f) => ADDRESS_FIELDS.includes(f.field));
  if (parts.some((f) => f.status === 'ESTABLISHED') && !parts.every((f) => f.status === 'ESTABLISHED')) {
    for (const f of parts) if (f.status === 'ESTABLISHED') Object.assign(f, { status: 'EVIDENCE_CONFLICT', value: null });
  }
  return out;
}

/** Valeurs actuelles des champs de coordonnées de la fiche. */
export function currentCoordinates(s: SupplierRow): Record<SupplierCoordinateField, string | null> {
  return {
    phone: s.phone, email: s.email, website: s.website, addressLine1: s.addressLine1, postalCode: s.postalCode, city: s.city,
    country: s.country, vatNumber: s.vatNumber, iban: s.iban, siren: s.siren, siret: s.siret,
  };
}

/**
 * Empreinte du contexte (pure) : éléments de connaissance, valeurs actuelles,
 * décisions de l'utilisateur, version des règles. Contexte inchangé → aucune
 * nouvelle décision ni aucun appel IA.
 */
export function supplierContextFingerprint(k: Pick<SupplierKnowledge, 'supplier' | 'items' | 'recipient'>): string {
  const sig = {
    v: SUPPLIER_COORDINATES_RULES_VERSION,
    s: { ...currentCoordinates(k.supplier), name: k.supplier.name, iban: maskIban(k.supplier.iban) },
    d: Object.entries(k.supplier.userFieldDecisions ?? {}).map(([f, x]) => `${f}:${x?.action}`).sort(),
    i: k.items.map((i) => `${i.ref}|${i.coverage ?? ''}|${i.confidence}|${createHash('sha1').update(i.text).digest('hex').slice(0, 12)}`).sort(),
    r: [...k.recipient.names, ...k.recipient.emails].map((x) => x.toLowerCase()).sort(),
  };
  return createHash('sha256').update(JSON.stringify(sig)).digest('hex').slice(0, 32);
}
