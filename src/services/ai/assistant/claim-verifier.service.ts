/**
 * Vérification des citations — CDC Assistant §4.3.6.
 *
 * « Toute affirmation factuelle doit être rattachée à au moins une source. Les
 *   identifiants de sources renvoyés par le modèle sont revalidés côté serveur
 *   avant affichage. »
 *
 * POINT ESSENTIEL : une citation invalide n'invalide pas seulement l'affichage
 * de la source, elle invalide L'AFFIRMATION. Afficher une phrase sans sa source
 * reviendrait à présenter comme établi ce que rien ne soutient — exactement le
 * défaut que le sourçage est censé corriger.
 */
import type { SourceRef } from './tools/tool.port';
import { ASSISTANT_LIMITS } from './tools/tool.port';

export interface Claim {
  /** Phrase ou paragraphe de la réponse. */
  text: string;
  /** Identifiants de sources cités par le modèle. */
  citedSourceIds: number[];
  /** true si l'affirmation est factuelle et exige une source. */
  factual: boolean;
}

export interface VerifiedAnswer {
  claims: Array<Claim & { verified: boolean; resolvedSources: SourceRef[] }>;
  /** Sources réellement affichables, plafonnées au §31.2. */
  displayedSources: SourceRef[];
  /** Affirmations retirées faute de source valide. */
  droppedClaims: string[];
  status: 'answered' | 'insufficient_data';
}

/**
 * Confronte les citations du modèle aux sources réellement remontées par les
 * outils. Une source absente de cette liste n'existe pas, quelle que soit
 * l'assurance avec laquelle le modèle l'a citée.
 */
export function verifyClaims(claims: Claim[], availableSources: SourceRef[]): VerifiedAnswer {
  const byId = new Map(availableSources.map((s) => [s.id, s]));
  const used = new Set<number>();
  const dropped: string[] = [];

  const verified = claims.map((claim) => {
    // Une formulation non factuelle — reformulation de la question, transition —
    // n'a pas besoin de source.
    if (!claim.factual) {
      return { ...claim, verified: true, resolvedSources: [] };
    }

    const resolved = claim.citedSourceIds
      .map((id) => byId.get(id))
      .filter((s): s is SourceRef => s !== undefined);

    const ok = resolved.length > 0;
    if (!ok) dropped.push(claim.text);
    resolved.forEach((s) => used.add(s.id));

    return { ...claim, verified: ok, resolvedSources: resolved };
  });

  const displayedSources = availableSources
    .filter((s) => used.has(s.id))
    .slice(0, ASSISTANT_LIMITS.maxSourcesDisplayed)
    .map((s) => ({
      ...s,
      excerpt: s.excerpt
        ? truncate(s.excerpt, ASSISTANT_LIMITS.maxDisplayedExcerptChars)
        : undefined,
    }));

  const factualClaims = verified.filter((c) => c.factual);
  const anyVerified = factualClaims.some((c) => c.verified);

  return {
    claims: verified,
    displayedSources,
    droppedClaims: dropped,
    // Aucune affirmation factuelle sourcée : la réponse n'a rien à dire.
    status: factualClaims.length > 0 && !anyVerified ? 'insufficient_data' : 'answered',
  };
}

/** Reconstitue le texte affiché, privé des affirmations non sourcées. */
export function composeVerifiedText(answer: VerifiedAnswer): string {
  return answer.claims
    .filter((c) => c.verified)
    .map((c) => c.text)
    .join(' ')
    .trim();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
