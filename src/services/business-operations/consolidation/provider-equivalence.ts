/**
 * Lot 86C (ticket P1 « doublons de contrats ») — ÉQUIVALENCE DE DÉSIGNATIONS
 * d'un prestataire, ÉTABLIE PAR LES PREUVES DU COMPTE, sans aucune table de
 * correspondance codée (aucun « Homiris = EPS » dans le code).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI
 *
 * Un même prestataire est désigné différemment selon les documents : nom
 * commercial sur une facture, raison sociale sur une autre. La comparaison
 * historique (`normalizeProvider`, égalité stricte) voit deux tiers ; les
 * règles de série (84E), de plausibilité (53 / 55B) et de fusion (42 / 55B)
 * concluent alors à deux réalités et T3 crée un doublon de contrat.
 *
 * PREUVE RETENUE (déterministe, données persistées du compte)
 *
 *   Le référentiel fournisseurs (lot 22) relie chaque document analysé à SA
 *   fiche fournisseur (`document_suppliers`, rapprochement SIRET / SIREN /
 *   nom, ou geste de l'utilisateur). Sur un document ÉMIS par le prestataire
 *   (facture, avoir, devis, commande, contrat, rapport), le prestataire du
 *   candidat Opération (`payload.provider`) et la fiche fournisseur du
 *   document désignent la MÊME partie : ce document établit l'équivalence de
 *   ces deux désignations. Deux désignations rattachées, par des documents,
 *   à une même fiche fournisseur sont équivalentes (fermeture transitive).
 *
 *   Jamais : une preuve de paiement ou un remboursement (l'émetteur est la
 *   banque, pas le prestataire), une pièce sans rôle qualifié, un lien
 *   fournisseur incertain (ni confirmé, ni lu avec certitude par T1), un
 *   fournisseur d'un autre compte, un document supprimé.
 *
 * EFFET (aucune décision ici)
 *
 *   Les désignations équivalentes partagent une CLÉ CANONIQUE (la plus petite
 *   clé normalisée de la classe) : les règles existantes (`assessSeries`,
 *   faisceau, `operationsMergeable`, identité économique 78A) les voient
 *   comme un même tiers. L'équivalence ne rattache RIEN à elle seule : une
 *   série reste établie par une clé de service commune (contrat, compte
 *   client, équipement), sinon M3 tranche, puis l'utilisateur.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { normalizeProvider } from './model';

/** Rôles d'un document ÉMIS par le prestataire (son fournisseur est le prestataire du candidat). */
export const ISSUER_SOURCE_ROLES: ReadonlySet<string> = new Set([
  'INVOICE', 'DEPOSIT_INVOICE', 'CREDIT_NOTE', 'QUOTE', 'ORDER', 'CONTRACT_DOCUMENT', 'REPORT',
]);

/** Une preuve d'équivalence : un document qui relie une désignation de candidat à une fiche fournisseur. */
export interface DesignationEvidence {
  supplierId: number;
  supplierName: string | null;
  /** Prestataire du candidat Opération du document (`payload.provider`). */
  provider: string | null;
  /** Rôle de la source (`payload.sourceRoleHint`). */
  role: string | null;
  /** Lien document → fournisseur fiable (confirmé, ou lu avec certitude par T1). */
  reliable: boolean;
  fileId: number;
}

/** Équivalences du compte : clé normalisée → clé canonique, et preuve (fiche, documents). */
export interface ProviderEquivalence {
  canonical: ReadonlyMap<string, string>;
  /** Clé canonique → désignations de la classe et preuves (BO, trace des décisions). */
  classes: ReadonlyMap<string, { keys: string[]; supplierIds: number[]; fileIds: number[] }>;
}

export const EMPTY_PROVIDER_EQUIVALENCE: ProviderEquivalence = { canonical: new Map(), classes: new Map() };

/**
 * Classes d'équivalence des désignations (pure, déterministe, indépendante de
 * l'ordre des preuves). Seules les classes d'au moins deux désignations sont
 * rendues : une désignation isolée garde sa propre clé.
 */
export function buildProviderEquivalence(evidence: readonly DesignationEvidence[]): ProviderEquivalence {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let y = x;
    while (parent.get(y) !== r) { const n = parent.get(y)!; parent.set(y, r); y = n; }
    return r;
  };
  const add = (x: string) => { if (!parent.has(x)) parent.set(x, x); };
  const union = (a: string, b: string) => {
    add(a); add(b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  const fichiers = new Map<string, Set<number>>();
  for (const e of evidence) {
    if (!e.reliable || !e.role || !ISSUER_SOURCE_ROLES.has(e.role)) continue;
    const s = `s:${e.supplierId}`;
    const pc = normalizeProvider(e.provider);
    if (!pc) continue;
    union(`p:${pc}`, s);
    const ps = normalizeProvider(e.supplierName);
    if (ps) union(`p:${ps}`, s);
    fichiers.set(s, (fichiers.get(s) ?? new Set()).add(e.fileId));
  }
  const groupes = new Map<string, { keys: Set<string>; suppliers: Set<number>; files: Set<number> }>();
  for (const n of parent.keys()) {
    const r = find(n);
    const g = groupes.get(r) ?? { keys: new Set(), suppliers: new Set(), files: new Set() };
    if (n.startsWith('p:')) g.keys.add(n.slice(2));
    else {
      g.suppliers.add(Number(n.slice(2)));
      for (const f of fichiers.get(n) ?? []) g.files.add(f);
    }
    groupes.set(r, g);
  }
  const canonical = new Map<string, string>();
  const classes = new Map<string, { keys: string[]; supplierIds: number[]; fileIds: number[] }>();
  for (const g of groupes.values()) {
    if (g.keys.size < 2) continue;
    const keys = [...g.keys].sort();
    for (const k of keys) canonical.set(k, keys[0]);
    classes.set(keys[0], {
      keys, supplierIds: [...g.suppliers].sort((a, b) => a - b), fileIds: [...g.files].sort((a, b) => a - b),
    });
  }
  return { canonical, classes };
}

/** Clé canonique d'une clé de prestataire normalisée (elle-même hors équivalence). Pure. */
export function canonicalProviderKey(key: string | null, eq: ProviderEquivalence | null | undefined): string | null {
  if (key === null || !eq) return key;
  return eq.canonical.get(key) ?? key;
}

/** Les deux clés (normalisées) sont-elles équivalentes sans être égales ? Pure. */
export function providersEquivalent(a: string | null, b: string | null, eq: ProviderEquivalence | null | undefined): boolean {
  if (a === null || b === null || a === b || !eq) return false;
  return canonicalProviderKey(a, eq) === canonicalProviderKey(b, eq);
}
