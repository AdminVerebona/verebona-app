/**
 * Planificateurs de synthèse — `buildSynthesisContext()`, CDC 15 T2-10,
 * T2-33, T2-34 (lot 15, ASSISTANT_CANONICAL_READ=enabled).
 *
 * ACCOUNT_SUMMARY, ACCOUNT_COMPARISON et ACCOUNT_TIMELINE passaient par la
 * recherche générique : titre, type et date de quelques objets, au hasard des
 * mots de la question. « Résume les garanties » pouvait n'avoir aucun contenu
 * de garantie ; « compare la Clio et la Polo » mélangeait les deux ; une
 * chronologie s'arrêtait à 8 sources.
 *
 * Trois planificateurs dédiés, SANS modèle, qui assemblent un contexte
 * structuré à partir de la couche canonique de X :
 *
 *   · summary     état canonique du ou des biens visés, documents du type
 *                 demandé avec leur contenu riche (faits T1, extrait borné —
 *                 `buildSynthesisContent`, T2-11), échéances à venir,
 *                 éléments « À traiter » ;
 *   · comparison  les MÊMES dimensions (champs canoniques) pour chaque bien,
 *                 puis les documents de chacun, à budget égal — jamais un
 *                 document d'un bien attribué à l'autre ;
 *   · timeline    un objet chronologique COMPACT (événements datés : achat,
 *                 échéances et faits de l'agenda, documents), dont le NOMBRE
 *                 D'ÉVÉNEMENTS (`timelineMaxEvents`) est distinct du BUDGET
 *                 DE SOURCES (`maxSources`, ≤ 8) : les événements sont
 *                 regroupés en quelques sources compactes, chaque ligne gardant
 *                 la référence de son objet d'origine.
 *
 * Tout est borné au compte et budgété ; une lecture en échec retire sa part
 * du contexte, jamais la réponse.
 */
import { pgClient } from '@/db';
import type { IntentRoute, AssistantRequestInput, AssistantTimelineEvent } from '../types/contracts';
import { hrefSource, parseEntityRef } from './entity-ref';
import type { RetrievedSource } from '../types/sources';
import { getAssistantConfig } from '../config/assistant-config';
import { resolveAssistantTargets, type AssistantTargets } from './assistant-targets';
import { documentTypeStems, tokenizeQuery } from './query-terms';
import { documentTypeCodesFor } from '../registries/retrieval-adapters';
import { formatDateFr } from './deterministic-format';

export type SynthesisKind = 'summary' | 'comparison' | 'timeline';

export interface TimelineEvent {
  date: string;
  label: string;
  kind: 'acquisition' | 'agenda' | 'document';
  /** Objet d'origine (« agenda_12 », « doc_4 », « asset_field:3:acquisitionDate »). */
  ref: string;
  assetName: string | null;
  /** Agenda : HISTORICAL / DEADLINE ; statut lisible. */
  detail: string | null;
}

export interface SynthesisPlan {
  kind: SynthesisKind;
  /** Sources transmises au modèle et affichées — ≤ budget de sources. */
  sources: RetrievedSource[];
  /** Biens couverts, dans l'ordre de la question. */
  assets: Array<{ id: number; name: string }>;
  /** Chronologie compacte (timeline seulement). */
  timeline?: { events: TimelineEvent[]; totalEvents: number; truncated: boolean };
  /** Budgets appliqués (trace). */
  budget: { sources: number; events?: number };
  /**
   * Comparaison (R7) : plus de 3 biens correspondent — question posée à
   * l'utilisateur, aucune source (le planificateur ne choisit pas).
   */
  clarification?: { reason: 'COMPARISON_TOO_MANY_ASSETS'; question: string; candidates: Array<{ id: number; name: string }> };
}

/**
 * Budget d'événements d'une chronologie (T2-34), distinct du budget de
 * sources : `assistant-config` (`VEREBONA_ASSISTANT_TIMELINE_MAX_EVENTS`,
 * défaut 60, borné à 1…200).
 */
export function timelineMaxEvents(): number {
  return getAssistantConfig().timelineMaxEvents;
}

/* ── Dépendances (injectables pour les tests) ─────────────────────────── */

export interface AssetSnapshot {
  id: number;
  name: string;
  family: string | null;
  /** Champs canoniques lisibles et non sensibles : clé → [libellé, valeur affichée]. */
  fields: Record<string, { label: string; display: string }>;
  /** Tous les champs lisibles applicables à la famille (dimensions possibles). */
  applicable: Record<string, string>;
}

export interface SynthesisDeps {
  targets(input: AssistantRequestInput, route: IntentRoute): Promise<AssistantTargets>;
  documentContent(accountId: number, opts: { fileIds?: number[]; assetIds?: number[]; terms?: string[]; maxDocuments?: number }): Promise<RetrievedSource[]>;
  findDocuments(accountId: number, opts: { assetIds: number[]; codes: string[]; typeWords: string[]; terms: string[]; limit: number }): Promise<number[]>;
  assetSnapshot(accountId: number, assetId: number): Promise<AssetSnapshot | null>;
  upcoming(accountId: number, assetIds: number[]): Promise<Array<{ id: number; title: string; date: string; forecast: boolean; assetNames: string[] }>>;
  toProcess(accountId: number, assetIds: number[]): Promise<Array<{ id: number; question: string; priority: string }>>;
  timelineRows(accountId: number, assetIds: number[], limit: number): Promise<TimelineEvent[]>;
  accountAssets(accountId: number, limit: number): Promise<Array<{ id: number; name: string; category?: string | null }>>;
}

/* ── Sources compactes ─────────────────────────────────────────────────── */

const borne = (lignes: string[], max = 1500) => {
  const out: string[] = [];
  let n = 0;
  for (const l of lignes) {
    if (n + l.length + 1 > max) break;
    out.push(l);
    n += l.length + 1;
  }
  return out.join('\n');
};

/** Source d'état canonique d'un bien, sur des dimensions données (pure). */
export function assetStateSource(a: AssetSnapshot, dimensions?: string[]): RetrievedSource {
  const cles = dimensions ?? Object.keys(a.fields);
  const lignes = cles.map((k) => {
    const f = a.fields[k];
    const label = f?.label ?? a.applicable[k] ?? k;
    return `${label} : ${f ? f.display : a.applicable[k] ? 'non renseigné' : 'sans objet pour ce bien'}`;
  });
  return {
    id: `asset_${a.id}`, type: 'asset_field', title: a.name,
    content: borne([`Fiche de ${a.name}${a.family ? ` (${a.family.toLowerCase()})` : ''}`, ...lignes]),
    relevanceScore: 1, meta: { assetId: a.id, subtitle: 'État de la fiche' },
  };
}

/**
 * Dimensions communes d'une comparaison (pure, testée) : les champs
 * renseignés sur AU MOINS un des biens, dans l'ordre du premier, bornés.
 */
export function comparisonDimensions(snaps: AssetSnapshot[], max = 14): string[] {
  const out: string[] = [];
  for (const s of snaps) for (const k of Object.keys(s.fields)) if (!out.includes(k)) out.push(k);
  return out.slice(0, max);
}

/** Événements regroupés en sources compactes (pure, testée) — T2-34. */
export function timelineSources(events: TimelineEvent[], scope: string, maxSources: number): RetrievedSource[] {
  const lignes = events.map((e) =>
    `${e.date} · ${e.label}${e.assetName ? ` (${e.assetName})` : ''}${e.detail ? ` — ${e.detail}` : ''} [${e.ref}]`);
  const paquets: string[][] = [];
  let cur: string[] = [];
  let n = 0;
  for (const l of lignes) {
    if (cur.length && n + l.length + 1 > 1400) { paquets.push(cur); cur = []; n = 0; }
    cur.push(l);
    n += l.length + 1;
  }
  if (cur.length) paquets.push(cur);
  const garde = paquets.slice(-Math.max(1, maxSources));
  return garde.map((p, i) => ({
    id: `timeline:${scope}:${i + 1}`, type: 'agenda_item' as const,
    title: garde.length > 1 ? `Chronologie (${i + 1}/${garde.length})` : 'Chronologie',
    content: p.join('\n'), relevanceScore: 1,
    meta: { timeline: true, events: p.length, from: p[0]?.slice(0, 10) ?? null, to: p[p.length - 1]?.slice(0, 10) ?? null },
  }));
}

/** Réponse chronologique SANS modèle (pure, testée) : repli de la timeline. */
export function timelineAnswer(plan: SynthesisPlan, max = 15): string {
  const ev = plan.timeline?.events ?? [];
  if (ev.length === 0) return 'Je n’ai trouvé aucun événement daté pour établir une chronologie.';
  const pour = plan.assets.length === 1 ? ` de ${plan.assets[0].name}` : '';
  const affiches = ev.slice(-max);
  const lignes = affiches.map((e) => `${formatDateFr(e.date)} : ${e.label}${e.assetName && plan.assets.length !== 1 ? ` (${e.assetName})` : ''}${e.detail ? ` — ${e.detail}` : ''}`);
  const reste = (plan.timeline?.totalEvents ?? ev.length) - affiches.length;
  return `Chronologie${pour} :\n${lignes.map((l) => `• ${l}`).join('\n')}${reste > 0 ? `\n(${reste} événement${reste > 1 ? 's' : ''} plus ancien${reste > 1 ? 's' : ''} non affiché${reste > 1 ? 's' : ''}.)` : ''}`;
}

/* ── Biens d'une comparaison (R7) ─────────────────────────────────────── */

/** Famille désignée au pluriel ou par un possessif (« mes voitures », « nos deux maisons »). */
const FAMILLES: Array<[RegExp, string[]]> = [
  [/\b(mes|nos|les|ces|deux|trois|quatre)\s+(\w+\s+)?(voitures?|vehicules?|autos?|motos?|camionnettes?|scooters?)\b/, ['VEHICULE']],
  [/\b(mes|nos|les|ces|deux|trois|quatre)\s+(\w+\s+)?(maisons?|appartements?|logements?|biens immobiliers|immeubles?|studios?)\b/, ['IMMOBILIER']],
  [/\b(mes|nos|les|ces|deux|trois|quatre)\s+(\w+\s+)?(objets?)\b/, ['OBJECT', 'OBJET']],
];

/** Famille visée par la question (pure, testée), ou null. */
export function familleComparee(message: string): string[] | null {
  const m = message.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  for (const [re, familles] of FAMILLES) if (re.test(m)) return familles;
  return null;
}

/** Noms cités au plus dans une question de clarification (relecture lot 19). */
export const CLARIFICATION_MAX_NAMES = 8;

/** « A, B, …, H et N autres » : liste bornée à `CLARIFICATION_MAX_NAMES` noms (pure). */
export function listeBornee(noms: readonly string[], max = CLARIFICATION_MAX_NAMES): string {
  if (noms.length <= max) return noms.join(', ');
  const reste = noms.length - max;
  return `${noms.slice(0, max).join(', ')} et ${reste} ${reste > 1 ? 'autres' : 'autre'}`;
}

/** Au-delà, la comparaison demande à l'utilisateur de choisir. */
export const COMPARISON_MAX_ASSETS = 3;

/**
 * Biens à comparer (R7, pure hors lecture des biens) :
 *   1. les biens NOMMÉS dans la question ;
 *   2. complétés par le bien de la PAGE puis celui du FIL (« compare-la avec
 *      la Polo » sur la fiche de la Clio) ;
 *   3. sinon, la FAMILLE désignée (« mes voitures ») : les biens du compte de
 *      cette catégorie.
 * Plus de 3 biens → clarification (aucun choix arbitraire) ; moins de 2 →
 * comportement antérieur (pas de planificateur).
 */
export async function biensAComparer(
  input: Pick<AssistantRequestInput, 'message' | 'pageContext' | 'reference'>,
  cibles: Pick<AssistantTargets, 'namedAssets'>,
  biensDuCompte: (limit: number) => Promise<Array<{ id: number; name: string; category?: string | null }>>,
): Promise<{ kind: 'assets'; assets: Array<{ id: number; name: string }> } | { kind: 'clarification'; candidates: Array<{ id: number; name: string }>; clarification: NonNullable<SynthesisPlan['clarification']> }> {
  const trop = (candidates: Array<{ id: number; name: string }>, quoi: string) => ({
    kind: 'clarification' as const, candidates,
    clarification: {
      reason: 'COMPARISON_TOO_MANY_ASSETS' as const, candidates,
      question: `${quoi} (${candidates.length}) : ${listeBornee(candidates.map((c) => c.name))}. Lesquels voulez-vous comparer ? Nommez-en deux ou trois.`,
    },
  });
  const nommes = cibles.namedAssets;
  if (nommes.length > COMPARISON_MAX_ASSETS) return trop(nommes, 'Plusieurs biens sont nommés');
  const out = [...nommes];
  const ajouter = (id: number | null, tous: Array<{ id: number; name: string }>) => {
    if (id == null || out.some((b) => b.id === id)) return;
    const b = tous.find((x) => x.id === id);
    if (b) out.push({ id: b.id, name: b.name });
  };
  if (out.length < 2) {
    const page = Number(input.pageContext?.assetId);
    const fil = input.reference?.type === 'asset' ? input.reference.id : null;
    const familles = familleComparee(input.message);
    if ((Number.isInteger(page) && page > 0) || fil != null || familles) {
      const tous = await biensDuCompte(500);
      ajouter(Number.isInteger(page) && page > 0 ? page : null, tous);
      if (out.length < 2) ajouter(fil, tous);
      if (out.length < 2 && familles) {
        const famille = tous.filter((b) => b.category && familles.includes(b.category));
        const reunis = [...out, ...famille.filter((b) => !out.some((o) => o.id === b.id)).map((b) => ({ id: b.id, name: b.name }))];
        if (reunis.length > COMPARISON_MAX_ASSETS) return trop(reunis, 'Plusieurs biens correspondent');
        return { kind: 'assets', assets: reunis };
      }
    }
  }
  return { kind: 'assets', assets: out.slice(0, COMPARISON_MAX_ASSETS) };
}

/* ── Planificateur ─────────────────────────────────────────────────────── */

const KIND: Record<string, SynthesisKind> = { ACCOUNT_SUMMARY: 'summary', ACCOUNT_COMPARISON: 'comparison', ACCOUNT_TIMELINE: 'timeline' };

/** Biens visés : nommés dans la question, sinon la cible (fil, page, indice). */
function biensVises(t: AssistantTargets): Array<{ id: number; name: string }> {
  if (t.namedAssets.length) return t.namedAssets;
  return t.asset ? [{ id: t.asset.id, name: t.asset.label ?? `Bien ${t.asset.id}` }] : [];
}

export async function buildSynthesisContext(
  route: IntentRoute,
  input: AssistantRequestInput,
  deps: SynthesisDeps = defaultDeps,
): Promise<SynthesisPlan | null> {
  const kind = KIND[route.intent];
  if (!kind) return null;
  const cfg = getAssistantConfig();
  const budget = Math.max(3, cfg.maxSources);
  const cibles = await deps.targets(input, route);
  const termes = tokenizeQuery(input.message);
  const types = documentTypeStems(termes);
  const codes = [...new Set(types.flatMap(documentTypeCodesFor))];
  const motsTexte = termes.filter((t) => !t.exact && !types.includes(t.stem)).map((t) => t.raw)
    .filter((w) => !['resume', 'resumer', 'synthese', 'compare', 'comparer', 'comparaison', 'chronologie', 'historique', 'fai', 'fais', 'etat', 'point'].includes(w));
  const safe = async <T>(p: Promise<T>, def: T): Promise<T> => p.catch((e) => {
    console.warn('[verebona] planificateur de synthèse :', (e as Error).message);
    return def;
  });

  // ── Comparaison ──────────────────────────────────────────────────────
  if (kind === 'comparison') {
    const choix = await biensAComparer(input, cibles, (n) => safe(deps.accountAssets(input.accountId, n), []));
    if (choix.kind === 'clarification') {
      return { kind, sources: [], assets: choix.candidates, budget: { sources: budget }, clarification: choix.clarification };
    }
    const biens = choix.assets;
    if (biens.length < 2) return null;
    const snaps = (await Promise.all(biens.map((b) => safe(deps.assetSnapshot(input.accountId, b.id), null))))
      .filter((s): s is AssetSnapshot => !!s);
    if (snaps.length < 2) return null;
    const dims = comparisonDimensions(snaps);
    const sources: RetrievedSource[] = snaps.map((s) => assetStateSource(s, dims));
    const parBien = Math.max(1, Math.floor((budget - sources.length) / snaps.length));
    for (const s of snaps) {
      const fileIds = codes.length || motsTexte.length
        ? await safe(deps.findDocuments(input.accountId, { assetIds: [s.id], codes, typeWords: types, terms: motsTexte, limit: parBien }), [])
        : undefined;
      if (fileIds && fileIds.length === 0) continue;
      const docs = await safe(deps.documentContent(input.accountId, { fileIds, assetIds: [s.id], terms: motsTexte, maxDocuments: parBien }), []);
      // Chaque document reste attribué à SON bien (jamais mélangé).
      sources.push(...docs.slice(0, parBien).map((d) => ({ ...d, meta: { ...d.meta, assetName: s.name, assetId: s.id } })));
    }
    return { kind, sources: sources.slice(0, budget), assets: snaps.map((s) => ({ id: s.id, name: s.name })), budget: { sources: budget } };
  }

  const vises = biensVises(cibles);
  const assetIds = vises.map((b) => b.id);

  // ── Chronologie ──────────────────────────────────────────────────────
  if (kind === 'timeline') {
    const maxEv = timelineMaxEvents();
    const perimetre = assetIds.length ? assetIds : (await safe(deps.accountAssets(input.accountId, 50), [])).map((a) => a.id);
    const rows = await safe(deps.timelineRows(input.accountId, perimetre, maxEv * 2), []);
    const vus = new Set<string>();
    const tous = rows
      .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date))
      .filter((e) => { const k = `${e.date}|${e.label.toLowerCase()}|${e.assetName ?? ''}`; if (vus.has(k)) return false; vus.add(k); return true; })
      .sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
    // Au-delà du budget d'événements : les plus récents sont gardés.
    const events = tous.slice(-maxEv);
    const scope = assetIds.length === 1 ? `asset_${assetIds[0]}` : assetIds.length ? `assets_${assetIds.join('_')}` : 'account';
    const sources = timelineSources(events, scope, budget);
    return {
      kind, sources, assets: vises,
      timeline: { events, totalEvents: tous.length, truncated: tous.length > events.length },
      budget: { sources: budget, events: maxEv },
    };
  }

  // ── Synthèse ─────────────────────────────────────────────────────────
  const sources: RetrievedSource[] = [];
  const snaps = (await Promise.all(vises.slice(0, 2).map((b) => safe(deps.assetSnapshot(input.accountId, b.id), null))))
    .filter((s): s is AssetSnapshot => !!s);
  sources.push(...snaps.map((s) => assetStateSource(s)));
  const [prochaines, aTraiter] = await Promise.all([
    safe(deps.upcoming(input.accountId, assetIds), []),
    safe(deps.toProcess(input.accountId, assetIds), []),
  ]);
  const scope = assetIds.length === 1 ? `asset_${assetIds[0]}` : 'account';
  const reserve = (prochaines.length ? 1 : 0) + (aTraiter.length ? 1 : 0);
  const nDocs = Math.max(1, budget - sources.length - reserve);
  const fileIds = await safe(deps.findDocuments(input.accountId, { assetIds, codes, typeWords: types, terms: motsTexte, limit: nDocs }), []);
  if (fileIds.length) sources.push(...await safe(deps.documentContent(input.accountId, { fileIds, terms: motsTexte, maxDocuments: nDocs }), []));
  if (prochaines.length) {
    sources.push({
      id: `upcoming_agenda:${scope}`, type: 'agenda_item', title: 'Échéances à venir',
      content: borne(prochaines.map((r) => `${r.date}${r.forecast ? ' (prévisionnelle)' : ''} · ${r.title}${r.assetNames.length ? ` (${r.assetNames.join(', ')})` : ''} [agenda_${r.id}]`)),
      relevanceScore: 0.9, meta: { count: prochaines.length },
    });
  }
  if (aTraiter.length) {
    sources.push({
      id: `to_process:${scope}`, type: 'to_process_item', title: '« À traiter »',
      content: borne(aTraiter.map((t) => `${t.question} [todo_${t.id}]`)),
      relevanceScore: 0.9, meta: { count: aTraiter.length },
    });
  }
  if (sources.length === 0) return null;
  return { kind, sources: sources.slice(0, budget), assets: vises, budget: { sources: budget } };
}

/* ── Implémentation par défaut (couche canonique de X, SQL borné au compte) ── */

const aujourdhui = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const DOCS_DES_BIENS = `(EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = f.account_id AND l.file_id = f.id
                           AND l.status = 'ACTIVE' AND l.asset_id = ANY($2::int[]))
         OR f.asset_id = ANY($2::int[]) OR f.linked_asset_id = ANY($2::int[]))`;

export const defaultDeps: SynthesisDeps = {
  targets: (input, route) => resolveAssistantTargets(input, route),

  documentContent: async (accountId, opts) => (await import('../canonical/synthesis-content')).buildSynthesisContent(accountId, opts),

  async findDocuments(accountId, { assetIds, codes, typeWords, terms, limit }) {
    const params: unknown[] = [accountId, assetIds.length ? assetIds : null];
    const conds = ['f.account_id = $1', 'f.deleted_at IS NULL', `($2::int[] IS NULL OR ${DOCS_DES_BIENS})`];
    if (codes.length || typeWords.length) {
      params.push(codes);
      const i = params.length;
      const mots = typeWords.map((w) => { params.push(`%${w}%`); return params.length; });
      conds.push(`(upper(coalesce(f.document_type_code, '')) = ANY($${i}::text[]) OR upper(coalesce(f.document_type, '')) = ANY($${i}::text[])
        ${mots.map((j) => `OR (f.document_type_code IS NULL AND unaccent(lower(coalesce(f.retained_title, f.original_filename, ''))) LIKE $${j})`).join(' ')})`);
    } else if (terms.length) {
      const parts = terms.slice(0, 6).map((t) => {
        params.push(`%${t}%`);
        return `unaccent(lower(coalesce(f.retained_title, '') || ' ' || coalesce(f.original_filename, '') || ' ' || coalesce(f.supplier, '') || ' ' || coalesce(f.description, ''))) LIKE unaccent($${params.length})`;
      });
      conds.push(`(${parts.join(' OR ')})`);
    }
    params.push(Math.min(Math.max(limit, 1), 20));
    const rows = (await pgClient.unsafe(
      `SELECT f.id FROM asset_files f WHERE ${conds.join(' AND ')}
        ORDER BY f.document_date DESC NULLS LAST, f.id DESC LIMIT $${params.length}`,
      params as never[],
    )) as unknown as Array<{ id: number }>;
    return rows.map((r) => Number(r.id));
  },

  async assetSnapshot(accountId, assetId) {
    const [{ getCanonicalAssetState }, reg, fr] = await Promise.all([
      import('@/services/canonical/asset-state'),
      import('@/services/canonical/registry'),
      import('../canonical/field-reader'),
    ]);
    const [state, rows] = await Promise.all([
      getCanonicalAssetState(assetId, accountId),
      pgClient.unsafe(`SELECT name FROM assets WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`, [assetId, accountId] as never[]) as unknown as Promise<Array<{ name: string }>>,
    ]);
    if (!state || state.accountId !== accountId || !rows[0]) return null;
    const applicable: Record<string, string> = {};
    const fields: AssetSnapshot['fields'] = {};
    for (const d of reg.listFields(state.family)) {
      if (!d.assistantReadable || d.sensitive) continue;
      applicable[d.key] = d.label;
      const v = state.fields[d.key]?.value;
      const display = v === undefined || v === null ? null : fr.formatCanonicalValue(d, v);
      if (display) fields[d.key] = { label: d.label, display };
    }
    return { id: assetId, name: rows[0].name, family: state.family ?? null, fields, applicable };
  },

  upcoming: async (accountId, assetIds) =>
    (await import('../canonical/agenda')).listUpcomingAgenda(accountId, { assetIds, windowDays: 365, limit: 8 }),

  async toProcess(accountId, assetIds) {
    const rows = (await pgClient.unsafe(
      `SELECT t.id, t.question, t.priority FROM to_process_actions t
        WHERE t.account_id = $1 AND t.resolved_at IS NULL
          AND ($2::int[] IS NULL
               OR (t.target_type = 'ASSET' AND t.target_id = ANY($2::int[]))
               OR (t.target_type = 'EQUIPMENT' AND EXISTS (SELECT 1 FROM equipments e WHERE e.id = t.target_id AND e.asset_id = ANY($2::int[])))
               OR (t.target_type = 'DOCUMENT' AND EXISTS (SELECT 1 FROM asset_files f WHERE f.id = t.target_id AND f.account_id = t.account_id
                     AND (f.asset_id = ANY($2::int[]) OR f.linked_asset_id = ANY($2::int[])
                          OR EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = f.account_id AND l.file_id = f.id
                                      AND l.status = 'ACTIVE' AND l.asset_id = ANY($2::int[])))))
               OR (t.target_type = 'AGENDA_ITEM' AND EXISTS (SELECT 1 FROM agenda_asset_links l WHERE l.agenda_item_id = t.target_id AND l.asset_id = ANY($2::int[]))))
        ORDER BY CASE t.priority WHEN 'DO_FIRST' THEN 0 WHEN 'DO_NEXT' THEN 1 ELSE 2 END, t.id LIMIT 8`,
      [accountId, assetIds.length ? assetIds : null] as never[],
    )) as unknown as Array<{ id: number; question: string; priority: string }>;
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  },

  async timelineRows(accountId, assetIds, limit) {
    if (assetIds.length === 0) return [];
    const [agenda, docs, achats] = await Promise.all([
      pgClient.unsafe(
        `SELECT i.id, i.title, to_char(i.start_date, 'YYYY-MM-DD') AS date, i.manual_status AS "manualStatus",
                i.origin_field_key AS "originFieldKey", min(a.name) AS "assetName"
           FROM agenda_items i
           JOIN agenda_asset_links l ON l.agenda_item_id = i.id AND l.asset_id = ANY($2::int[])
           JOIN assets a ON a.id = l.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
          WHERE i.account_id = $1 AND i.start_date IS NOT NULL AND coalesce(i.manual_status, '') <> 'annule'
          GROUP BY i.id ORDER BY i.start_date DESC LIMIT $3`,
        [accountId, assetIds, limit] as never[],
      ) as unknown as Promise<Array<{ id: number; title: string; date: string; manualStatus: string | null; originFieldKey: string | null; assetName: string | null }>>,
      pgClient.unsafe(
        `SELECT f.id, coalesce(f.retained_title, f.original_filename, 'Document') AS title, to_char(f.document_date, 'YYYY-MM-DD') AS date,
                (SELECT a.name FROM assets a WHERE a.id = coalesce(f.asset_id, f.linked_asset_id)) AS "assetName"
           FROM asset_files f
          WHERE f.account_id = $1 AND f.deleted_at IS NULL AND f.document_date IS NOT NULL AND ${DOCS_DES_BIENS}
          ORDER BY f.document_date DESC LIMIT $3`,
        [accountId, assetIds, limit] as never[],
      ) as unknown as Promise<Array<{ id: number; title: string; date: string; assetName: string | null }>>,
      (async () => {
        const { getCanonicalAssetState } = await import('@/services/canonical/asset-state');
        const noms = (await pgClient.unsafe(
          `SELECT id, name FROM assets WHERE account_id = $1 AND id = ANY($2::int[]) AND deleted_at IS NULL`,
          [accountId, assetIds.slice(0, 10)] as never[],
        )) as unknown as Array<{ id: number; name: string }>;
        return Promise.all(noms.map(async (n) => {
          const st = await getCanonicalAssetState(Number(n.id), accountId).catch(() => null);
          const v = st && st.accountId === accountId ? st.fields.acquisitionDate?.value : undefined;
          return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? { id: Number(n.id), name: n.name, date: v.slice(0, 10) } : null;
        }));
      })(),
    ]);
    const today = aujourdhui();
    const out: TimelineEvent[] = [];
    for (const a of achats) if (a) out.push({ date: a.date, label: 'Achat', kind: 'acquisition', ref: `asset_field:${a.id}:acquisitionDate`, assetName: a.name, detail: null });
    for (const i of agenda) {
      const statut = i.manualStatus === 'realise' ? 'réalisé' : i.date > today ? 'à venir' : null;
      out.push({ date: i.date, label: i.title, kind: 'agenda', ref: `agenda_${i.id}`, assetName: i.assetName, detail: statut });
    }
    for (const d of docs) out.push({ date: d.date, label: `Document « ${d.title} »`, kind: 'document', ref: `doc_${d.id}`, assetName: d.assetName, detail: null });
    return out;
  },

  async accountAssets(accountId, limit) {
    const rows = (await pgClient.unsafe(
      `SELECT id, name, category FROM assets WHERE account_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT $2`,
      [accountId, limit] as never[],
    )) as unknown as Array<{ id: number; name: string; category: string | null }>;
    return rows.map((r) => ({ id: Number(r.id), name: r.name, category: r.category ?? null }));
  },
};

/* ── Chronologie transmise au client (T2-35) ─────────────────────────────── */

const plainEv = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Objet d'origine d'un événement (pure, testée) : un identifiant d'objet
 * cité, sinon la ligne compacte de chronologie (`date · libellé [ref]`) de
 * même date dont le libellé correspond le mieux au texte de l'événement.
 * Jamais un identifiant qui ne figure pas dans les sources fournies.
 */
export function eventRef(ev: { date: string | null; text: string; sourceIds: string[] }, sources: RetrievedSource[]): string | null {
  const fournies = new Map(sources.map((s) => [s.id, s]));
  for (const id of ev.sourceIds) {
    if (!fournies.has(id)) continue;
    if (parseEntityRef(id)) return id;
  }
  const mots = new Set(plainEv(ev.text).split(' ').filter((w) => w.length >= 3));
  let meilleur: { ref: string; score: number } | null = null;
  for (const id of ev.sourceIds) {
    const src = fournies.get(id);
    if (!src || !id.startsWith('timeline:')) continue;
    for (const ligne of src.content.split('\n')) {
      const m = /^(\d{4}-\d{2}-\d{2}) · (.*) \[([^\]]+)\]$/.exec(ligne);
      if (!m || (ev.date && m[1] !== ev.date) || !parseEntityRef(m[3])) continue;
      const score = plainEv(m[2]).split(' ').filter((w) => mots.has(w)).length;
      if (!meilleur || score > meilleur.score) meilleur = { ref: m[3], score };
    }
  }
  return meilleur?.ref ?? null;
}

/** Événements générés → événements client, liens résolus côté serveur (pure). */
export function clientTimelineEvents(
  events: Array<{ date: string | null; text: string; sourceIds: string[] }>,
  sources: RetrievedSource[],
): AssistantTimelineEvent[] {
  return events.slice(0, 60).map((e) => {
    const ref = eventRef(e, sources);
    const meta = ref ? sources.find((s) => s.id === ref)?.meta ?? null : null;
    return { date: e.date, text: e.text, ref, href: ref ? hrefSource(ref, meta) : null };
  });
}

/** Chronologie planifiée (repli sans modèle) → événements client (pure). */
export function planTimelineEvents(plan: SynthesisPlan, max = 15): AssistantTimelineEvent[] {
  return (plan.timeline?.events ?? []).slice(-max).map((e) => ({
    date: e.date,
    text: `${e.label}${e.assetName && plan.assets.length !== 1 ? ` (${e.assetName})` : ''}${e.detail ? ` — ${e.detail}` : ''}`,
    ref: e.ref,
    href: hrefSource(e.ref, null),
  }));
}
