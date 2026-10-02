/**
 * Cibles de la demande — `ResolvedTarget`, CDC 15 T2-08, T2-17, T2-19 à T2-21
 * (lot 15).
 *
 * Une question vise un OBJET avant de viser des mots : le document ouvert à
 * l'écran (« quel est le montant ? »), l'élément cité dans le fil (« et sa
 * date ? »), le bien choisi dans une clarification, le bien nommé dans la
 * question. Ce module rassemble ces cibles en un seul objet, dans un ordre de
 * priorité fixe, pour que la recherche, les lectures ciblées et les
 * planificateurs de synthèse travaillent sur LA MÊME cible :
 *
 *   1. clarification (choix explicite de l'utilisateur) ;
 *   2. référence du fil (« le deuxième », « ce document », « sa date ») ;
 *   3. bien nommé dans la question (vérifié dans le compte) ;
 *   4. contexte de page (document, bien, fournisseur ouverts) ;
 *   5. indices du classifieur (`entityHints`) — SIMPLES INDICES : un nom,
 *      jamais un identifiant ; il n'est retenu qu'après correspondance
 *      unique dans le compte (T2-08).
 *
 * Aucune cible ne donne de droit : l'identifiant vient du serveur (page
 * assainie, fil du même utilisateur, table du compte) et chaque lecture reste
 * bornée au compte.
 */
import { pgClient } from '@/db';
import type { AssistantRequestInput, IntentRoute } from '../types/contracts';
import { extractSearchTerms, normalizeWord, DOCUMENT_TYPE_STEMS, stemFr } from './query-terms';
import { analyserPeriode, aujourdhuiParis } from './query-period';

export type TargetOrigin = 'clarification' | 'thread' | 'message' | 'page' | 'hint';

export type ResolvedTarget =
  | { type: 'asset'; id: number; origin: TargetOrigin; label?: string | null }
  | { type: 'document'; id: number; origin: TargetOrigin; label?: string | null }
  | { type: 'agenda_item'; id: number; origin: TargetOrigin; label?: string | null }
  | { type: 'supplier'; id: number | null; name?: string | null; origin: TargetOrigin };

/** Indices textuels (jamais des identifiants) — T2-08. */
export interface TargetHints {
  assetNames: string[];
  documentTitles: string[];
  supplierNames: string[];
  /** Période désignée par un indice, si la question n'en porte pas. */
  period: { from: string; to: string } | null;
}

export interface AssistantTargets {
  /** Cible la plus prioritaire (objet visé par une question de suivi). */
  primary: ResolvedTarget | null;
  asset: Extract<ResolvedTarget, { type: 'asset' }> | null;
  document: Extract<ResolvedTarget, { type: 'document' }> | null;
  agendaItem: Extract<ResolvedTarget, { type: 'agenda_item' }> | null;
  supplier: Extract<ResolvedTarget, { type: 'supplier' }> | null;
  /** Biens nommés dans la question (plusieurs : comparaison, pas de filtre unique). */
  namedAssets: Array<{ id: number; name: string }>;
  hints: TargetHints;
}

const RANG: Record<TargetOrigin, number> = { clarification: 0, thread: 1, message: 2, page: 3, hint: 4 };

const entier = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Mots génériques d'indice : une famille d'objets, jamais un nom. */
const INDICES_GENERIQUES = new Set([
  'echeance', 'echeances', 'rappel', 'rappels', 'rendez-vous', 'agenda', 'evenement', 'evenements',
  'fournisseur', 'fournisseurs', 'artisan', 'artisans', 'prestataire', 'prestataires',
]);

/** Un indice porte-t-il un NOM (et non une famille ou un type) ? */
function estUnNom(value: string): boolean {
  if (value.startsWith('page:')) return false;
  const termes = extractSearchTerms(value).filter((t) => !INDICES_GENERIQUES.has(t)
    && !DOCUMENT_TYPE_STEMS.has(t) && !DOCUMENT_TYPE_STEMS.has(stemFr(t)) && !['document', 'documents', 'fichier', 'fichiers'].includes(t));
  return termes.length > 0;
}

/**
 * Cibles connues SANS lecture (pure, testée) : clarification, fil, page,
 * indices. Les biens nommés dans la question sont ajoutés par
 * `resolveAssistantTargets` (lecture des noms du compte).
 */
export function targetsFromInput(
  input: Pick<AssistantRequestInput, 'resume' | 'reference' | 'pageContext'>,
  route?: Pick<IntentRoute, 'entityHints'> | null,
  today: string = aujourdhuiParis(),
): AssistantTargets {
  const t: AssistantTargets = {
    primary: null, asset: null, document: null, agendaItem: null, supplier: null, namedAssets: [],
    hints: { assetNames: [], documentTitles: [], supplierNames: [], period: null },
  };
  const pose = (c: ResolvedTarget) => {
    const slot = c.type === 'asset' ? 'asset' : c.type === 'document' ? 'document' : c.type === 'agenda_item' ? 'agendaItem' : 'supplier';
    const cur = t[slot] as ResolvedTarget | null;
    if (!cur || RANG[c.origin] < RANG[cur.origin]) (t as unknown as Record<string, ResolvedTarget>)[slot] = c;
    if (!t.primary || RANG[c.origin] < RANG[t.primary.origin]) t.primary = c;
  };

  // 1. Clarification : le choix fait foi.
  const r = input.resume;
  if (r?.documentId) pose({ type: 'document', id: r.documentId, origin: 'clarification', label: r.choiceLabel ?? null });
  if (r?.assetId) pose({ type: 'asset', id: r.assetId, origin: 'clarification', label: r.choiceLabel ?? null });

  // 2. Référence du fil.
  const ref = input.reference;
  if (ref && ref.method !== 'clarification') {
    if (ref.type === 'asset') pose({ type: 'asset', id: ref.id, origin: 'thread', label: ref.label ?? null });
    if (ref.type === 'document') pose({ type: 'document', id: ref.id, origin: 'thread', label: ref.label ?? null });
    if (ref.type === 'agenda_item') pose({ type: 'agenda_item', id: ref.id, origin: 'thread', label: ref.label ?? null });
  }

  // 4. Page : document, bien, fournisseur ouverts.
  const p = input.pageContext;
  const pageDoc = entier(p?.documentId);
  const pageAsset = entier(p?.assetId);
  const pageSupplier = entier(p?.supplierId);
  if (pageDoc) pose({ type: 'document', id: pageDoc, origin: 'page' });
  if (pageAsset) pose({ type: 'asset', id: pageAsset, origin: 'page' });
  if (pageSupplier) pose({ type: 'supplier', id: pageSupplier, origin: 'page' });

  // 5. Indices : noms seulement.
  for (const h of route?.entityHints ?? []) {
    const v = String(h.value ?? '').trim();
    if (!v || v.length > 120) continue;
    const kind = (h as { type: string }).type;
    if (kind === 'period') {
      const per = analyserPeriode(v, today);
      if (per?.kind === 'resolved' && !t.hints.period) t.hints.period = { from: per.from, to: per.to };
      continue;
    }
    if (!estUnNom(v)) continue;
    const liste = kind === 'asset' ? t.hints.assetNames : kind === 'document' ? t.hints.documentTitles
      : kind === 'supplier' ? t.hints.supplierNames : null;
    if (liste && !liste.includes(v)) liste.push(v);
  }
  return t;
}

/** Biens du compte (noms), bornés. */
async function nomsDesBiens(accountId: number): Promise<Array<{ id: number; name: string }>> {
  const rows = (await pgClient.unsafe(
    `SELECT id, name FROM assets WHERE account_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 500`,
    [accountId] as never[],
  )) as unknown as Array<{ id: number; name: string | null }>;
  return rows.filter((r) => r.name).map((r) => ({ id: Number(r.id), name: String(r.name) }));
}

const motsDe = (s: string) => normalizeWord(s).replace(/['’]/g, ' ').split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Biens NOMMÉS dans un texte (pure, testée) : tous les mots significatifs du
 * nom (≥ 2 caractères, hors mots outils et familles) sont présents, dans le
 * texte, comme mots entiers (un chiffre compte). « la Clio » → Clio ; « ma maison » ne nomme
 * aucun bien (famille). Deux biens de même nom sont rendus tous les deux.
 */
export function assetsNamedIn(text: string, assets: Array<{ id: number; name: string }>): Array<{ id: number; name: string }> {
  const mots = new Set(motsDe(text));
  const out: Array<{ id: number; name: string }> = [];
  for (const a of assets) {
    // Un chiffre compte (« Clio 4 » ≠ « Clio ») : extractSearchTerms le garde.
    const cles = extractSearchTerms(a.name);
    if (cles.length === 0) continue;
    if (cles.every((w) => mots.has(w))) out.push(a);
  }
  // Un nom contenu dans un autre (« Clio » / « Clio 4 ») : le plus précis gagne.
  return out.filter((a) => !out.some((b) => b !== a && b.name.length > a.name.length
    && extractSearchTerms(a.name).every((w) => extractSearchTerms(b.name).includes(w))));
}

/**
 * Cibles de la demande, lues dans le compte : cibles immédiates, puis biens
 * nommés dans la question, puis indices du classifieur ramenés à un bien
 * UNIQUE du compte. Ne lève jamais : une lecture impossible laisse les
 * cibles immédiates.
 */
export async function resolveAssistantTargets(
  input: Pick<AssistantRequestInput, 'accountId' | 'message' | 'resume' | 'reference' | 'pageContext'>,
  route?: Pick<IntentRoute, 'entityHints'> | null,
  loadAssets: (accountId: number) => Promise<Array<{ id: number; name: string }>> = nomsDesBiens,
): Promise<AssistantTargets> {
  const t = targetsFromInput(input, route);
  const biens = await loadAssets(input.accountId).catch(() => [] as Array<{ id: number; name: string }>);
  if (biens.length === 0) return t;
  const nommes = assetsNamedIn(input.message ?? '', biens);
  t.namedAssets = nommes;
  if (nommes.length === 1 && (!t.asset || RANG[t.asset.origin] > RANG.message)) {
    t.asset = { type: 'asset', id: nommes[0].id, origin: 'message', label: nommes[0].name };
    if (!t.primary || RANG[t.primary.origin] > RANG.message) t.primary = t.asset;
  }
  if (!t.asset && nommes.length === 0 && t.hints.assetNames.length) {
    const parIndice = [...new Map(t.hints.assetNames.flatMap((h) => assetsNamedIn(h, biens)).map((a) => [a.id, a])).values()];
    if (parIndice.length === 1) {
      t.asset = { type: 'asset', id: parIndice[0].id, origin: 'hint', label: parIndice[0].name };
      if (!t.primary) t.primary = t.asset;
    }
  }
  return t;
}
