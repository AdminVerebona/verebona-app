/**
 * Lot 113G (ticket #706) — identité de DEUX fiches fournisseur (pur, testé).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE RÈGLE POUR TOUS LES CHEMINS
 *
 * Le rapprochement d'un document (`findCandidates` / `assessMatch`), la
 * saisie de l'Agenda, la carte « À traiter » et le contrôle de cohérence du
 * stock jugent une paire par cette fonction :
 *
 *   IDENTIFIER   SIREN (ou SIREN du SIRET) identique, ou TVA identique :
 *                même entreprise — CERTAIN ;
 *   CONTRADICTORY SIREN (ou TVA) connus des deux côtés et DIFFÉRENTS :
 *                entreprises distinctes — jamais rapprochées, aucune carte ;
 *                SAUF raison sociale identique (NAME_ID_CONFLICT) : plausible,
 *                l'utilisateur tranche (aucun rattachement non prouvé) ;
 *   EXACT_NAME   même raison sociale normalisée, aucun identifiant
 *                contradictoire — certain (rapprochement actuel conservé :
 *                c'est le même libellé, pas un nom « similaire ») ;
 *   SIMILAR_NAME nom PROCHE (contenu mot pour mot dans l'autre, même premier
 *                mot distinctif et au moins deux mots communs, ou faute de
 *                lecture) — PLAUSIBLE, jamais certain : arbitrage Oui / Non ;
 *   NONE         aucun signal crédible.
 *
 * Un nom similaire SEUL n'est JAMAIS une certitude (règle 2 du ticket).
 * ══════════════════════════════════════════════════════════════════════════
 */
export interface SupplierIdentityFacts {
  id: number;
  name: string;
  normalizedName?: string | null;
  siren?: string | null;
  siret?: string | null;
  vatNumber?: string | null;
}

export type PairBasis = 'IDENTIFIER' | 'CONTRADICTORY' | 'EXACT_NAME' | 'SIMILAR_NAME' | 'NAME_ID_CONFLICT' | 'NONE';
export type PairVerdict = 'CERTAIN' | 'PLAUSIBLE' | 'DISTINCT' | 'NONE';

export interface PairAssessment {
  verdict: PairVerdict;
  basis: PairBasis;
  /** Score historique (compatibilité `Candidate.score`) : 100+ identifiant, 80 nom exact, 50 nom proche. */
  score: number;
}

const chiffres = (v: string | null | undefined) => (v ?? '').replace(/[\s.\-]/g, '');

/** SIREN de la fiche : le SIREN, sinon les 9 premiers chiffres d'un SIRET valide. */
export function sirenOf(f: Pick<SupplierIdentityFacts, 'siren' | 'siret'>): string | null {
  const s = chiffres(f.siren);
  if (/^\d{9}$/.test(s)) return s;
  const t = chiffres(f.siret);
  return /^\d{14}$/.test(t) ? t.slice(0, 9) : null;
}

const tva = (v: string | null | undefined) => {
  const s = (v ?? '').replace(/\s/g, '').toUpperCase();
  return s.length >= 8 ? s : null;
};

/** Mots distinctifs d'un nom normalisé (au moins 3 caractères ; « du », « de », « et »… écartés). */
export function significantTokens(normalized: string): string[] {
  return normalized.split(' ').filter((t) => t.length >= 3);
}

/** Distance d'édition bornée (faute de lecture d'un nom). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length; const n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/** Similarité de NOMS (pure) : 'EXACT' | 'SIMILAR' | 'NONE'. Jamais une certitude d'identité à elle seule. */
export function nameSimilarity(aNorm: string, bNorm: string): 'EXACT' | 'SIMILAR' | 'NONE' {
  const a = aNorm.trim(); const b = bNorm.trim();
  if (!a || !b) return 'NONE';
  if (a === b) return 'EXACT';
  const ta = significantTokens(a); const tb = significantTokens(b);
  if (!ta.length || !tb.length) return 'NONE';
  const [court, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const setLong = new Set(long);
  // Nom contenu mot pour mot dans l'autre (« Raynard » / « Raynard Traitement du Bois »).
  if (court.every((t) => setLong.has(t)) && court.some((t) => t.length >= 4)) return 'SIMILAR';
  // Même premier mot distinctif et au moins deux mots communs (« Raynard Bois Traitement » / « Raynard Traitement Bois 38 »).
  const communs = court.filter((t) => setLong.has(t)).length;
  if (ta[0] === tb[0] && ta[0].length >= 4 && communs >= 2) return 'SIMILAR';
  // Faute de lecture (OCR) sur un nom assez long : au plus une lettre sur dix.
  const sa = ta.join(' '); const sb = tb.join(' ');
  if (Math.min(sa.length, sb.length) >= 8 && levenshtein(sa, sb) <= Math.floor(Math.max(sa.length, sb.length) / 10)) return 'SIMILAR';
  return 'NONE';
}

/** Nom normalisé de la fiche (`suppliers.normalized_name`, posé par `normalizeName` à l'écriture). */
const norm = (f: SupplierIdentityFacts) => (f.normalizedName ?? '').trim()
  || f.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Jugement d'une paire (pur). Voir l'en-tête. */
export function assessSupplierPair(a: SupplierIdentityFacts, b: SupplierIdentityFacts): PairAssessment {
  const sa = sirenOf(a); const sb = sirenOf(b);
  const va = tva(a.vatNumber); const vb = tva(b.vatNumber);
  const n = nameSimilarity(norm(a), norm(b));
  if ((sa && sb && sa !== sb) || (va && vb && va !== vb)) {
    // Même raison sociale mais identifiants contradictoires (homonyme, établissement repris, SIRET mal lu) :
    // ni certitude ni rejet silencieux — l'utilisateur tranche, SIREN des deux fiches sous les yeux.
    return n === 'EXACT' ? { verdict: 'PLAUSIBLE', basis: 'NAME_ID_CONFLICT', score: 45 } : { verdict: 'DISTINCT', basis: 'CONTRADICTORY', score: 0 };
  }
  if ((sa && sb && sa === sb) || (va && vb && va === vb)) return { verdict: 'CERTAIN', basis: 'IDENTIFIER', score: 100 };
  if (n === 'EXACT') return { verdict: 'CERTAIN', basis: 'EXACT_NAME', score: 80 };
  if (n === 'SIMILAR') return { verdict: 'PLAUSIBLE', basis: 'SIMILAR_NAME', score: 50 };
  return { verdict: 'NONE', basis: 'NONE', score: 0 };
}

/** Paire normalisée NON ORDONNÉE (plus petit identifiant d'abord). */
export function pairKey(x: number, y: number): { low: number; high: number; key: string } {
  const low = Math.min(x, y); const high = Math.max(x, y);
  return { low, high, key: `${low}:${high}` };
}

/**
 * Empreinte des preuves OBJECTIVES d'une paire (identifiants connus des deux
 * côtés). Un changement de nom n'en fait pas partie : il n'est jamais une
 * preuve nouvelle substantielle.
 */
export function pairEvidenceFingerprint(a: SupplierIdentityFacts, b: SupplierIdentityFacts): string {
  const [x, y] = a.id <= b.id ? [a, b] : [b, a];
  return `siren:${sirenOf(x) ?? '-'}|${sirenOf(y) ?? '-'};tva:${tva(x.vatNumber) ?? '-'}|${tva(y.vatNumber) ?? '-'}`;
}

export interface StoredPairDecision {
  decision: 'SAME' | 'DISTINCT';
  basis: string | null;
  evidenceFingerprint: string | null;
}

/**
 * Une décision « identités distinctes » est-elle à reproposer (pure) ? Seulement
 * si une preuve OBJECTIVE nouvelle rend désormais la paire CERTAINE par
 * identifiant (même SIREN / TVA des deux côtés) alors que ce n'était pas le cas
 * à la décision. Réanalyse, nom proche, nouveau document du même nom : jamais.
 * Rend le motif de réouverture, ou null.
 */
export function distinctDecisionReopenReason(
  d: StoredPairDecision | null | undefined, now: PairAssessment, fingerprintNow: string,
): string | null {
  if (!d || d.decision !== 'DISTINCT') return null;
  if (now.basis !== 'IDENTIFIER') return null;
  if (d.basis === 'IDENTIFIER' || d.evidenceFingerprint === fingerprintNow) return null;
  return 'NEW_MATCHING_IDENTIFIER';
}
