/**
 * Construction et interprétation d'une clarification — CDC §20.
 *
 * Module PUR (aucun accès base) : c'est ici que se décident les règles
 * qu'on veut pouvoir éprouver sans infrastructure —
 *
 *   · les candidats viennent des données du compte, jamais du modèle : leur
 *     identifiant est une référence d'entité produite par le serveur ;
 *   · leurs libellés les distinguent (« Maison — Lyon, 12 rue… ») ;
 *   · une clarification ne s'enchaîne pas indéfiniment : au plus deux dans
 *     la même demande, deux tentatives infructueuses au plus ;
 *   · une réponse tapée n'est acceptée que si elle désigne sans ambiguïté un
 *     des candidats proposés.
 */
import { randomUUID } from 'crypto';
import type { AssetRow } from './data-answer.service';
import type { ClarificationCandidate, ClarificationState } from '../types/machine';
import type { VerebonaIntent } from '../types/intents';
import type { PresentedEntity } from './reference-resolver';

/** Validité d'une clarification (§20.4). */
export const CLARIFICATION_TTL_MS = 30 * 60_000;
/** Tentatives infructueuses tolérées (§20.3). */
export const MAX_FAILED_ATTEMPTS = 2;
/** Clarifications successives dans une même demande. */
export const MAX_CLARIFICATION_CHAIN = 2;

const plain = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** Libellé secondaire qui distingue deux biens au nom proche. */
export function assetSecondaryLabel(a: AssetRow): string | undefined {
  if (a.category === 'VEHICULE' && a.registrationNumber) return a.registrationNumber;
  const lieu = [a.city, a.address].filter((x) => x && String(x).trim()).join(', ');
  if (lieu) return lieu;
  return a.subtype ?? undefined;
}

/**
 * Candidats d'une ambiguïté de bien. Si deux candidats restent
 * indiscernables (même nom, même détail), l'identifiant de rang est ajouté :
 * « Maison » / « Maison » n'est pas un choix.
 */
export function assetCandidates(assets: AssetRow[]): ClarificationCandidate[] {
  const base = assets.map((a) => ({
    id: `asset_${a.id}`,
    entityId: a.id,
    label: a.name,
    secondaryLabel: assetSecondaryLabel(a),
  }));
  const cle = (c: ClarificationCandidate) => plain(`${c.label}|${c.secondaryLabel ?? ''}`);
  const vus = new Map<string, number>();
  for (const c of base) vus.set(cle(c), (vus.get(cle(c)) ?? 0) + 1);
  const rang = new Map<string, number>();
  return base.map((c) => {
    if ((vus.get(cle(c)) ?? 0) < 2) return c;
    const n = (rang.get(cle(c)) ?? 0) + 1;
    rang.set(cle(c), n);
    return { ...c, secondaryLabel: [c.secondaryLabel, `bien n°${n}`].filter(Boolean).join(' · ') };
  });
}

export function buildAssetClarification(p: {
  assets: AssetRow[];
  reason: string;
  accountId: number;
  userId: number;
  conversationId?: number;
  originalMessage: string;
  originalMessageId: string;
  originalIntent: VerebonaIntent;
  pageAssetId?: number | null;
  chainDepth: number;
  now?: Date;
}): ClarificationState {
  const now = p.now ?? new Date();
  return {
    clarificationId: randomUUID(),
    conversationId: p.conversationId,
    accountId: p.accountId,
    userId: p.userId,
    originalMessageId: p.originalMessageId,
    originalMessage: p.originalMessage,
    originalIntent: p.originalIntent,
    resolvedContext: { pageAssetId: p.pageAssetId ?? null },
    ambiguity: { kind: 'asset', field: 'assetId', reason: p.reason },
    candidateType: 'asset',
    candidates: assetCandidates(p.assets).slice(0, 6),
    question: 'De quel bien parlez-vous ?',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CLARIFICATION_TTL_MS).toISOString(),
    attemptCount: 0,
    chainDepth: p.chainDepth,
    status: 'PENDING',
  };
}

/** Repli quand la clarification ne peut plus aboutir (§20.3). */
export const FALLBACK_ASSET_MESSAGE =
  "Je n'arrive pas à identifier précisément le bien concerné. Vous pouvez ouvrir la liste de vos biens pour le sélectionner.";

const ORDINAUX: Record<string, number> = {
  premier: 1, premiere: 1, '1': 1, un: 1, deuxieme: 2, second: 2, seconde: 2, '2': 2,
  troisieme: 3, '3': 3, quatrieme: 4, '4': 4, cinquieme: 5, '5': 5, sixieme: 6, '6': 6,
};

/**
 * Interprète une réponse TAPÉE (au lieu d'un clic) à une clarification.
 *
 *   · `match`    : un seul candidat désigné (rang, nom ou détail distinctif) ;
 *   · `no_match` : ressemble à une réponse mais ne désigne aucun candidat,
 *                  ou en désigne plusieurs — tentative infructueuse ;
 *   · `new_question` : l'utilisateur est passé à autre chose (question
 *                  complète) — la clarification est abandonnée, sa
 *                  question traitée normalement.
 */
export function interpretTypedAnswer(
  state: ClarificationState,
  text: string,
): { kind: 'match'; candidate: ClarificationCandidate } | { kind: 'no_match' } | { kind: 'new_question' } {
  const t = plain(text).replace(/[.!]+$/, '');
  if (!t) return { kind: 'no_match' };

  const mots = t.split(/[^a-z0-9]+/).filter(Boolean);
  const rangs = [...new Set(mots.map((m) => ORDINAUX[m]).filter((n): n is number => !!n))];
  if (rangs.length === 1 && mots.length <= 4 && state.candidates[rangs[0] - 1]) {
    return { kind: 'match', candidate: state.candidates[rangs[0] - 1] };
  }

  const designes = state.candidates.filter((c) => {
    const libelle = plain(c.label);
    const detail = plain(c.secondaryLabel ?? '');
    return t === libelle || t.includes(libelle) && state.candidates.filter((o) => plain(o.label) === libelle).length === 1
      || (detail && (t === detail || detail.split(/[ ,]+/).some((w) => w.length >= 4 && mots.includes(w))));
  });
  if (designes.length === 1) return { kind: 'match', candidate: designes[0] };

  // Une question complète n'est pas une réponse au choix proposé.
  if (/\?\s*$/.test(text.trim()) || t.length > 60) return { kind: 'new_question' };
  return { kind: 'no_match' };
}

/** Clarification encore utilisable ? */
export function isExpired(state: ClarificationState, now: Date = new Date()): boolean {
  return new Date(state.expiresAt).getTime() <= now.getTime();
}

/**
 * Clarification d'une référence ambiguë du fil (« ouvre l'autre » parmi
 * plusieurs) : les candidats sont les entités PRÉSENTÉES dans ce fil, dans
 * l'ordre d'affichage.
 */
export function buildEntityClarification(p: {
  entities: PresentedEntity[];
  accountId: number;
  userId: number;
  conversationId?: number;
  originalMessage: string;
  originalMessageId: string;
  originalIntent: VerebonaIntent;
  chainDepth: number;
  now?: Date;
}): ClarificationState {
  const now = p.now ?? new Date();
  const type = p.entities[0]?.type ?? 'document';
  const prefix = type === 'document' ? 'doc' : type === 'asset' ? 'asset' : 'agenda';
  const candidateType = type === 'agenda_item' ? 'agenda' : type;
  return {
    clarificationId: randomUUID(),
    conversationId: p.conversationId,
    accountId: p.accountId,
    userId: p.userId,
    originalMessageId: p.originalMessageId,
    originalMessage: p.originalMessage,
    originalIntent: p.originalIntent,
    resolvedContext: {},
    ambiguity: { kind: 'asset', field: 'assetId', reason: 'AMBIGUOUS_REFERENCE' },
    candidateType,
    candidates: p.entities.slice(0, 6).map((e) => ({
      id: `${prefix}_${e.id}`,
      entityId: e.id,
      label: e.label ?? `Élément n°${e.position}`,
      secondaryLabel: `n°${e.position} de la liste`,
    })),
    question: type === 'document' ? 'De quel document parlez-vous ?' : type === 'asset' ? 'De quel bien parlez-vous ?' : 'De quelle échéance parlez-vous ?',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CLARIFICATION_TTL_MS).toISOString(),
    attemptCount: 0,
    chainDepth: p.chainDepth,
    status: 'PENDING',
  };
}
