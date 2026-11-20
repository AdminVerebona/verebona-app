/**
 * T3 DOCUMENT_ASSET — RATTACHEMENT HÉRITÉ DE L'OPÉRATION (carte #819).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT (préproduction, facture d'un achat déjà commandé) : la facture
 * rejoint l'opération créée par le bon de commande (rapprochement T3 certain),
 * et cette opération porte le bien (le vélo). Pourtant la résolution du bien
 * ignorait cette relation : le graphe d'identité (lots 105D / 108E) ne suit un
 * « saut » par l'opération que vers un document qui porte LUI-MÊME une
 * identité de bien (adresse, immatriculation, série). Un bon de commande
 * d'accessoire n'en porte aucune : aucun groupe, contexte croisé « NONE »,
 * recherche sémantique sans bien retenu, carte « À quel bien rattacher ce
 * document ? » avec tous les biens du compte. L'empreinte du contexte ne
 * lisant pas l'opération, une reprise APRÈS le rapprochement retrouvait le
 * même contexte et réutilisait l'abstention mémorisée.
 *
 * LA RÈGLE : « document → opération → bien » est un rattachement valable. Le
 * modèle relationnel EN PLACE pour le bien d'un document est un rattachement
 * MATÉRIALISÉ (lien N-N d'origine automatique + colonne principale), que
 * lisent déjà la fiche du document, la liste des documents du bien, la
 * Timeline, les API, les producteurs « À traiter » et les contrôles de
 * cohérence — le saut par l'opération du lot 108E l'écrit déjà ainsi. Ce
 * module n'ajoute donc AUCUN second modèle : il donne à T3 DOCUMENT_ASSET la
 * décision déterministe manquante (`OPERATION_ASSET:<opération>`), écrite par
 * le chemin canonique existant (`attachAutomatically`, garde d'admission,
 * journal), avec sa provenance.
 *
 * GARDE-FOUS (aucun n'est une règle par fournisseur, type ou mot-clé) :
 *   · APPARTENANCE ÉTABLIE seulement : source documentaire ACTIVE d'autorité
 *     forte (`strongOperationRelation` : utilisateur, ou rapprochement certain)
 *     ou rattachement explicite de l'utilisateur à l'opération. Jamais une
 *     source « probable », jamais une simple ASSOCIATION entre opérations
 *     (`business_operation_relations` n'est pas lue), jamais un lien d'Agenda ;
 *   · opération ACTIVE (ni invalidée, ni absorbée, ni annulée) du compte ;
 *   · bien NON AMBIGU : l'opération porte UN seul bien actif. Plusieurs biens :
 *     aucune règle existante ne désigne celui du document — pas d'héritage, le
 *     traitement habituel (question) reste seul juge ;
 *   · bien porté par une AUTRE preuve que ce document (jamais circulaire : un
 *     bien que l'opération ne tient que de ce document ne lui est pas rendu) ;
 *   · plusieurs opérations du document : elles doivent désigner le même bien ;
 *   · le document ne désigne pas lui-même un autre bien (identifiant, fait
 *     ciblé, référence partagée, désignation certaine de T1), n'est pas
 *     multibiens, et le bien n'a pas été refusé par l'utilisateur ;
 *   · choix, retrait ou « Aucun » de l'utilisateur : traités AVANT, par la
 *     relecture canonique (`resolve-document-asset.service.ts`) — jamais passés
 *     outre ;
 *   · le même bien ou le même fournisseur ne rapprochent rien ici : seul le
 *     rapprochement d'opération (inchangé) établit l'appartenance.
 * Module PUR (aucune base) ; les lectures, bornées au compte, sont dans
 * `operation-inheritance.store.ts`.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import type { CandidateSource } from './candidate-builder';
import type { DocumentAssetCandidate, DocumentAssetDecision } from './decision';

/** Version de la règle d'héritage (entre dans la part « opération » de l'empreinte du contexte). */
export const OPERATION_INHERITANCE_VERSION = 1;

/** Préfixe du motif de la décision, de la résolution et de la fermeture de la carte. */
export const OPERATION_ASSET_REASON = 'OPERATION_ASSET';
/** Motif tracé de la carte LINK-ASSET fermée parce que l'opération répond à la question. */
export const RESOLVED_BY_OPERATION = 'RESOLVED_BY_OPERATION';
/** Déclencheur et motif de reprise d'une réévaluation née de l'enregistrement de la relation document – opération. */
export const OPERATION_LINKED_TRIGGER = 'operation_linked';
export const OPERATION_LINKED_REASON = 'OPERATION_LINKED';

/** Appartenance ÉTABLIE d'un document à une opération active, et biens actifs de cette opération. */
export interface OperationMembership {
  operationId: number;
  /** SOURCE : source documentaire d'autorité forte ; USER_MEMBER : rattachement explicite de l'utilisateur. */
  via: 'SOURCE' | 'USER_MEMBER';
  assets: Array<{
    assetId: number;
    /** Le bien n'est porté dans l'opération QUE par une source de ce document (jamais une preuve pour lui-même). */
    ownSupport: boolean;
  }>;
}

export type OperationAttachmentStatus =
  /** Le document n'appartient à aucune opération (appartenance établie). */
  | 'NONE'
  /** Un seul bien, porté par une autre preuve : rattachement hérité possible. */
  | 'TARGET'
  /** Aucune opération du document ne porte de bien par une autre preuve que lui. */
  | 'NO_ASSET'
  /** Une opération du document porte plusieurs biens : aucun n'est désigné. */
  | 'SEVERAL_ASSETS'
  /** Les opérations du document désignent des biens différents. */
  | 'OPERATIONS_DISAGREE';

export interface OperationAttachment {
  status: OperationAttachmentStatus;
  targetAssetId: number | null;
  /** Opération qui fonde l'héritage (la plus ancienne qui désigne le bien). */
  operationId: number | null;
  /** Toutes les opérations auxquelles le document appartient. */
  operationIds: number[];
  /** Part « opération » de l'empreinte du contexte — présente SEULEMENT quand un bien est désigné. */
  fingerprint: string | null;
}

export const NO_OPERATION_ATTACHMENT: OperationAttachment = { status: 'NONE', targetAssetId: null, operationId: null, operationIds: [], fingerprint: null };

/**
 * Bien que les opérations d'un document lui désignent (pure, ordre des entrées indifférent).
 * L'empreinte n'existe que pour un bien désigné : un document dont l'opération ne désigne rien
 * garde EXACTEMENT son contexte d'avant (aucune réévaluation, aucune mémoire invalidée).
 */
export function operationAttachmentOf(memberships: readonly OperationMembership[]): OperationAttachment {
  const ms = [...memberships].sort((a, b) => a.operationId - b.operationId);
  const operationIds = [...new Set(ms.map((m) => m.operationId))];
  if (ms.length === 0) return NO_OPERATION_ATTACHMENT;
  const sans = (status: OperationAttachmentStatus): OperationAttachment => ({ status, targetAssetId: null, operationId: null, operationIds, fingerprint: null });
  if (ms.some((m) => new Set(m.assets.map((a) => a.assetId)).size > 1)) return sans('SEVERAL_ASSETS');
  const porteuses = ms.filter((m) => m.assets.length === 1 && !m.assets[0].ownSupport);
  if (porteuses.length === 0) return sans('NO_ASSET');
  const cibles = [...new Set(porteuses.map((m) => m.assets[0].assetId))];
  // Une opération du document tient d'une autre preuve un AUTRE bien : désaccord.
  if (cibles.length > 1) return sans('OPERATIONS_DISAGREE');
  // Une opération ne tient son bien que de ce document : s'il diffère, le document en désigne un autre.
  if (ms.some((m) => m.assets.length === 1 && m.assets[0].assetId !== cibles[0])) return sans('OPERATIONS_DISAGREE');
  const fingerprint = createHash('sha256').update(JSON.stringify([
    OPERATION_INHERITANCE_VERSION, cibles[0], porteuses.map((m) => [m.operationId, m.via]),
  ])).digest('hex').slice(0, 32);
  return { status: 'TARGET', targetAssetId: cibles[0], operationId: porteuses[0].operationId, operationIds, fingerprint };
}

/**
 * Rattachement déterministe hérité de l'opération (pure). APRÈS les identifiants forts, les règles
 * contextuelles et l'identité de groupe (qui priment), AVANT toute garde de groupe et tout appel au modèle.
 */
export function decideFromOperation(
  attachment: OperationAttachment | null | undefined,
  candidates: readonly DocumentAssetCandidate[],
  opts: {
    multiAssetDeclared: boolean;
    /** Biens désignés par un identifiant fort du document. */
    identifiedAssetIds: readonly number[];
    /** Biens refusés par l'utilisateur (décisions de groupe en vigueur). */
    refusedAssetIds?: readonly number[];
    /** Le bien existe encore dans le compte (index de rapprochement). */
    isLiveAsset: (assetId: number) => boolean;
  },
): DocumentAssetDecision | null {
  if (!attachment || attachment.status !== 'TARGET' || attachment.targetAssetId === null || attachment.operationId === null) return null;
  if (opts.multiAssetDeclared) return null;
  const cible = attachment.targetAssetId;
  if (!opts.isLiveAsset(cible)) return null;
  if ((opts.refusedAssetIds ?? []).includes(cible)) return null;
  // Le document désigne lui-même un AUTRE bien : jamais tranché ici (même garde que l'identité de groupe).
  if (opts.identifiedAssetIds.some((id) => id !== cible)) return null;
  const has = (c: DocumentAssetCandidate, s: CandidateSource) => !!c.sources?.includes(s);
  const autreDesigne = candidates.some((c) => c.assetId !== cible
    && (has(c, 'FACT_TARGET') || has(c, 'STRONG_IDENTIFIER') || has(c, 'SHARED_REFERENCE') || (has(c, 'T1_CANDIDATE') && c.t1?.confidence === 'certain')));
  if (autreDesigne) return null;
  return { kind: 'APPLY', assetId: cible, score: 1, method: 'DETERMINISTIC', reason: `${OPERATION_ASSET_REASON}:${attachment.operationId}` };
}

/** Opération citée par un motif `OPERATION_ASSET:<id>` (résolution, décision), sinon null. Pure. */
export function operationOfReason(reason: string | null | undefined): number | null {
  const m = /^OPERATION_ASSET:(\d{1,15})$/.exec(reason ?? '');
  return m ? Number(m[1]) : null;
}
