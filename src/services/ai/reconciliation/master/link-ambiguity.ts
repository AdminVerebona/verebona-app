/**
 * T3 master — branche LINK_AMBIGUITY (CDC 15 §25, T3-07, L1 à L5).
 *
 * Remplace, quand la version de configuration déclare T3 en architecture
 * `master`, l'appel `reconcile_links`, SANS changer son interface : les
 * appelants (`equipment-auto-link`) passent toujours leurs listes de
 * candidats `[id:N] …` par section, et reçoivent toujours
 * `ReconcileLinksResult`. Chaque section non vide devient UN appel
 * LINK_AMBIGUITY, avec sa relation propre : les identifiants de documents,
 * d'échéances, de fournisseurs et d'équipements ne se mélangent jamais
 * (monde fermé par relation, U1).
 *
 * T3-07, en code déterministe, APRÈS le modèle :
 *   · plage [0, 1] — imposée par le schéma ;
 *   · seuils existants (`LINK_SCORE_THRESHOLDS`, inchangés) — toujours
 *     appliqués par l'appelant (`retainAbove`) ;
 *   · marge minimale `LINK_MIN_MARGIN` entre le premier et le deuxième
 *     candidat d'une relation EXCLUSIVE (une seule cible possible), calculée
 *     UNIQUEMENT parmi les candidats au-dessus du seuil de la relation : un
 *     second candidat sous le seuil ne sera jamais lié, il ne bloque donc
 *     jamais le premier ;
 *   · abstention explicite (marge insuffisante ou égalité) : aucune liaison
 *     automatique, ambiguïté remontée dans `ambiguities` ;
 *   · ordre neutre : candidats triés par identifiant avant envoi (aucun
 *     signal de rang issu du déterministe).
 */
import { AiGateway } from '../../gateway/ai-gateway';
import { isAiGatewayError } from '../../gateway/errors';
import { isExecutionCancelled } from '../../queue/execution-control';
import {
  T3LinkAmbiguityOutput, closedWorldLinkAmbiguity, type T3LinkMatch,
} from './t3-contract';

/** Seuils d'application des liaisons, repris à l'identique de l'existant. */
export const LINK_SCORE_THRESHOLDS = {
  /** Rattachement d'un équipement à des documents, agendas et fournisseurs. */
  equipmentToObjects: 0.4,
  /** Rattachement d'un document à un équipement. */
  documentToEquipment: 0.5,
} as const;

/**
 * Marge minimale entre le meilleur et le deuxième candidat d'une relation
 * exclusive (T3-07). En deçà — égalité comprise —, le lien est ambigu : aucun
 * rattachement automatique, l'utilisateur tranche.
 *
 * 0,15 : un peu plus que l'écart entre deux paliers de confiance usuels
 * (0,7 « probable » / 0,85 « certain ») ; deux scores dans la même bande
 * ne se départagent pas. Réglable ici seulement, jamais dans le prompt.
 */
export const LINK_MIN_MARGIN = 0.15;

/** Sections historiques de `reconcile_links` et leur relation T3. */
export const LINK_RELATIONS = {
  documents: {
    variable: 'DOCUMENTS_LIST',
    relation: 'EQUIPMENT_DOCUMENT — documents qui concernent cet équipement (plusieurs possibles)',
    exclusive: false, threshold: LINK_SCORE_THRESHOLDS.equipmentToObjects,
  },
  agendaItems: {
    variable: 'AGENDA_LIST',
    relation: 'EQUIPMENT_AGENDA_ITEM — échéances qui concernent cet équipement (plusieurs possibles)',
    exclusive: false, threshold: LINK_SCORE_THRESHOLDS.equipmentToObjects,
  },
  suppliers: {
    variable: 'SUPPLIERS_LIST',
    relation: 'EQUIPMENT_SUPPLIER — fournisseurs de cet équipement (plusieurs possibles)',
    exclusive: false, threshold: LINK_SCORE_THRESHOLDS.equipmentToObjects,
  },
  matches: {
    variable: 'EQUIPMENTS_LIST',
    relation: 'DOCUMENT_EQUIPMENT — l’unique équipement concerné par ce document',
    exclusive: true, threshold: LINK_SCORE_THRESHOLDS.documentToEquipment,
  },
} as const;
export type LinkSection = keyof typeof LINK_RELATIONS;

export interface LinkCandidate {
  candidateId: number;
  description: string;
}

/** Lit les candidats `[id:N] …` d'une liste historique ; triés par identifiant. */
export function parseCandidates(list: unknown): LinkCandidate[] {
  if (typeof list !== 'string') return [];
  const out = new Map<number, LinkCandidate>();
  for (const line of list.split('\n')) {
    const m = /^\s*\[id:(\d+)\]\s*(.*)$/.exec(line);
    if (!m) continue;
    const id = Number(m[1]);
    if (id > 0 && !out.has(id)) out.set(id, { candidateId: id, description: m[2].trim().slice(0, 400) });
  }
  return [...out.values()].sort((a, b) => a.candidateId - b.candidateId);
}

export interface LinkAmbiguity {
  section: LinkSection;
  reasonCode: 'LINK_MARGIN_INSUFFICIENT' | 'LINK_TIE' | 'CLOSED_WORLD_VIOLATION';
  candidateIds: number[];
  /**
   * Marge insuffisante ou égalité : candidats en concurrence, tous AU-DESSUS
   * du seuil de la relation, avec score et raison du modèle — de quoi
   * proposer le choix à l'utilisateur. Absent pour une violation du monde
   * fermé (réponse inexploitable).
   */
  candidates?: Array<{ candidateId: number; score: number; reason: string }>;
}

/**
 * Décision déterministe T3-07 sur la sortie (déjà passée au monde fermé).
 *
 * Relation non exclusive : tous les candidats proposés sont conservés.
 * Relation exclusive : la marge se mesure entre le premier et le deuxième
 * candidat AU-DESSUS du seuil d'application (`threshold`, 0 par défaut) ;
 * les candidats sous le seuil n'entrent jamais dans la comparaison.
 */
export function decideLinks(
  matches: T3LinkMatch[], opts: { exclusive: boolean; minMargin?: number; threshold?: number },
): { retained: T3LinkMatch[]; ambiguity: Omit<LinkAmbiguity, 'section'> | null } {
  const tries = [...matches].sort((a, b) => b.score - a.score || a.candidateId - b.candidateId);
  if (!opts.exclusive) return { retained: tries, ambiguity: null };
  const eligibles = tries.filter((m) => m.score >= (opts.threshold ?? 0));
  if (eligibles.length < 2) return { retained: tries, ambiguity: null };
  const marge = eligibles[0].score - eligibles[1].score;
  const minMargin = opts.minMargin ?? LINK_MIN_MARGIN;
  // Tolérance d'arrondi : 0,8 − 0,65 doit valoir la marge de 0,15.
  if (marge + 1e-9 >= minMargin) return { retained: tries, ambiguity: null };
  const ex = eligibles.filter((m) => eligibles[0].score - m.score + 1e-9 < minMargin);
  return {
    retained: [],
    ambiguity: {
      reasonCode: marge === 0 ? 'LINK_TIE' : 'LINK_MARGIN_INSUFFICIENT',
      candidateIds: ex.map((m) => m.candidateId),
      candidates: ex.map((m) => ({ candidateId: m.candidateId, score: m.score, reason: m.reason })),
    },
  };
}

export interface MasterLinksResult {
  documents: Array<{ id: number; score: number; reason: string }>;
  agendaItems: Array<{ id: number; score: number; reason: string }>;
  suppliers: Array<{ id: number; score: number; reason: string }>;
  matches: Array<{ id: number; score: number; reason: string }>;
  /** Abstentions explicites (T3-07) : à proposer à l'utilisateur, jamais liées. */
  ambiguities: LinkAmbiguity[];
}

export interface LinkAmbiguityMasterInput {
  accountId: number;
  userId?: number;
  variables: Record<string, unknown>;
  sourceIds?: number[];
}

/** Départage par le master, section par section. Ne lève pas, sauf interruption d'exécution. */
export async function reconcileLinksMaster(input: LinkAmbiguityMasterInput): Promise<MasterLinksResult> {
  const result: MasterLinksResult = { documents: [], agendaItems: [], suppliers: [], matches: [], ambiguities: [] };
  for (const section of Object.keys(LINK_RELATIONS) as LinkSection[]) {
    const spec = LINK_RELATIONS[section];
    const candidates = parseCandidates(input.variables[spec.variable]);
    if (candidates.length === 0) continue;
    try {
      const res = await AiGateway.execute({
        useCaseCode: 'DATA_RECONCILIATION',
        operationCode: 't3_link_ambiguity',
        accountId: input.accountId,
        userId: input.userId,
        sourceIds: input.sourceIds,
        promptVariables: {
          FIELD: null, CURRENT_STATE: null, EVIDENCES: null,
          SUBJECT_CONTEXT: input.variables.SUBJECT_CONTEXT ?? null,
          CANDIDATES: candidates,
          RELATION_TYPE: spec.relation,
        },
        outputSchema: T3LinkAmbiguityOutput,
      });
      const { output, warnings } = closedWorldLinkAmbiguity(res.data, new Set(candidates.map((c) => c.candidateId)));
      if (warnings.length > 0) {
        console.warn(`[t3_link_ambiguity] ${section} : ${warnings.map((w) => `${w.code}:${w.id}`).join(', ')} — abstention (U1)`);
        result.ambiguities.push({ section, reasonCode: 'CLOSED_WORLD_VIOLATION', candidateIds: candidates.map((c) => c.candidateId) });
        continue;
      }
      const { retained, ambiguity } = decideLinks(output.matches, { exclusive: spec.exclusive, threshold: spec.threshold });
      if (ambiguity) result.ambiguities.push({ section, ...ambiguity });
      result[section] = retained.map((m) => ({ id: m.candidateId, score: m.score, reason: m.reason }));
    } catch (e) {
      if (isExecutionCancelled(e)) throw e;
      const detail = isAiGatewayError(e) ? `${e.code} — ${e.message}` : (e as Error).message;
      console.warn(`[t3_link_ambiguity] ${section} : départage indisponible (${detail}) — déterministe seul.`);
    }
  }
  if (result.ambiguities.length > 0) {
    console.warn(`[t3_link_ambiguity] abstention explicite : ${result.ambiguities
      .map((a) => `${a.section} ${a.reasonCode} [${a.candidateIds.join(',')}]`).join(' ; ')}`);
  }
  return result;
}
