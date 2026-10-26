/**
 * Garde-fou de FIDÉLITÉ au besoin — lot 53 (53H, ticket « T2 : faire
 * comprendre par l'IA les demandes courtes au lieu de substituer une autre
 * information »). Module PUR (registre seulement), testé.
 *
 * Une fois les faits demandés DÉTERMINÉS (`requestedFacts` : compréhension
 * déterministe complète, UNDERSTAND, reprise), une réponse qui ne porte que
 * sur D'AUTRES champs (« Motorisation de Polo : … » pour une date d'achat)
 * est rejetée par le serveur : appartenir au même bien ne suffit jamais.
 *
 * Champs d'une réponse : clés d'affirmation `field:<clé>` et sources de
 * niveau champ citées par les affirmations (`asset_field:<id>:<clé>`,
 * `equipment_field:` / `room_field:`). Une réponse SANS champ identifiable
 * (liste de documents, échéances, absence) n'est pas concernée.
 */
import { getField } from '@/services/canonical/registry';
import type { Claim } from '../types/sources';
import { parseAssetFieldSourceId, parseEntityFieldSourceId } from '../canonical/source-ids';

/** Champs canoniques sur lesquels porte une réponse (ordre d'apparition, dédoublonnés). */
export function answeredFieldKeys(claims: readonly Pick<Claim, 'claimKey' | 'sourceIds'>[]): string[] {
  const out: string[] = [];
  const add = (k: string | null | undefined) => { if (k && getField(k) && !out.includes(k)) out.push(k); };
  for (const c of claims) {
    const m = /^field:([A-Za-z][A-Za-z0-9_]*)$/.exec(c.claimKey ?? '');
    if (m) add(m[1]);
    for (const id of c.sourceIds ?? []) add(parseAssetFieldSourceId(id)?.key ?? parseEntityFieldSourceId(id)?.key);
  }
  return out;
}

/**
 * Champs ACCEPTABLES pour une demande : les champs demandés et leurs
 * composants d'affichage (une adresse complète cite code postal et ville).
 */
function acceptableFieldKeys(requested: readonly string[]): Set<string> {
  const ok = new Set<string>();
  for (const k of requested) {
    ok.add(k);
    for (const g of getField(k)?.composedDisplay ?? []) for (const c of g) ok.add(c);
  }
  return ok;
}

/**
 * Réponse SUBSTITUÉE (pure) : des faits sont demandés, la réponse porte sur
 * au moins un champ, et AUCUN d'eux n'est un champ demandé. `[]` : fidèle
 * (ou non concernée).
 */
export function substitutedFieldKeys(requested: readonly string[], claims: readonly Pick<Claim, 'claimKey' | 'sourceIds'>[]): string[] {
  if (!requested.length) return [];
  const cles = answeredFieldKeys(claims);
  if (!cles.length) return [];
  const ok = acceptableFieldKeys(requested);
  return cles.some((k) => ok.has(k)) ? [] : cles;
}

/** Libellés des champs demandés (« date d'achat, kilométrage »), pour une absence explicite. */
function requestedFieldsLabel(requested: readonly string[]): string {
  const libs = requested.map((k) => getField(k)?.label ?? k).map((l) => (/^[A-ZÉÈ][a-zà-ÿ]/.test(l) ? l.charAt(0).toLowerCase() + l.slice(1) : l));
  return libs.length <= 1 ? (libs[0] ?? '') : `${libs.slice(0, -1).join(', ')} et ${libs[libs.length - 1]}`;
}

/** Absence explicite quand aucune lecture ciblée n'a pu être servie (jamais une autre donnée). */
export function requestedFactsMissingMessage(requested: readonly string[], targetName?: string | null): string {
  const lib = requestedFieldsLabel(requested);
  return targetName
    ? `Je n’ai pas trouvé l’information demandée (${lib}) pour ${targetName}.`
    : `Je n’ai pas trouvé l’information demandée (${lib}).`;
}
