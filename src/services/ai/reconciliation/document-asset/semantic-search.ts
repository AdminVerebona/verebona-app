/**
 * T3 DOCUMENT_ASSET — RECHERCHE SÉMANTIQUE quand le Candidate Builder ne
 * trouve AUCUN candidat structuré (lot 57B — ticket P0 « T3 — Corriger les À
 * traiter non résolus », défaut B).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT CORRIGÉ
 *
 * `resolveDocumentAsset` rendait NO_CANDIDATE SANS appeler l'IA dès que le
 * Candidate Builder (identifiants, noms, alias, références…) ne trouvait
 * rien : une facture de fournisseur (télécom, garage, gardiennage de pneus,
 * entretien) ou un avis d'impôt qui ne cite ni l'immatriculation ni l'adresse
 * exacte restait indéfiniment « À quel bien rattacher ce document ? », sans
 * que personne n'ait raisonné sur son contenu.
 *
 * LA CORRECTION — aucune règle propre à un fournisseur, un garage ou un type
 *
 *   1. Présélection serveur PROGRESSIVE parmi les SEULS biens du compte
 *      (index du compte : jamais un bien d'un autre compte) : indices
 *      calculés depuis la connaissance T1 persistée et l'état du compte —
 *        · HISTORIQUE FOURNISSEUR (preuve serveur) : documents du MÊME
 *          fournisseur déjà rattachés à ce bien (contrôle exact en base) ;
 *        · ÉQUIPEMENT (indice) : un équipement du bien partage un mot
 *          significatif avec le document (« pneus », « chaudière »…) ;
 *        · VOCABULAIRE (indice) : nom, alias, catégorie, sous-type, marque /
 *          modèle, ville du bien partagent un mot avec le document ;
 *      classement par indices, puis par identifiant (stable).
 *   2. Branche IA EXISTANTE (prompt maître T3, LINK_AMBIGUITY, relation
 *      DOCUMENT_ASSET) — aucun changement de prompt : les candidats sont
 *      ceux du serveur (monde fermé), la relation précise qu'il s'agit d'une
 *      recherche sémantique (D3 : jamais « le seul bien du compte »).
 *   3. Décision INCHANGÉE (`decideFromAiOutput`) : rattachement automatique
 *      seulement si le modèle est certain (≥ 0,8) ET qu'une preuve serveur
 *      soutient le bien (historique fournisseur) ; sinon proposition à
 *      l'utilisateur (arbitrage, avec la justification du modèle).
 *   4. Comptes volumineux : pages de `SEMANTIC_PAGE_SIZE` biens, au plus
 *      `SEMANTIC_MAX_ROUNDS` appels ; au-delà de la première page, seuls les
 *      biens portant au moins un indice sont présentés (aucun appel à
 *      l'aveugle sur des centaines de biens).
 *
 * Aucun nom de fichier n'est utilisé (jamais une preuve).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { DocumentKnowledgeSources } from './document-sources';
import type { AccountMatchingIndex } from './matching-index';
import { normalizeText, promptIdentifiers } from './identifiers';
import { significantTokens } from './candidate-builder';
import { DOCUMENT_ASSET_RELATION, type DocumentAssetCandidate } from './decision';

const SEMANTIC_PAGE_SIZE = 20;
const SEMANTIC_MAX_ROUNDS = 3;

/** Relation transmise au modèle (variable, pas le prompt) : commence par « DOCUMENT_ASSET ». */
export const SEMANTIC_RELATION = `${DOCUMENT_ASSET_RELATION} — RECHERCHE SÉMANTIQUE : aucun candidat structuré `
  + '(identifiant, nom, référence) n’a été trouvé ; les candidats sont des biens du compte présélectionnés par le serveur. '
  + 'Ne retiens un bien que si le contenu du document (fournisseur, prestation, objet, faits) le désigne réellement.';

export interface SemanticHint {
  assetId: number;
  score: number;
  /** Preuves serveur (contrôle exact en base). */
  serverSignals: string[];
  /** Indices (jamais une preuve seuls). */
  contextSignals: string[];
  /** Origine des indices (journal : « origine des indices »). */
  origins: string[];
}

const MOTS_FAIBLES = new Set(['facture', 'avis', 'document', 'contrat', 'date', 'total', 'montant', 'ttc', 'ht', 'tva', 'euro', 'eur', 'numero', 'client', 'reference', 'page', 'pour', 'avec', 'sur', 'par']);

/** Mots significatifs (≥ 4 lettres, hors mots trop génériques) d'un texte. Pure. */
function semanticTokens(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const t of significantTokens(normalizeText(text))) {
    if (t.length >= 4 && /[a-z]/.test(t) && !MOTS_FAIBLES.has(t)) out.add(t.replace(/s$/, ''));
  }
  return out;
}

/** Mots qui DÉSIGNENT le document (titre, description, fournisseur, type, faits) — jamais le nom du fichier. Pure. */
export function documentTokens(sources: DocumentKnowledgeSources): Set<string> {
  const out = new Set<string>();
  const add = (v: string | null | undefined) => { for (const t of semanticTokens(v)) out.add(t); };
  const e = sources.extraction;
  add(e?.title); add(e?.description); add(e?.supplier); add(e?.documentType?.replace(/_/g, ' '));
  for (const t of sources.texts) if (t.zone !== 'BODY' && !t.uncertain) add(t.text.slice(0, 2000));
  for (const f of sources.facts.slice(0, 200)) { add(f.label); add(f.value); add(f.subject); }
  return out;
}

/**
 * Présélection classée de TOUS les biens du compte (pure, déterministe).
 * `supplierHistory` : bien → nombre de documents du même fournisseur déjà
 * rattachés (contrôle exact en base).
 */
export function semanticShortlist(index: AccountMatchingIndex, sources: DocumentKnowledgeSources, supplierHistory: ReadonlyMap<number, number>): SemanticHint[] {
  const doc = documentTokens(sources);
  const equipements = new Map<number, string[]>();
  for (const en of index.entities) {
    if (!index.byId.has(en.assetId)) continue;
    equipements.set(en.assetId, [...(equipements.get(en.assetId) ?? []), en.name]);
  }
  const hints = index.assets.map((a): SemanticHint => {
    const h: SemanticHint = { assetId: a.assetId, score: 0, serverSignals: [], contextSignals: [], origins: [] };
    const n = supplierHistory.get(a.assetId) ?? 0;
    if (n > 0) {
      h.score += 3 + Math.min(n, 5);
      h.serverSignals.push(`historique fournisseur : ${n} document(s) du même fournisseur déjà rattaché(s) à ce bien`);
      h.origins.push('SUPPLIER_HISTORY');
    }
    const eq = (equipements.get(a.assetId) ?? []).filter((name) => [...semanticTokens(name)].some((t) => doc.has(t)));
    if (eq.length > 0) {
      h.score += 2;
      h.contextSignals.push(`équipement du bien évoqué par le document : ${eq.slice(0, 3).join(', ')}`);
      h.origins.push('EQUIPMENT');
    }
    const vocab = new Set<string>([
      ...semanticTokens(a.name), ...a.aliases.flatMap((x) => [...semanticTokens(x)]), ...semanticTokens(a.category),
      ...semanticTokens(a.subtype), ...semanticTokens(a.brandModel), ...semanticTokens(a.city),
    ]);
    const communs = [...vocab].filter((t) => doc.has(t));
    if (communs.length > 0) {
      h.score += communs.length;
      h.contextSignals.push(`vocabulaire commun avec le document : ${communs.slice(0, 5).join(', ')}`);
      h.origins.push('VOCABULARY');
    }
    return h;
  });
  return hints.sort((x, y) => y.score - x.score || x.assetId - y.assetId);
}

/** Pages de la sélection progressive (pure) : page 1 = meilleurs biens ; suivantes = biens indiqués seulement. */
export function semanticPages(shortlist: SemanticHint[], pageSize = SEMANTIC_PAGE_SIZE, maxRounds = SEMANTIC_MAX_ROUNDS): SemanticHint[][] {
  const pages: SemanticHint[][] = [];
  if (shortlist.length === 0) return pages;
  pages.push(shortlist.slice(0, pageSize));
  const reste = shortlist.slice(pageSize).filter((h) => h.score > 0);
  for (let i = 0; i < reste.length && pages.length < maxRounds; i += pageSize) pages.push(reste.slice(i, i + pageSize));
  return pages;
}

/** Candidats transmis au modèle pour une page (identifiants NON sensibles seulement). Pure. */
export function semanticCandidates(page: SemanticHint[], index: AccountMatchingIndex): DocumentAssetCandidate[] {
  return page.map((h) => {
    const a = index.byId.get(h.assetId)!;
    return {
      assetId: a.assetId, name: a.name, family: a.family, subtype: a.subtype ?? a.category,
      identifiers: promptIdentifiers(a.record), serverSignals: h.serverSignals,
      contextSignals: h.contextSignals.length ? h.contextSignals : ['présélection sémantique (aucun indice structuré)'],
      t1: null, currentRole: null, sources: ['CONTEXTUAL_MATCH'],
    };
  });
}

/** Documents du MÊME fournisseur déjà rattachés (bien principal), par bien du compte — base. */
export async function loadSupplierHistory(accountId: number, fileId: number, supplier: string | null): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const s = supplier ? normalizeText(supplier) : '';
  if (s.length < 2) return out;
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `SELECT f.asset_id AS id, e.supplier_name AS supplier
       FROM asset_files f JOIN document_extractions e ON e.file_id = f.id AND e.account_id = f.account_id
       JOIN assets a ON a.id = f.asset_id AND a.account_id = f.account_id AND a.deleted_at IS NULL
      WHERE f.account_id = $1 AND f.id <> $2 AND f.deleted_at IS NULL AND f.asset_id IS NOT NULL
        AND e.supplier_name IS NOT NULL AND position(lower($3) in lower(e.supplier_name)) > 0
      LIMIT 2000`,
    [accountId, fileId, supplier!.trim().slice(0, 80).split(/\s+/)[0]] as never[],
  )) as unknown as Array<{ id: number; supplier: string }>;
  for (const r of rows) {
    if (normalizeText(r.supplier) !== s) continue;
    out.set(Number(r.id), (out.get(Number(r.id)) ?? 0) + 1);
  }
  return out;
}
