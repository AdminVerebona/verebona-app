/**
 * Pipeline de retrieval-first — CDC §13.
 *
 * Ordre (§13.1) : sécurité/périmètre → résolution d'entités → recherche structurée →
 * plein texte → sémantique (option, désactivée) → classement → dédup → limites de
 * contexte → seuil d'insuffisance. Le périmètre compte est appliqué à CHAQUE requête
 * (§13.2) : aucune donnée hors `account_id`.
 *
 * ⚠️ JAMAIS de sérialisation de l'ensemble du compte (anti-pattern §26.2). Ce service
 *    REMPLACE `src/lib/gemini-search.ts` + la partie « chargement de contexte » de
 *    `src/lib/intelligent-search.ts`.
 */
import { pgClient, ensureUnaccent } from '@/db';
import type { IntentRoute } from '../types/contracts';
import type { AssistantRequestInput } from '../types/contracts';
import type { RetrievedSource } from '../types/sources';
import { getAssistantConfig } from '../config/assistant-config';
import { getEnabledAdapters } from '../registries/retrieval-adapter-registry';
import { resolveEntities } from './entity-resolution.service';
import type { ConversationRefs } from '../types/machine';

export async function retrieve(route: IntentRoute, input: AssistantRequestInput): Promise<RetrievedSource[]> {
  const cfg = getAssistantConfig();
  await ensureUnaccent();

  // 1. Sécurité & périmètre (§13.2) — accountId vient du serveur, jamais du client.
  const accountId = input.accountId;

  // ══════════════════════════════════════════════════════════════════════
  // 2. RÉSOLUTION D'ENTITÉS — §13.3
  //
  // `resolveEntities` existait, testée, et n'était appelée par personne. Ses
  // résultats ne parvenaient donc jamais aux adaptateurs, qui recevaient un
  // `entityFilters` toujours vide.
  //
  // Conséquence : « et son DPE ? » après une réponse sur un bien cherchait
  // dans TOUT le compte au lieu de ce bien. L'assistant comprenait la
  // référence et l'oubliait aussitôt.
  //
  // Le contexte de page compte autant : sur la fiche d'un bien, « mes
  // factures » désigne les siennes.
  // ══════════════════════════════════════════════════════════════════════
  const refs: ConversationRefs = {
    lastPresentedEntities: [],
    // `PageContext.assetId` est une chaîne côté client ; la référence
    // conversationnelle attend un entier.
    currentAssetId: Number(input.pageContext?.assetId) || null,
  };
  const entites = resolveEntities(input.message, refs, input.pageContext);

  // Une référence ambiguë ne filtre rien : mieux vaut chercher large que
  // chercher à côté. La clarification du §20 prend alors le relais.
  const entityFilters: Record<string, string | number | null> = {};
  if (!entites.ambiguous) {
    for (const e of entites.resolved) {
      // Première référence de chaque type seulement : deux biens désignés
      // simultanément produiraient un filtre qui n'en retiendrait aucun.
      const cle = `${e.type}Id`;
      if (entityFilters[cle] === undefined) entityFilters[cle] = e.id;
    }
  }

  // 3–5. Adapters (structuré, plein texte, [sémantique désactivé]).
  const adapters = getEnabledAdapters();
  const collected: RetrievedSource[] = [];
  for (const a of adapters) {
    const part = await a.search({
      accountId,
      normalizedQuery: input.message,
      intent: route.intent,
      entityFilters,
      limit: cfg.maxCandidates,
    });
    collected.push(...part);
  }

  // Repli si aucun adapter enregistré : recherche structurée minimale sur les biens.
  if (adapters.length === 0) {
    collected.push(...(await structuredAssetSearch(accountId, input.message, cfg.maxCandidates)));
  }

  // 6–7. Classement + déduplication (§13.7-13.8).
  const deduped = dedupe(collected).sort((x, y) => (y.relevanceScore ?? 0) - (x.relevanceScore ?? 0));

  // 8. Limites de contexte (§13.9) : ≤ maxSources, extraits bornés.
  return deduped.slice(0, cfg.maxSources).map((s) => ({
    ...s,
    content: s.content.slice(0, cfg.maxExcerptChars),
  }));
}

/** Recherche structurée de base sur les biens du compte (niveau 1 — §13.4). */
async function structuredAssetSearch(accountId: number, query: string, limit: number): Promise<RetrievedSource[]> {
  // Paramétré, borné au compte. unaccent pour tolérance accents (§13.5).
  const rows = await pgClient.unsafe(
    `SELECT id, name, category, city
       FROM assets
      WHERE account_id = $1 AND deleted_at IS NULL
        AND unaccent(lower(coalesce(name,''))) LIKE unaccent(lower($2))
      ORDER BY name
      LIMIT $3`,
    [accountId, `%${query}%`, limit],
  );
  return (rows as unknown as Array<{ id: number; name: string; category: string | null; city: string | null }>).map((r) => ({
    id: `asset_${r.id}`,
    type: 'asset_field' as const,
    title: r.name,
    content: [r.category, r.city].filter(Boolean).join(' · '),
    meta: { assetId: r.id },
    relevanceScore: 0.5,
  }));
}

function dedupe(list: RetrievedSource[]): RetrievedSource[] {
  const seen = new Set<string>();
  return list.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
}
