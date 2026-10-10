/**
 * T3 DOCUMENT_ASSET — décisions PURES (lot 31B, ticket T3 §4, §5, §7, §8).
 *
 *   1. `decideDeterministic` : AVANT tout appel modèle. Un identifiant
 *      canonique exact et unique rattache sans IA ; deux biens désignés
 *      chacun par une valeur qui lui est propre, dans un document que T1 a
 *      déclaré multi-biens, sont reliés tous deux (A ET B) ; le reste part au
 *      modèle (ou à l'utilisateur).
 *   2. `documentAssetVariables` : ce que le prompt maître T3 reçoit —
 *      candidats fournis par le serveur, preuves de T1, faits persistés,
 *      identifiants NON sensibles, signaux serveur sans valeur. Jamais le
 *      fichier, jamais l'adresse d'un bien.
 *   3. `decideFromAiOutput` : APRÈS le modèle, en code déterministe —
 *      monde fermé (U1), seuil, confiance `certain` exigée, marge entre deux
 *      candidats (A OU B), multi-biens (A ET B) seulement si le modèle le
 *      déclare ET que chaque bien est certain, et jamais un candidat SANS
 *      AUCUNE preuve fournie (« pas uniquement parce qu'il est seul »).
 */
import { closedWorldLinkAmbiguity, type T3LinkAmbiguityOutput } from '../master/t3-contract';
import { decideLinks, LINK_MIN_MARGIN } from '../master/link-ambiguity';
import type { IdentifierResolution } from './identifiers';
import { isPromptSafeKey } from './identifiers';
import type { CandidateSource } from './candidate-builder';

/** Seuil de rattachement automatique par le modèle (et confiance `certain`). */
export const DOCUMENT_ASSET_AUTO_THRESHOLD = 0.8;

/** Relation transmise au master (`RELATION_TYPE`). */
export const DOCUMENT_ASSET_RELATION =
  'DOCUMENT_ASSET — bien(s) existant(s) du compte auquel rattacher ce document : un seul bien principal, '
  + 'plusieurs seulement si le document concerne réellement plusieurs biens (documentScope = MULTIPLE)';

export interface DocumentAssetCandidate {
  assetId: number;
  name: string;
  family: string | null;
  subtype: string | null;
  /** Identifiants NON sensibles (`promptIdentifiers`). */
  identifiers: Record<string, string>;
  /** Correspondances exactes constatées par le serveur (libellés, sans valeur). */
  serverSignals: string[];
  /** Proposition et preuves de T1, s'il a cité ce bien. */
  t1: { confidence: string; score: number; reason: string; signals: string } | null;
  /** Rôle du lien IA actuel (bien cité par T1, ou cible de faits). */
  currentRole: 'SECONDARY' | 'MENTIONED' | null;
  /** Provenance (Candidate Builder, lot 34E). Absente : candidat construit à l'ancienne. */
  sources?: CandidateSource[];
  /** Indices de contexte (catégorie, ville…) — transmis au modèle, jamais une preuve. */
  contextSignals?: string[];
  /** Nom / alias discriminant cité dans une zone désignante (règle « nom distinctif unique »). */
  distinctiveNameMatch?: boolean;
}

/**
 * Limite du CONTEXTE ENVOYÉ AU MODÈLE (prompt T3), jamais une limite de
 * découverte : le Candidate Builder examine tous les biens du compte ; seuls
 * les mieux classés sont transmis, et la décision reste en monde fermé sur
 * ceux-là.
 */
export const DOCUMENT_ASSET_PROMPT_MAX_CANDIDATES = 60;

export type DocumentAssetDecision =
  | { kind: 'APPLY'; assetId: number; score: number; reason: string; method: 'DETERMINISTIC' | 'AI' }
  | { kind: 'MULTI_ASSET'; assetIds: number[]; reason: string; method: 'DETERMINISTIC' | 'AI' }
  | {
    kind: 'ABSTAIN';
    reasonCode: 'NO_CANDIDATE' | 'INSUFFICIENT_EVIDENCE' | 'AMBIGUOUS' | 'CLOSED_WORLD_VIOLATION' | 'UNSUPPORTED_CHOICE' | 'AI_UNAVAILABLE';
    /** Candidats proposés à l'utilisateur, du plus au moins probable. */
    ranked: Array<{ assetId: number; score: number; reason: string }>;
  };

/** Le serveur a-t-il fourni au moins une preuve pour ce candidat ? */
export function hasEvidence(c: DocumentAssetCandidate): boolean {
  return c.serverSignals.length > 0
    || c.currentRole === 'SECONDARY'
    || !!(c.t1 && (c.t1.signals.trim() || c.t1.reason.trim()));
}

/** Score a priori d'un candidat (ordre des propositions sans avis du modèle). */
export function priorScore(c: DocumentAssetCandidate): number {
  const src = c.sources;
  if (src) {
    if (src.includes('STRONG_IDENTIFIER')) return 0.85;
    if (src.includes('SHARED_REFERENCE')) return 0.8;
    if (c.distinctiveNameMatch) return 0.75;
  } else if (c.serverSignals.length > 0) return 0.85;
  if (src && (src.includes('EXACT_NAME') || src.includes('ALIAS'))) return Math.max(0.65, t1Score(c));
  if (src && src.includes('BRAND_MODEL')) return Math.max(0.6, t1Score(c));
  return Math.max(t1Score(c), c.currentRole === 'SECONDARY' ? 0.6 : c.currentRole === 'MENTIONED' ? 0.4
    : (c.contextSignals?.length ?? 0) > 0 ? 0.3 : 0.2);
}

function t1Score(c: DocumentAssetCandidate): number {
  return c.t1 ? Math.min(0.85, Math.max(0, Number.isFinite(c.t1.score) ? c.t1.score : 0.5)) : 0;
}

/**
 * Candidats transmis au modèle : les `DOCUMENT_ASSET_PROMPT_MAX_CANDIDATES`
 * mieux classés (score a priori, puis identifiant). Pure.
 */
export function promptCandidates(candidates: DocumentAssetCandidate[], max = DOCUMENT_ASSET_PROMPT_MAX_CANDIDATES): DocumentAssetCandidate[] {
  if (candidates.length <= max) return candidates;
  return [...candidates].sort((a, b) => priorScore(b) - priorScore(a) || a.assetId - b.assetId).slice(0, max);
}

/** Classement neutre des candidats (abstention sans avis exploitable du modèle). */
export function rankCandidates(candidates: DocumentAssetCandidate[]): Array<{ assetId: number; score: number; reason: string }> {
  return candidates
    .map((c) => ({
      assetId: c.assetId,
      score: priorScore(c),
      reason: c.serverSignals[0] ?? c.t1?.reason ?? (c.currentRole === 'SECONDARY' ? 'cible de faits du document'
        : c.contextSignals?.[0] ?? 'bien cité par le document'),
    }))
    .sort((a, b) => b.score - a.score || a.assetId - b.assetId);
}

/** Avant le modèle : identifiants canoniques exacts (aucun appel IA). */
export function decideDeterministic(
  identification: IdentifierResolution,
  opts: { multiAssetDeclared: boolean },
): DocumentAssetDecision | null {
  if (identification.uniqueAssetId !== null) {
    const kinds = identification.matches.map((m) => m.kind).join(', ');
    return { kind: 'APPLY', assetId: identification.uniqueAssetId, score: 1, reason: `IDENTIFIER_EXACT:${kinds}`, method: 'DETERMINISTIC' };
  }
  if (identification.multiAssetCandidate && opts.multiAssetDeclared) {
    return { kind: 'MULTI_ASSET', assetIds: identification.assetIds, reason: 'IDENTIFIERS_EXCLUSIVE_PER_ASSET', method: 'DETERMINISTIC' };
  }
  return null;
}

/**
 * Règles déterministes ÉTENDUES (lot 34E), appliquées après les identifiants
 * forts quand aucun identifiant ne désigne de bien :
 *   · SHARED_REFERENCE : un seul bien porte, sur un AUTRE document déjà
 *     rattaché, le même n° de contrat / police ;
 *   · DISTINCT_NAME : un seul bien est désigné par un nom (ou alias)
 *     discriminant — au moins deux mots significatifs, hors catégorie —
 *     cité dans le titre, la description ou un fait ; aucun autre bien n'est
 *     cité par son nom.
 * Jamais quand le document est déclaré multi-biens, ni quand T1 (certain) ou
 * un fait désigne un AUTRE bien : le modèle tranche alors. Un nom générique,
 * une catégorie ou une ville ne rattachent jamais.
 */
export function decideContextualDeterministic(
  candidates: DocumentAssetCandidate[],
  identification: IdentifierResolution,
  opts: { multiAssetDeclared: boolean },
): DocumentAssetDecision | null {
  if (opts.multiAssetDeclared || identification.assetIds.length > 0) return null;
  const has = (c: DocumentAssetCandidate, s: CandidateSource) => !!c.sources?.includes(s);
  const autresDesignes = (id: number) => candidates.some((c) => c.assetId !== id
    && (has(c, 'FACT_TARGET') || (has(c, 'T1_CANDIDATE') && c.t1?.confidence === 'certain')));
  const refs = candidates.filter((c) => has(c, 'SHARED_REFERENCE'));
  if (refs.length === 1 && !autresDesignes(refs[0].assetId)) {
    return { kind: 'APPLY', assetId: refs[0].assetId, score: 1, reason: 'SHARED_REFERENCE', method: 'DETERMINISTIC' };
  }
  const nommes = candidates.filter((c) => has(c, 'EXACT_NAME') || has(c, 'ALIAS'));
  if (nommes.length === 1 && nommes[0].distinctiveNameMatch && !autresDesignes(nommes[0].assetId)) {
    return { kind: 'APPLY', assetId: nommes[0].assetId, score: 1, reason: 'DISTINCT_NAME', method: 'DETERMINISTIC' };
  }
  return null;
}

// ── Variables du master ────────────────────────────────────────────────────

export interface DocumentSubject {
  title: string | null;
  documentType: string | null;
  documentDate: string | null;
  supplier: string | null;
  description: string | null;
  multiAssetDeclared: boolean | null;
  facts: Array<{ canonicalKey: string | null; label: string | null; value: string | null; excerpt: string | null }>;
}

const borne = (v: unknown, n: number): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, n) : null;
};

/** Ligne de candidat transmise au modèle (identifiants non sensibles, signaux sans valeur). */
export function describeCandidate(c: DocumentAssetCandidate): string {
  const parts = [`"${c.name}" (${[c.family, c.subtype].filter(Boolean).join(', ') || 'bien'})`];
  const ids = Object.entries(c.identifiers).filter(([k]) => isPromptSafeKey(k)).map(([k, v]) => `${k}=${v}`);
  if (ids.length) parts.push(`identifiants: ${ids.join(', ')}`);
  if (c.serverSignals.length) parts.push(`contrôle serveur: ${c.serverSignals.join(' ; ')}`);
  if (c.contextSignals?.length) parts.push(`indices de contexte (insuffisants seuls): ${c.contextSignals.join(' ; ')}`);
  if (c.t1) parts.push(`T1: ${c.t1.confidence} (${c.t1.score}) ${borne([c.t1.reason, c.t1.signals].filter(Boolean).join(' — '), 240) ?? ''}`.trim());
  if (c.currentRole) parts.push(`lien actuel: ${c.currentRole === 'SECONDARY' ? 'cible de faits (SECONDARY)' : 'bien cité (MENTIONED)'}`);
  if (!hasEvidence(c)) parts.push('aucune preuve fournie');
  return parts.join(' — ').slice(0, 700);
}

/**
 * Variables du master T3 pour la relation DOCUMENT_ASSET (branche
 * LINK_AMBIGUITY). Candidats triés par identifiant (ordre neutre, comme
 * `reconcileLinksMaster`). Faits : clés sensibles du registre exclues.
 */
export function documentAssetVariables(subject: DocumentSubject, candidates: DocumentAssetCandidate[]): Record<string, unknown> {
  const facts = subject.facts
    .filter((f) => !f.canonicalKey || isPromptSafeKey(f.canonicalKey))
    .slice(0, 25)
    .map((f) => ({ key: f.canonicalKey ?? f.label ?? null, value: borne(f.value, 120), excerpt: borne(f.excerpt, 160) }));
  return {
    FIELD: null,
    CURRENT_STATE: null,
    EVIDENCES: null,
    SUBJECT_CONTEXT: JSON.stringify({
      document: {
        title: borne(subject.title, 160), type: subject.documentType, date: subject.documentDate,
        supplier: borne(subject.supplier, 120), description: borne(subject.description, 300),
        multiAssetDeclaredByT1: subject.multiAssetDeclared,
      },
      facts,
    }),
    CANDIDATES: [...candidates]
      .sort((a, b) => a.assetId - b.assetId)
      .map((c) => ({ candidateId: c.assetId, description: describeCandidate(c) })),
    RELATION_TYPE: DOCUMENT_ASSET_RELATION,
  };
}

// ── Après le modèle ─────────────────────────────────────────────────────────

/** Décision déterministe sur la sortie du master (pure). */
export function decideFromAiOutput(output: T3LinkAmbiguityOutput, candidates: DocumentAssetCandidate[]): DocumentAssetDecision {
  const byId = new Map(candidates.map((c) => [c.assetId, c]));
  const { output: out, warnings } = closedWorldLinkAmbiguity(output, new Set(byId.keys()));
  if (warnings.length > 0) return { kind: 'ABSTAIN', reasonCode: 'CLOSED_WORLD_VIOLATION', ranked: rankCandidates(candidates) };

  const ranked = (() => {
    const vus = new Map<number, { assetId: number; score: number; reason: string }>();
    for (const m of [...out.matches].sort((a, b) => b.score - a.score || a.candidateId - b.candidateId)) {
      vus.set(m.candidateId, { assetId: m.candidateId, score: Math.min(m.score, 0.89), reason: m.reason });
    }
    for (const r of rankCandidates(candidates)) if (!vus.has(r.assetId)) vus.set(r.assetId, { ...r, score: Math.min(r.score, 0.3) });
    return [...vus.values()];
  })();

  const auDessus = out.matches.filter((m) => m.score >= DOCUMENT_ASSET_AUTO_THRESHOLD);
  const eligibles = auDessus.filter((m) => m.confidence === 'certain' && hasEvidence(byId.get(m.candidateId)!));
  const sansPreuve = auDessus.filter((m) => !hasEvidence(byId.get(m.candidateId)!));

  // A ET B : déclaré par le modèle, chaque bien certain et prouvé.
  if (out.documentScope === 'MULTIPLE' && eligibles.length >= 2) {
    return {
      kind: 'MULTI_ASSET',
      assetIds: eligibles.map((m) => m.candidateId).sort((a, b) => a - b),
      reason: eligibles.map((m) => `${m.candidateId}: ${m.reason}`).join(' ; ').slice(0, 400),
      method: 'AI',
    };
  }
  if (eligibles.length === 0) {
    return { kind: 'ABSTAIN', reasonCode: sansPreuve.length > 0 ? 'UNSUPPORTED_CHOICE' : 'INSUFFICIENT_EVIDENCE', ranked };
  }
  // A OU B : marge entre les candidats au-dessus du seuil (toutes confiances).
  const { ambiguity } = decideLinks(auDessus, { exclusive: true, threshold: DOCUMENT_ASSET_AUTO_THRESHOLD, minMargin: LINK_MIN_MARGIN });
  if (ambiguity) return { kind: 'ABSTAIN', reasonCode: 'AMBIGUOUS', ranked };
  const top = [...auDessus].sort((a, b) => b.score - a.score || a.candidateId - b.candidateId)[0];
  if (!eligibles.some((m) => m.candidateId === top.candidateId)) {
    return { kind: 'ABSTAIN', reasonCode: 'INSUFFICIENT_EVIDENCE', ranked };
  }
  return { kind: 'APPLY', assetId: top.candidateId, score: top.score, reason: top.reason, method: 'AI' };
}
