/**
 * Carte #839 — identité de l'émetteur (contrat facultatif `t1-supplier-identity-v1`, bloc PO 52) :
 * CONTRÔLE SERVEUR de la preuve, puis forme PERSISTÉE (`document.supplier.value.identity`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE LE CODE VÉRIFIE — ET CE QU'IL NE DÉCIDE PAS
 *
 * Le modèle dit ce que chaque mention est (raison sociale, enseigne,
 * établissement). Le code ne devine aucun nom ; il VÉRIFIE seulement :
 *   · le prompt T1 effectif porte le contrat (`supplier-identity/contract.ts`) ;
 *   · la confiance est « certain » ;
 *   · une citation est rendue ET retrouvée dans le texte de la source
 *     (contenu préextrait, sinon transcription T1 — même corpus que
 *     `verifyExcerpts` pour les faits) : une citation non vide ne suffit pas ;
 *   · chaque nom retenu (enseigne, raison sociale) figure DANS cette citation ;
 *   · chaque nom prouvé partage au moins un mot significatif avec le nom du
 *     fournisseur lu par T1 (`supplier.name`) — sinon ambiguïté (nom du
 *     client, autre société citée…) : l'identité n'est pas retenue.
 * Tout écart → `UNVERIFIED` : le titre garde le nom lu aujourd'hui. Rien
 * n'est jamais retiré : valeurs, preuve et motifs sont persistés tels quels.
 * Ni `supplier.name`, ni le référentiel fournisseurs ne sont modifiés.
 *
 * Fonctions PURES (aucune base, aucun appel IA).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { T1SupplierIdentity } from '../master/t1-contract';
import type { SupplierIdentityCheck, SupplierIdentityRecord } from '../types';

/** Identifiant du contrat (même marqueur que `T1_SUPPLIER_IDENTITY_CONTRACT`, lib partagée). */
export const SUPPLIER_IDENTITY_CONTRACT_ID = 't1-supplier-identity-v1' as const;

/** Forme de comparaison : sans accents, casse, ponctuation ni espaces (règle de `verifyExcerpts`). */
const plat = (s: string | null | undefined): string =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Mots NON discriminants d'un nom d'entreprise (formes juridiques, articles, pays) : ils ne suffisent
 * jamais à rapprocher deux noms. Liste générique — aucun fournisseur particulier.
 */
const MOTS_NEUTRES = new Set([
  'sa', 'sas', 'sasu', 'sarl', 'eurl', 'snc', 'sci', 'scp', 'scop', 'selarl', 'gie', 'ei', 'eirl', 'ltd', 'gmbh', 'inc', 'llc', 'spa', 'srl', 'bv', 'nv',
  'cie', 'compagnie', 'ste', 'societe', 'groupe', 'group', 'holding', 'france', 'et', 'de', 'du', 'des', 'la', 'le', 'les', 'and', 'the', 'magasin', 'agence',
]);
const motsSignificatifs = (s: string | null | undefined): Set<string> => new Set(
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !MOTS_NEUTRES.has(w)),
);
const partageUnMot = (a: string, b: string): boolean => {
  const mb = motsSignificatifs(b);
  return [...motsSignificatifs(a)].some((w) => mb.has(w));
};
const texte = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  return s ? s.slice(0, 200) : null;
};

/** Motifs qui empêchent l'usage de l'identité (les deux « NAME_NOT_IN_QUOTE » n'écartent que le nom concerné). */
const BLOQUANTS: readonly SupplierIdentityCheck[] = [
  'CONTRACT_NOT_CARRIED', 'LOW_CONFIDENCE', 'NO_QUOTE', 'NO_SOURCE_TEXT', 'QUOTE_NOT_IN_SOURCE', 'NO_PROVEN_NAME', 'INCONSISTENT_WITH_SUPPLIER_NAME',
];

export interface SupplierIdentityVerificationInput {
  /** Nom du fournisseur lu par T1 (`document.supplier.name`), inchangé. */
  supplierName: string;
  /** Contenu préextrait de la source (lien web, texte fourni par l'adaptateur), s'il existe. */
  sourceText?: string | null;
  /** Transcription T1 de la source (texte lu). */
  transcription?: string | null;
  /** Le prompt T1 effectif (version qui a répondu) porte-t-il le contrat ? */
  contract: { carried: boolean; reason: string };
}

/**
 * Identité de l'émetteur PERSISTÉE avec le résultat (pure) : valeurs lues telles quelles, citation,
 * contrôle serveur. La citation canonique est `evidence.excerpt` (sortie maître) ; elle est persistée
 * sous `evidence.quote`, forme commune des blocs T1 persistés (`billingPeriod`).
 */
export function verifiedSupplierIdentity(identity: T1SupplierIdentity, p: SupplierIdentityVerificationInput): SupplierIdentityRecord {
  const checks: SupplierIdentityCheck[] = [];
  const legalName = texte(identity.legalName);
  const tradeName = texte(identity.tradeName);
  const establishment = texte(identity.establishment);
  const citation = typeof identity.evidence?.excerpt === 'string' ? identity.evidence.excerpt.trim() : '';
  const quote = citation ? citation.slice(0, 500) : null;

  if (!p.contract.carried) checks.push('CONTRACT_NOT_CARRIED');
  if (identity.confidence !== 'certain') checks.push('LOW_CONFIDENCE');

  let textOrigin: SupplierIdentityRecord['verification']['textOrigin'] = null;
  const q = plat(quote);
  if (!quote || q.length < 3) checks.push('NO_QUOTE');
  else {
    const source = plat(p.sourceText);
    const transcription = plat(p.transcription);
    if (!source && !transcription) checks.push('NO_SOURCE_TEXT');
    else if (source && source.includes(q)) textOrigin = 'SOURCE_TEXT';
    else if (transcription && transcription.includes(q)) textOrigin = 'T1_TRANSCRIPTION';
    else checks.push('QUOTE_NOT_IN_SOURCE');
  }

  const dansCitation = (nom: string | null) => !!nom && textOrigin !== null && plat(nom).length >= 2 && q.includes(plat(nom));
  const proven = { tradeName: dansCitation(tradeName), legalName: dansCitation(legalName) };
  if (tradeName && textOrigin !== null && !proven.tradeName) checks.push('TRADE_NAME_NOT_IN_QUOTE');
  if (legalName && textOrigin !== null && !proven.legalName) checks.push('LEGAL_NAME_NOT_IN_QUOTE');
  if (!proven.tradeName && !proven.legalName) checks.push('NO_PROVEN_NAME');
  // Ambiguïté : un nom prouvé sans aucun mot commun avec le fournisseur lu n'est pas forcément l'émetteur.
  const prouves = [proven.tradeName ? tradeName : null, proven.legalName ? legalName : null].filter((x): x is string => !!x);
  if (prouves.some((n) => !partageUnMot(n, p.supplierName))) checks.push('INCONSISTENT_WITH_SUPPLIER_NAME');

  const status = checks.some((c) => BLOQUANTS.includes(c)) ? 'UNVERIFIED' : 'VERIFIED';
  return {
    legalName, tradeName, establishment,
    confidence: identity.confidence,
    evidence: { quote, page: identity.evidence?.page ?? null },
    verification: {
      status, textOrigin, proven: status === 'VERIFIED' ? proven : { tradeName: false, legalName: false },
      checks: [...new Set(checks)],
      contract: { id: SUPPLIER_IDENTITY_CONTRACT_ID, carried: p.contract.carried, reason: p.contract.reason.slice(0, 60) },
    },
  };
}
