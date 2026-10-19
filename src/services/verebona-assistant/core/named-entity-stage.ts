/**
 * Lot 71 (71D) — ticket « BUG P1 — T2 : rechercher et proposer les
 * équipements et les pièces sans IA », écart C / correction D.
 *
 * Une saisie soumise à T2 qui n'est QUE le nom d'un équipement ou d'une pièce
 * du compte (« Pompe à chaleur », « Cuisine », « Chambre parentale ») est
 * résolue AVANT toute classification par modèle :
 *   · une seule correspondance EXACTE (à la normalisation près) → l'entité
 *     est proposée directement, sans appel modèle ;
 *   · plusieurs → candidates avec leur bien parent, choix demandé (jamais
 *     de choix arbitraire) ;
 *   · aucune (ou un bien porte aussi exactement ce nom) → la cascade T2
 *     suit son cours, inchangée.
 *
 * La recherche elle-même est celle de la barre de recherche
 * (`services/search/global-search.service.ts` → `findNamedEntities` :
 * mêmes candidats SQL, même éligibilité `runSearchPipeline`, même
 * normalisation `isExactNameMatch`) — aucun moteur parallèle, aucun
 * dictionnaire de noms. Ce module ne fait que DÉCIDER (pur, sans base).
 */
import { parseSearchQuery } from '@/lib/search/match-engine';
import type { RetrievedSource } from '../types/sources';
import type { Claim } from '../types/sources';

/** Équipement / pièce dont le nom EST la saisie (forme de `findNamedEntities`). */
export interface NamedEntity {
  kind: 'equipment' | 'room';
  id: number;
  name: string;
  assetId: number;
  assetName: string | null;
}

export interface NamedEntityLookupResult {
  entities: NamedEntity[];
  /** Un bien du compte porte aussi exactement ce nom : pas de raccourci. */
  assetHomonym: boolean;
}

/**
 * Mots qui désignent une CATÉGORIE d'objets, jamais un objet nommé :
 * « équipements », « pièces » ne deviennent pas une cible arbitraire
 * (ticket §3 D). Racines normalisées (`parseSearchQuery`).
 */
const MOTS_GENERIQUES: ReadonlySet<string> = new Set(['equipement', 'equipements', 'piece', 'pieces']);

/** Bornes d'une saisie nominative : un nom, pas une phrase. */
const MAX_MOTS = 6;

/**
 * La saisie peut-elle être un NOM d'équipement ou de pièce ? (1 à 6 mots
 * significatifs, pas uniquement des mots génériques.) La décision finale
 * reste la correspondance EXACTE avec un nom réel du compte.
 */
export function isNamedEntityQuery(message: string | null | undefined): boolean {
  const q = parseSearchQuery(String(message ?? ''));
  if (q.tokens.length === 0 || q.tokens.length > MAX_MOTS) return false;
  return !q.tokens.every((t) => MOTS_GENERIQUES.has(t.norm) || MOTS_GENERIQUES.has(t.stem));
}

export type NamedEntityDecision =
  | { kind: 'none'; reason: 'NO_LOOKUP' | 'NO_EXACT_MATCH' | 'ASSET_HOMONYM' }
  | { kind: 'single'; entity: NamedEntity }
  | { kind: 'choice'; entities: NamedEntity[] };

/**
 * Décision déterministe. `chosen` : reprise après le choix de l'utilisateur
 * (clarification) — l'entité choisie n'est servie que si elle est TOUJOURS
 * trouvée par le même nom dans le compte (revalidation).
 */
export function decideNamedEntity(
  lookup: NamedEntityLookupResult | null | undefined,
  chosen?: { type: 'equipment' | 'room'; id: number } | null,
): NamedEntityDecision {
  if (!lookup) return { kind: 'none', reason: 'NO_LOOKUP' };
  if (chosen) {
    const e = lookup.entities.find((x) => x.kind === chosen.type && x.id === chosen.id);
    return e ? { kind: 'single', entity: e } : { kind: 'none', reason: 'NO_EXACT_MATCH' };
  }
  // Un bien du compte porte aussi exactement ce nom : la cascade existante
  // (résolution des biens) garde la main — jamais d'arbitrage ici.
  if (lookup.assetHomonym) return { kind: 'none', reason: 'ASSET_HOMONYM' };
  if (lookup.entities.length === 0) return { kind: 'none', reason: 'NO_EXACT_MATCH' };
  if (lookup.entities.length === 1) return { kind: 'single', entity: lookup.entities[0] };
  return { kind: 'choice', entities: lookup.entities.slice(0, 6) };
}

const NATURE: Record<NamedEntity['kind'], string> = { equipment: 'Équipement', room: 'Pièce' };

/** « Équipement · Maison Lyon » : nature puis bien parent. */
export function namedEntityContext(e: NamedEntity): string {
  return [NATURE[e.kind], e.assetName].filter(Boolean).join(' · ');
}

/**
 * Source de l'entité, au format des adaptateurs de retrieval
 * (`equipment_<id>` / `room_<id>`, bien parent en métadonnées) :
 * `hrefEntite` en fait le lien profond du TIROIR, et `openDrawer` demande
 * à l'action d'ouvrir l'entité elle-même, pas la fiche du bien parent.
 */
export function namedEntitySource(e: NamedEntity): RetrievedSource {
  return {
    id: `${e.kind}_${e.id}`,
    type: 'asset_field',
    title: e.name,
    content: `${e.name} — ${namedEntityContext(e)}`,
    meta: {
      ...(e.kind === 'equipment' ? { equipmentId: e.id } : { roomId: e.id }),
      assetId: e.assetId,
      assetName: e.assetName,
      entityType: e.kind,
      openDrawer: true,
    },
    relevanceScore: 1,
  };
}

/** Réponse : « Pompe à chaleur — Équipement · Maison Lyon. » */
export function namedEntityAnswer(e: NamedEntity): { text: string; claims: Claim[] } {
  const text = `${e.name} — ${namedEntityContext(e)}.`;
  return { text, claims: [{ claimKey: `named_entity_${e.kind}_${e.id}`, text, sourceIds: [`${e.kind}_${e.id}`], derivation: 'direct' }] };
}

/** Question de choix entre homonymes (bien parent dans chaque candidat). */
export function namedEntityChoiceQuestion(entities: NamedEntity[]): string {
  const nom = entities[0]?.name ?? '';
  const memeType = entities.every((e) => e.kind === entities[0]?.kind);
  const quoi = !memeType ? 'Plusieurs éléments' : entities[0]?.kind === 'room' ? 'Plusieurs pièces' : 'Plusieurs équipements';
  const lequel = memeType && entities[0]?.kind === 'room' ? 'laquelle' : 'lequel';
  return `${quoi} s’appellent « ${nom} » : ${lequel} voulez-vous ouvrir ?`;
}
