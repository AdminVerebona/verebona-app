/**
 * T3 DOCUMENT_NAMING — lots ADAPTATIFS, budget et préfiltre déterministe
 * (lot 109J, ticket « T3:6033 — nommage documentaire en échec »).
 *
 * Incident 6033 : lot de 25 documents d'un même assureur (plusieurs contrats,
 * plusieurs biens) envoyé en un appel (48 312 jetons en entrée), sortie
 * tronquée au plafond (8 192, dont 324 visibles : le reste en raisonnement),
 * puis relance 6 h plus tard du MÊME appel. Ce module, pur, fournit :
 *
 *   · `familyKeyOf` — VRAIE famille documentaire d'un document (nature +
 *     émetteur + contrat, sinon bien) : un émetteur n'est jamais une famille ;
 *   · `planFamilyChunks` — découpage d'un lot en appels qui ne mélange pas
 *     les familles quand c'est possible (une famille n'est coupée que si elle
 *     dépasse un appel ; références prises d'abord dans la même famille :
 *     convention stable d'un appel à l'autre) ;
 *   · `namingBudget` / `estimatePromptTokens` — budget d'entrée et de sortie
 *     d'un appel ; un appel estimé hors budget est redécoupé AVANT envoi ;
 *   · `reducedChunkSize` — taille réduite après OUTPUT_TRUNCATED /
 *     CONTEXT_TOO_LARGE (jamais un appel identique rejoué) ;
 *   · `namingRetryDelayMs` — reprise à délai BORNÉ et croissant ;
 *   · `conformantFamilies` — préfiltre : familles dont tous les titres
 *     suivent déjà une même forme (seuls dates et nombres varient) — aucun
 *     appel IA nécessaire pour elles.
 * Paramètres centralisés (variables d'environnement, défauts prudents).
 */
import { envNumber } from '@/lib/env-number';
import { isValidBusinessTitle } from '@/lib/documents/document-title-rules';
import { hasLegacyTitleTypography } from '@/lib/documents/document-title-convention';
import { isProtected, supplierKey, type NamingDoc } from './context';

const MINUTE = 60_000;
const HEURE = 60 * MINUTE;

/** Taille minimale d'un appel réduit (documents à examiner + références). */
export const NAMING_MIN_CHUNK_DOCS = 2;
/** Échecs successifs d'un lot au-delà desquels l'échec est PERSISTANT (alerte BO). */
export const NAMING_PERSISTENT_FAILURE_ATTEMPTS = 4;

export interface NamingBudget {
  /** Jetons d'entrée visés par appel (prompt maître compris). */
  inputTokens: number;
  /** Jetons de sortie VISIBLE visés par appel (le raisonnement consomme aussi le plafond). */
  outputTokens: number;
  /** Jetons de sortie estimés par document à examiner (famille + éventuel renommage). */
  outputTokensPerDoc: number;
  /** Partie fixe estimée du prompt maître et du contrat runtime. */
  promptOverheadTokens: number;
}

export function namingBudget(env: Record<string, string | undefined> = process.env): NamingBudget {
  const n = (k: string, d: number, min: number) => Math.floor(envNumber(k, d, { min }, env));
  return {
    inputTokens: n('T3_NAMING_INPUT_TOKEN_BUDGET', 24_000, 2_000),
    outputTokens: n('T3_NAMING_OUTPUT_TOKEN_BUDGET', 3_000, 500),
    outputTokensPerDoc: n('T3_NAMING_OUTPUT_TOKENS_PER_DOC', 160, 40),
    promptOverheadTokens: n('T3_NAMING_PROMPT_OVERHEAD_TOKENS', 5_000, 0),
  };
}

/** Documents à examiner au plus par appel selon le budget de SORTIE. */
export function maxTargetsForOutput(b: NamingBudget): number {
  return Math.max(1, Math.floor(b.outputTokens / b.outputTokensPerDoc));
}

/**
 * Jetons estimés des variables d'un appel (pure) : ~3,5 caractères par jeton
 * pour du JSON francophone (estimation prudente, sans tokeniseur).
 */
export function estimatePromptTokens(variables: Record<string, unknown>, b: NamingBudget): number {
  let chars = 0;
  for (const v of Object.values(variables)) chars += typeof v === 'string' ? v.length : v == null ? 0 : JSON.stringify(v).length;
  return b.promptOverheadTokens + Math.ceil(chars / 3.5);
}

/** Taille d'appel réduite après une sortie tronquée ou un contexte trop grand (pure) ; `null` : plus réductible. */
export function reducedChunkSize(currentDocs: number): number | null {
  if (currentDocs <= NAMING_MIN_CHUNK_DOCS) return null;
  return Math.max(NAMING_MIN_CHUNK_DOCS, Math.floor(currentDocs / 2));
}

/** Délai de reprise d'un lot en échec (pure) : 30 min, 1 h, 2 h… plafonné à 24 h. */
export function namingRetryDelayMs(attempts: number): number {
  const k = Math.max(1, Math.floor(attempts));
  return Math.min(24 * HEURE, 30 * MINUTE * 2 ** (k - 1));
}

/** Famille documentaire d'un document (pure) : nature + émetteur + contrat, sinon bien. */
export function familyKeyOf(d: Pick<NamingDoc, 'typeCode' | 'supplier' | 'contractRefs' | 'assetId'>): string {
  const contrat = [...(d.contractRefs ?? [])].sort()[0];
  return `${d.typeCode ?? '-'}|${supplierKey(d.supplier) ?? '-'}|${contrat ? `c:${contrat}` : d.assetId ? `a:${d.assetId}` : '-'}`;
}

export interface FamilyChunk { index: number; count: number; targets: NamingDoc[]; references: NamingDoc[] }

/**
 * Découpage d'un lot en appels PAR FAMILLE (pure). Lot tenant en un appel :
 * un seul appel (comportement historique). Au-delà : chaque appel porte au
 * plus `maxDocs - R` documents à examiner (R = maxDocs / 4, au plus 8), les
 * familles sont rangées dans l'ordre de leur premier document et regroupées
 * sans être coupées (sauf famille plus grande qu'un appel) ; références : les
 * autres documents des familles de l'appel d'abord (convention), puis les
 * plus récents des autres documents du lot.
 */
export function planFamilyChunks(docs: readonly NamingDoc[], targets: readonly NamingDoc[], maxDocs: number): FamilyChunk[] {
  if (!targets.length) return [];
  const ids = new Set(targets.map((d) => d.id));
  const autres = docs.filter((d) => !ids.has(d.id));
  if (docs.length <= maxDocs) return [{ index: 0, count: 1, targets: [...targets], references: autres }];
  const r = Math.max(1, Math.min(8, Math.floor(maxDocs / 4)));
  const t = Math.max(1, maxDocs - r);
  const familles = new Map<string, NamingDoc[]>();
  for (const d of targets) {
    const k = familyKeyOf(d);
    const l = familles.get(k) ?? [];
    l.push(d);
    familles.set(k, l);
  }
  const paquets: NamingDoc[][] = [];
  let cur: NamingDoc[] = [];
  for (const fam of familles.values()) {
    if (cur.length && cur.length + fam.length > t) { paquets.push(cur); cur = []; }
    for (let i = 0; i < fam.length; i += t) {
      const part = fam.slice(i, i + t);
      if (part.length === t) { if (cur.length) { paquets.push(cur); cur = []; } paquets.push(part); } else cur.push(...part);
    }
  }
  if (cur.length) paquets.push(cur);
  const count = paquets.length;
  return paquets.map((tg, index) => {
    const fams = new Set(tg.map(familyKeyOf));
    const dansAppel = new Set(tg.map((d) => d.id));
    const memeFamille = docs.filter((d) => !dansAppel.has(d.id) && fams.has(familyKeyOf(d)));
    const reste = autres.filter((d) => !fams.has(familyKeyOf(d)));
    const references = [...memeFamille.slice(-r), ...reste.slice(-r)].slice(0, r);
    return { index, count, targets: tg, references };
  });
}

const MOIS = 'janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre'
  + '|janv|févr|fevr|avr|juil|sept|oct|nov|déc|dec';
const MOIS_RE = new RegExp(`(?<![\\p{L}])(${MOIS})\\.?(?![\\p{L}])`, 'giu');

/** Forme d'un titre (pure) : mois et nombres masqués, le reste à l'identique (casse, séparateurs). */
export function titleShape(name: string): string {
  return name.normalize('NFC').replace(/\s+/g, ' ').trim()
    .replace(MOIS_RE, (m) => (m[0] === m[0].toLocaleUpperCase('fr-FR') ? '‹M›' : '‹m›'))
    .replace(/\d+/g, '#');
}

/**
 * Préfiltre déterministe (pure) : familles (≥ 2 documents) dont TOUS les
 * titres ont la même forme (`titleShape`), sont distincts, valides (aucun
 * jeton technique) et sans ancienne typographie. Les documents de ces
 * familles — noms d'origine stable (utilisateur, T1, T3), jamais un nom de
 * fichier déposé ni d'origine inconnue — n'ont pas besoin de l'IA : ils restent fournis comme RÉFÉRENCES
 * aux appels des autres familles du lot. Une famille avec un seul titre
 * divergent reste entièrement à examiner (jamais un préfiltre partiel).
 */
/** Origines de nom admises par le préfiltre : nom déjà choisi par l'utilisateur ou produit par Verebona (jamais un nom de fichier). */
const ORIGINES_STABLES: ReadonlySet<string> = new Set(['USER', 'T1', 'T3', 'T3_HARMONIZATION']);
const EXTENSION_FICHIER = /\.[a-z0-9]{2,5}$/i;

export function conformantFamilies(docs: readonly NamingDoc[], originOf: (d: NamingDoc) => string): { conformant: Set<number>; families: Array<{ key: string; ids: number[]; shape: string }> } {
  const parFamille = new Map<string, NamingDoc[]>();
  for (const d of docs) {
    const k = familyKeyOf(d);
    const l = parFamille.get(k) ?? [];
    l.push(d);
    parFamille.set(k, l);
  }
  const conformant = new Set<number>();
  const families: Array<{ key: string; ids: number[]; shape: string }> = [];
  for (const [key, l] of parFamille) {
    if (l.length < 2) continue;
    const formes = new Set(l.map((d) => titleShape(d.name)));
    const noms = new Set(l.map((d) => d.name.normalize('NFC').trim().toLocaleLowerCase('fr-FR')));
    const valides = l.every((d) => ORIGINES_STABLES.has(originOf(d)) && !EXTENSION_FICHIER.test(d.name.trim())
      && (isProtected(d) || (isValidBusinessTitle(d.name) && !hasLegacyTitleTypography(d.name))));
    if (formes.size !== 1 || noms.size !== l.length || !valides) continue;
    for (const d of l) conformant.add(d.id);
    families.push({ key, ids: l.map((d) => d.id).sort((a, b) => a - b), shape: [...formes][0] });
  }
  return { conformant, families };
}
