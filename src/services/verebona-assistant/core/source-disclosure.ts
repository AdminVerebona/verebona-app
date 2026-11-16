/**
 * Sources sur demande — Trello #753, CDC T2 §1.3 (5), §7.6, §8.4 (exemple E), §12.4, §13.1 (D24, D25, M14).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MASQUÉES PAR DÉFAUT, DONNÉES QUAND ON LES DEMANDE
 *
 * Les sources d'une réponse sur les données du compte ne sont pas affichées
 * (ni liste, ni bouton « Voir les sources » : comportement conservé). Elles
 * restent enregistrées avec chaque réponse (`verebona_message_sources`, et
 * leur lien avec chaque affirmation). Quand l'utilisateur demande l'origine
 * (« D'où vient ce chiffre ? », « Quelle est la source ? », « Montre le
 * justificatif »), l'Assistant présente les éléments du compte sur lesquels
 * s'appuie SA RÉPONSE PRÉCÉDENTE dans ce fil :
 *   · ceux que ses affirmations citent (à défaut, ceux de la réponse) ;
 *   · relus dans l'enregistrement de cette réponse — rien n'est recherché à
 *     nouveau, aucun modèle n'est appelé, aucun autre document « ressemblant »
 *     ne peut apparaître ;
 *   · revérifiés : un élément supprimé ou devenu inaccessible est annoncé
 *     sans lien ; liens construits par le serveur vers la fiche ou le document.
 * Cloisonnement : fil de l'utilisateur, dans son compte (en Duo, jamais les
 * réponses faites à l'autre membre).
 *
 * Ils sont présentés par les cartes existantes (`result_groups_json`) :
 * enregistrées, rejouées et relues dans l'historique comme toute carte.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { plain } from './routing-text';
import { hrefSource } from './entity-ref';
import { buildResultGroups, type ResultGroup } from './result-groups';
import { CARTE_INDISPONIBLE, identifiantsIndisponibles } from './source-availability.service';
import type { RetrievedSource, SourceType } from '../types/sources';

// ── Reconnaissance (pure) ───────────────────────────────────────────────────

const CE_QUI_PRECEDE = String.raw`(?:ca|cela|ce chiffre|ce montant|ce total|ce prix|ce resultat|ce cout|cette information|cette info|cette date|cette reponse|cette valeur|cette somme|cette donnee|ces chiffres|ces montants|ces informations|ces infos|ces dates|ces donnees|l'information|l'info|le chiffre|le montant|la date|la reponse)`;
const SOURCE_PATTERNS: RegExp[] = [
  // « D'où vient ce chiffre ? », « D'où ça vient ? », « D'où provient cette date ? », « D'où sort ce montant ? »
  new RegExp(String.raw`^d'ou (?:vient|viennent|provient|proviennent|sort|sortent|tires?[- ]tu|tirez[- ]vous|tiens[- ]tu|tenez[- ]vous) ${CE_QUI_PRECEDE}$`),
  new RegExp(String.raw`^d'ou ${CE_QUI_PRECEDE} (?:vient|viennent|provient|proviennent|sort|sortent)(?:[- ](?:il|elle|ils|elles))?$`),
  /^d'ou (?:le |la |les )?(?:sais|tiens|sors|tires)[- ]tu(?: (?:ca|cela))?$/,
  // « Quelle est la source ? », « Quelles sont tes sources ? », « Source ? », « Tes sources ? »
  /^(?:quelle est|quelles sont|c'est quoi|donne[- ]moi|indique[- ]moi|cite) (?:la|les|ta|tes|vos|votre) sources?(?: de (?:ca|cela|cette information|cette reponse|ce chiffre|ce montant))?$/,
  /^(?:(?:la|les|ta|tes|vos|votre) )?sources?$/,
  // « Sur quel document te bases-tu ? », « Sur quoi vous basez-vous ? », « Sur quoi t'appuies-tu ? »
  /^sur (?:quoi|quels? (?:documents?|elements?|justificatifs?)|quelles? (?:pieces?|sources?|preuves?)) (?:te bases[- ]tu|vous basez[- ]vous|t'appuies[- ]tu|vous appuyez[- ]vous|tu te bases|tu t'appuies)$/,
  // « Comment le sais-tu ? »
  /^comment (?:le |la |les )?(?:sais[- ]tu|savez[- ]vous)(?: (?:ca|cela))?$/,
  // « Montre(-moi) la source », « Montre le justificatif », « Montre la preuve », « Montre la facture » (seule : celle de la réponse)
  /^(?:montre|montrez|affiche|affichez|donne|donnez)(?:[- ](?:moi|nous))? (?:la|les|ta|tes) sources?$/,
  /^(?:montre|montrez|affiche|affichez)(?:[- ](?:moi|nous))? (?:le|les|la|ce|cette|ces) (?:justificatifs?|preuves?|factures?|documents?|pieces?)(?: (?:correspondante?s?|en question|concernee?s?|associee?s?))?$/,
];

/**
 * Le message demande-t-il l'ORIGINE de la réponse précédente (pure, testée) ? Volontairement étroit : la phrase
 * entière doit être une demande de provenance. « Montre la facture EDF » ou « D'où vient ma voiture ? » sont
 * d'autres demandes : elles suivent le parcours normal.
 */
export function isSourceRequest(message: string): boolean {
  const m = plain(message)
    .replace(/[?!.…]+/g, ' ')
    .replace(/\b(?:s'il te plait|s'il vous plait|stp|svp|merci)\b/g, ' ')
    .replace(/^\s*(?:et|mais|ok|d'accord|ah|oh|dis[- ]moi|dites[- ]moi|peux[- ]tu me dire|pouvez[- ]vous me dire)\b[\s,]*/g, '')
    .replace(/[\s,;:]+/g, ' ')
    .trim();
  return m.length > 0 && m.length <= 80 && SOURCE_PATTERNS.some((p) => p.test(m));
}

// ── Lecture et réponse ──────────────────────────────────────────────────────

/** Source enregistrée avec une réponse (`verebona_message_sources`). */
export interface StoredAnswerSource {
  sourceType: string;
  sourceId: string;
  title: string | null;
  excerpt: string | null;
  linkedAssetLabel: string | null;
  usefulDate: string | null;
  statusLabel: string | null;
  /** Citée par au moins une affirmation de la réponse. */
  cited: boolean;
}

/** Réponse précédente du fil et ses sources enregistrées ; `null` : aucune réponse précédente dans ce fil. */
export interface PreviousAnswerSources {
  messageId: number;
  sources: StoredAnswerSource[];
}

export interface SourceDisclosureDeps {
  /** Sources de la DERNIÈRE réponse de l'Assistant dans ce fil (fil de l'utilisateur, dans son compte). */
  loadPreviousAnswerSources(accountId: number, userId: number, conversationId: number): Promise<PreviousAnswerSources | null>;
  /** Identifiants d'éléments qui n'existent plus ou ne sont plus accessibles dans le compte. */
  unavailableIds(ids: string[], accountId: number): Promise<Set<string>>;
}

export interface SourceDisclosure {
  message: string;
  resultGroups: ResultGroup[];
  /** Nombre d'éléments présentés (trace). */
  count: number;
}

/** Sources du compte au plus présentées en une fois (les premières, par ordre de pertinence enregistré). */
export const MAX_DISCLOSED_SOURCES = 5;

/** Types de sources qui ne sont pas des éléments du compte (article d'aide : son lien figure déjà sous la réponse ; règle d'offre). */
const HORS_COMPTE: ReadonlySet<string> = new Set(['help_entry', 'product_rule']);

export const NO_SOURCE_MESSAGE = 'Je n’ai pas de source à vous montrer pour la réponse précédente.';

/** Phrase d'accompagnement (pure). */
export function disclosureMessage(count: number, plus: number): string {
  const base = count === 1
    ? 'Voici l’élément de votre compte sur lequel s’appuie la réponse précédente.'
    : `Voici les ${count} éléments de votre compte sur lesquels s’appuie la réponse précédente.`;
  return plus > 0 ? `${base} ${plus === 1 ? 'Un autre élément a également été consulté.' : `${plus} autres éléments ont également été consultés.`}` : base;
}

/**
 * Sources de la réponse précédente, à présenter (pure sauf `deps`) : `null` si le fil n'a aucune réponse précédente
 * (la demande suit alors le parcours normal).
 */
export async function discloseSources(
  p: { accountId: number; userId: number; conversationId: number },
  deps: SourceDisclosureDeps,
): Promise<SourceDisclosure | null> {
  const prev = await deps.loadPreviousAnswerSources(p.accountId, p.userId, p.conversationId);
  if (!prev) return null;
  const duCompte = prev.sources.filter((s) => s.sourceId && !HORS_COMPTE.has(s.sourceType));
  // « La source justifiant le fait précis » : celles que les affirmations citent ; à défaut, celles de la réponse.
  const citees = duCompte.filter((s) => s.cited);
  const retenues = (citees.length ? citees : duCompte);
  // Un même élément (deux champs d'une même fiche, deux extraits d'un même document) n'est présenté qu'une fois.
  const uniques = retenues.filter((s, i) => retenues.findIndex((x) => x.sourceId === s.sourceId) === i);
  if (uniques.length === 0) return { message: NO_SOURCE_MESSAGE, resultGroups: [], count: 0 };

  const presentees = uniques.slice(0, MAX_DISCLOSED_SOURCES);
  const morts = await deps.unavailableIds(presentees.map((s) => s.sourceId), p.accountId).catch(() => new Set<string>());
  const candidats: RetrievedSource[] = presentees.map((s, i) => ({
    id: s.sourceId,
    type: s.sourceType as SourceType,
    title: s.title?.trim() || 'Élément de votre compte',
    content: s.excerpt ?? '',
    meta: { assetName: s.linkedAssetLabel, date: s.usefulDate, statusLabel: s.statusLabel },
    // Ordre enregistré conservé (les groupes sont classés par leur meilleur score).
    relevanceScore: 1 - i / 100,
  }));
  const groupes = buildResultGroups(candidats).map((g) => ({
    ...g,
    // Élément supprimé ou devenu inaccessible depuis la réponse : annoncé, sans lien.
    items: g.items.map((c) => (morts.has(c.id) ? { ...c, href: null, status: CARTE_INDISPONIBLE } : { ...c, href: c.href ?? hrefSource(c.id) })),
  }));
  const n = groupes.reduce((t, g) => t + g.items.length, 0);
  if (n === 0) return { message: NO_SOURCE_MESSAGE, resultGroups: [], count: 0 };
  return { message: disclosureMessage(n, uniques.length - presentees.length), resultGroups: groupes, count: n };
}

// ── Accès de production ─────────────────────────────────────────────────────

/** Lecture réelle : dernière réponse de l'Assistant dans le fil de l'utilisateur, avec ses sources enregistrées. */
export async function sqlSourceDisclosureDeps(): Promise<SourceDisclosureDeps> {
  const { pgClient } = await import('@/db');
  return {
    async loadPreviousAnswerSources(accountId, userId, conversationId) {
      const dernier = (await pgClient.unsafe(
        `SELECT m.id
           FROM verebona_messages m
           JOIN verebona_conversations c ON c.id = m.conversation_id
          WHERE c.id = $3 AND c.account_id = $1 AND c.user_id = $2 AND c.status = 'active' AND c.expires_at > now()
            AND m.account_id = $1 AND m.role = 'assistant' AND m.expires_at > now()
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT 1`,
        [accountId, userId, conversationId] as never[],
      )) as unknown as Array<{ id: number }>;
      if (!dernier[0]) return null;
      const rows = (await pgClient.unsafe(
        `SELECT s.source_type, s.source_id, s.title_snapshot, s.excerpt_snapshot, s.linked_asset_label, s.useful_date, s.status_label,
                EXISTS (SELECT 1 FROM verebona_claim_sources cs WHERE cs.message_source_id = s.id) AS cited
           FROM verebona_message_sources s
          WHERE s.message_id = $1
          ORDER BY s.rank ASC NULLS LAST, s.id ASC
          LIMIT 50`,
        [dernier[0].id] as never[],
      )) as unknown as Array<Record<string, unknown>>;
      const txt = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
      return {
        messageId: Number(dernier[0].id),
        sources: rows.map((r) => ({
          sourceType: String(r.source_type ?? ''), sourceId: String(r.source_id ?? ''),
          title: txt(r.title_snapshot), excerpt: txt(r.excerpt_snapshot), linkedAssetLabel: txt(r.linked_asset_label),
          usefulDate: txt(r.useful_date), statusLabel: txt(r.status_label), cited: r.cited === true,
        })),
      };
    },
    unavailableIds: (ids, accountId) => identifiantsIndisponibles(ids, accountId),
  };
}
