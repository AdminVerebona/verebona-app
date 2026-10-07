/**
 * Cibles de la demande — `ResolvedTarget`, CDC 15 T2-08, T2-17, T2-19 à T2-21
 * (lot 15) ; lot 29 : tickets 8a, 8b, 13, 14.
 *
 * Une question vise un OBJET avant de viser des mots : le document ouvert à
 * l'écran (« quel est le montant ? »), l'élément cité dans le fil (« et sa
 * date ? »), le bien choisi dans une clarification, le bien nommé dans la
 * question, « la maison » quand le compte n'en a qu'une, « la chaudière »
 * quand un seul équipement porte ce nom. Ce module rassemble ces cibles en un
 * seul objet, dans un ordre de priorité FIXE, pour que la recherche, les
 * lectures ciblées et les planificateurs de synthèse travaillent sur LA MÊME
 * cible :
 *
 *   1. clarification (choix explicite de l'utilisateur) ;
 *   2. référence du fil (« le deuxième », « ce document », « sa date ») ;
 *   3. désignation explicite dans la question : bien nommé, VIN ou
 *      immatriculation EXACTS, équipement / pièce nommé ;
 *   4. contexte de page (document, bien, fournisseur ouverts) ;
 *   5. catégorie / famille unique (« la maison », « ma voiture ») ;
 *   6. indices du classifieur (`entityHints`) — SIMPLES INDICES : un nom,
 *      jamais un identifiant ; retenus après correspondance UNIQUE dans le
 *      compte (T2-08).
 *
 * Une catégorie générique n'écrase jamais une cible plus précise (8a §E).
 * Un équipement ou une pièce reste un équipement ou une pièce (13 §A) : son
 * bien PARENT est conservé (accès, navigation, présentation) sans jamais le
 * remplacer ; le bien de la page FILTRE la recherche de l'enfant (13 §E).
 *
 * Disponibilité (ticket 14) : seuls les biens DISPONIBLES (non supprimés, ni
 * archivés ni transmis — `asset-availability`) sont candidats ; une cible de
 * page, du fil ou d'une clarification devenue indisponible est REJETÉE et
 * signalée (`unavailable`), jamais lue.
 *
 * Plusieurs candidats aussi plausibles : `ambiguity` (clarification par
 * l'appelant, jamais de choix arbitraire). Désignation sans aucun candidat :
 * `notFound` (« je n'ai pas identifié… », jamais « rien trouvé »).
 *
 * Aucune cible ne donne de droit : l'identifiant vient du serveur (page
 * assainie, fil du même utilisateur, table du compte) et chaque lecture reste
 * bornée au compte.
 */
import type { AssistantRequestInput, IntentRoute } from '../types/contracts';
import { extractSearchTerms, normalizeWord, DOCUMENT_TYPE_STEMS, stemFr } from './query-terms';
import { analyserPeriode, aujourdhuiParis } from './query-period';
import { assetDesignationsIn, subtypeMatchesCategory, type AssetDesignation } from '@/lib/asset-taxonomy';
import { fieldTargetTypes, getField } from '@/services/canonical/registry';
import { withoutFieldPhrases } from '../canonical/field-vocabulary';
import { vehicleIdentifiersIn } from './vehicle-identifiers';
import type { AssetCandidate, EntityCandidate, NestedEntityKind, TargetLookup } from './target-lookup.repository';

export type TargetOrigin = 'clarification' | 'thread' | 'message' | 'page' | 'category' | 'hint';

export type ResolvedTarget =
  | { type: 'asset'; id: number; origin: TargetOrigin; label?: string | null }
  | { type: 'document'; id: number; origin: TargetOrigin; label?: string | null }
  | { type: 'agenda_item'; id: number; origin: TargetOrigin; label?: string | null }
  | { type: 'supplier'; id: number | null; name?: string | null; origin: TargetOrigin }
  /** Équipement / pièce : bien parent conservé, jamais substitué à l'entité (ticket 13 §B). */
  | { type: 'equipment'; id: number; origin: TargetOrigin; label?: string | null; assetId: number | null; assetName?: string | null }
  | { type: 'room'; id: number; origin: TargetOrigin; label?: string | null; assetId: number | null; assetName?: string | null };

export type NestedTarget = Extract<ResolvedTarget, { type: 'equipment' | 'room' }>;

/** Indices textuels (jamais des identifiants) — T2-08. */
export interface TargetHints {
  assetNames: string[];
  documentTitles: string[];
  supplierNames: string[];
  /** Équipements / pièces désignés par le classifieur (ticket 13 §A : types conservés). */
  equipmentNames: string[];
  roomNames: string[];
  /** Catégories / familles de biens désignées par un indice (« la maison »). */
  assetDesignations: AssetDesignation[];
  /** Période désignée par un indice, si la question n'en porte pas. */
  period: { from: string; to: string } | null;
}

/** Ambiguïté de cible : candidats DU COMPTE, jamais du modèle. */
export type TargetAmbiguity =
  | { kind: 'asset'; reason: string; candidates: AssetCandidate[] }
  | { kind: 'equipment' | 'room'; reason: string; candidates: EntityCandidate[] };

export interface AssistantTargets {
  /** Cible la plus prioritaire (objet visé par une question de suivi). */
  primary: ResolvedTarget | null;
  asset: Extract<ResolvedTarget, { type: 'asset' }> | null;
  document: Extract<ResolvedTarget, { type: 'document' }> | null;
  agendaItem: Extract<ResolvedTarget, { type: 'agenda_item' }> | null;
  supplier: Extract<ResolvedTarget, { type: 'supplier' }> | null;
  equipment?: Extract<ResolvedTarget, { type: 'equipment' }> | null;
  room?: Extract<ResolvedTarget, { type: 'room' }> | null;
  /** Biens nommés dans la question (plusieurs : comparaison, pas de filtre unique). */
  namedAssets: Array<{ id: number; name: string }>;
  hints: TargetHints;
  /** Plusieurs candidats aussi plausibles pour la cible demandée. */
  ambiguity?: TargetAmbiguity | null;
  /** Une désignation explicite ne correspond à aucun objet disponible du compte. */
  notFound?: { kind: 'asset' | NestedEntityKind; designation: string } | null;
  /** Cibles immédiates (page, fil, clarification) rejetées : indisponibles (ticket 14). */
  unavailable?: Array<{ type: 'asset' | NestedEntityKind; id: number; origin: TargetOrigin }>;
  /** Catalogue des biens disponibles lu pour la résolution (présentation, famille). */
  catalog?: AssetCandidate[];
}

const RANG: Record<TargetOrigin, number> = { clarification: 0, thread: 1, message: 2, page: 3, category: 4, hint: 5 };

const entier = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Mots génériques d'indice : une famille d'objets, jamais un nom. */
const INDICES_GENERIQUES = new Set([
  'echeance', 'echeances', 'rappel', 'rappels', 'rendez-vous', 'agenda', 'evenement', 'evenements',
  'fournisseur', 'fournisseurs', 'artisan', 'artisans', 'prestataire', 'prestataires',
]);

/**
 * Mots qui désignent la NATURE d'une entité imbriquée, jamais une entité
 * précise (« mes équipements », « les pièces ») : jamais un terme de recherche.
 */
const MOTS_ENTITE_GENERIQUES = new Set([
  'equipement', 'equipements', 'piece', 'pieces', 'salle', 'salles', 'appareil', 'appareils', 'installation', 'installations',
  'numero', 'numeros', 'serie', 'date', 'dates', 'valeur', 'valeurs', 'actuel', 'actuelle', 'exact', 'exacte', 'combien',
  'quand', 'surface', 'superficie', 'fin', 'debut', 'garantie', 'prix', 'achat', 'installee', 'installe', 'installer',
]);

/** Un indice porte-t-il un NOM (et non une famille ou un type) ? */
function estUnNom(value: string): boolean {
  if (value.startsWith('page:')) return false;
  const termes = extractSearchTerms(value).filter((t) => !INDICES_GENERIQUES.has(t)
    && !DOCUMENT_TYPE_STEMS.has(t) && !DOCUMENT_TYPE_STEMS.has(stemFr(t)) && !['document', 'documents', 'fichier', 'fichiers'].includes(t));
  return termes.length > 0;
}

function cibleVide(): AssistantTargets {
  return {
    primary: null, asset: null, document: null, agendaItem: null, supplier: null, equipment: null, room: null, namedAssets: [],
    hints: { assetNames: [], documentTitles: [], supplierNames: [], equipmentNames: [], roomNames: [], assetDesignations: [], period: null },
    ambiguity: null, notFound: null, unavailable: [],
  };
}

const SLOT: Record<ResolvedTarget['type'], keyof AssistantTargets> = {
  asset: 'asset', document: 'document', agenda_item: 'agendaItem', supplier: 'supplier', equipment: 'equipment', room: 'room',
};

/** Pose une cible si elle est plus prioritaire que celle de son emplacement (et que la principale). */
function poser(t: AssistantTargets, c: ResolvedTarget): void {
  const slot = SLOT[c.type];
  const cur = t[slot] as ResolvedTarget | null | undefined;
  if (!cur || RANG[c.origin] < RANG[cur.origin]) (t as unknown as Record<string, ResolvedTarget>)[slot] = c;
  if (!t.primary || RANG[c.origin] < RANG[t.primary.origin]) t.primary = c;
}

/** Retire une cible (rejetée) de son emplacement et de la principale. */
function retirer(t: AssistantTargets, c: ResolvedTarget): void {
  const slot = SLOT[c.type];
  if (t[slot] === c) (t as unknown as Record<string, ResolvedTarget | null>)[slot] = null;
  if (t.primary === c) {
    t.primary = null;
    for (const k of ['equipment', 'room', 'asset', 'document', 'agendaItem', 'supplier'] as const) {
      const x = t[k] as ResolvedTarget | null | undefined;
      if (x && (!t.primary || RANG[x.origin] < RANG[t.primary.origin])) t.primary = x;
    }
  }
}

/**
 * Cibles connues SANS lecture (pure, testée) : clarification, fil, page,
 * indices. Les désignations qui demandent le compte (biens nommés, catégorie,
 * équipements) sont ajoutées par `resolveAssistantTargets`.
 */
export function targetsFromInput(
  input: Pick<AssistantRequestInput, 'resume' | 'reference' | 'pageContext'>,
  route?: Pick<IntentRoute, 'entityHints'> | null,
  today: string = aujourdhuiParis(),
): AssistantTargets {
  const t = cibleVide();
  const pose = (c: ResolvedTarget) => poser(t, c);

  // 1. Clarification : le choix fait foi.
  const r = input.resume;
  if (r?.documentId) pose({ type: 'document', id: r.documentId, origin: 'clarification', label: r.choiceLabel ?? null });
  if (r?.assetId) pose({ type: 'asset', id: r.assetId, origin: 'clarification', label: r.choiceLabel ?? null });
  if (r?.entity && entier(r.entity.id)) {
    pose({ type: r.entity.type, id: r.entity.id, origin: 'clarification', label: r.choiceLabel ?? null, assetId: entier(r.entity.assetId) });
  }

  // 2. Référence du fil.
  const ref = input.reference;
  if (ref && ref.method !== 'clarification') {
    if (ref.type === 'asset') pose({ type: 'asset', id: ref.id, origin: 'thread', label: ref.label ?? null });
    if (ref.type === 'document') pose({ type: 'document', id: ref.id, origin: 'thread', label: ref.label ?? null });
    if (ref.type === 'agenda_item') pose({ type: 'agenda_item', id: ref.id, origin: 'thread', label: ref.label ?? null });
    if (ref.type === 'equipment' || ref.type === 'room') pose({ type: ref.type, id: ref.id, origin: 'thread', label: ref.label ?? null, assetId: null });
  }

  // 4. Page : document, bien, fournisseur ouverts.
  const p = input.pageContext;
  const pageDoc = entier(p?.documentId);
  const pageAsset = entier(p?.assetId);
  const pageSupplier = entier(p?.supplierId);
  if (pageDoc) pose({ type: 'document', id: pageDoc, origin: 'page' });
  if (pageAsset) pose({ type: 'asset', id: pageAsset, origin: 'page' });
  if (pageSupplier) pose({ type: 'supplier', id: pageSupplier, origin: 'page' });

  // 6. Indices : noms seulement ; types d'entité CONSERVÉS (ticket 13 §A).
  for (const h of route?.entityHints ?? []) {
    const v = String(h.value ?? '').trim();
    if (!v || v.length > 120) continue;
    const kind = (h as { type: string }).type;
    if (kind === 'period') {
      const per = analyserPeriode(v, today);
      if (per?.kind === 'resolved' && !t.hints.period) t.hints.period = { from: per.from, to: per.to };
      continue;
    }
    if (kind === 'asset' && !v.startsWith('page:')) {
      for (const d of assetDesignationsIn(v)) {
        if (!t.hints.assetDesignations.some((x) => x.matched === d.matched)) t.hints.assetDesignations.push(d);
      }
    }
    if (!estUnNom(v)) continue;
    const liste = kind === 'asset' ? t.hints.assetNames : kind === 'document' ? t.hints.documentTitles
      : kind === 'supplier' ? t.hints.supplierNames : kind === 'equipment' ? t.hints.equipmentNames
        : kind === 'room' ? t.hints.roomNames : null;
    if (liste && !liste.includes(v)) liste.push(v);
  }
  return t;
}

const motsDe = (s: string) => normalizeWord(s).replace(/['’]/g, ' ').split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Biens NOMMÉS dans un texte (pure, testée) : tous les mots significatifs du
 * nom (≥ 2 caractères, hors mots outils et familles) sont présents, dans le
 * texte, comme mots entiers (un chiffre compte). « la Clio » → Clio ; « ma maison » ne nomme
 * aucun bien (c'est une CATÉGORIE, résolue par `assetsOfDesignation`). Deux
 * biens de même nom sont rendus tous les deux.
 */
export function assetsNamedIn<T extends { id: number; name: string }>(text: string, assets: T[]): T[] {
  const mots = new Set(motsDe(text));
  const out: T[] = [];
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
 * Biens d'une CATÉGORIE ou d'une FAMILLE (pure, testée — tickets 8a §C, 8b §C).
 *
 * Catégorie (« la maison ») : 3 = catégorie renseignée identique, 2 = nom du
 * bien contenant le mot, 1 = bien de la même famille SANS catégorie
 * renseignée ; seuls les meilleurs sont rendus. Une catégorie précise n'est
 * jamais élargie à un bien d'une autre catégorie (un appartement n'est pas
 * « la maison »). Famille (« mon véhicule ») : tous les biens de la famille.
 */
export function assetsOfDesignation<T extends Pick<AssetCandidate, 'id' | 'name' | 'category' | 'subtype'>>(d: AssetDesignation, assets: T[]): T[] {
  if (d.kind === 'family') return assets.filter((a) => (a.category ?? '').toUpperCase() === d.family);
  const scored = assets.map((a) => {
    const memeFamille = (a.category ?? '').toUpperCase() === d.family;
    const s = subtypeMatchesCategory(a.subtype, d.category!) ? 3
      : assetDesignationsIn(a.name).some((x) => x.kind === 'category' && x.category === d.category) ? 2
        : memeFamille && !String(a.subtype ?? '').trim() ? 1 : 0;
    return { a, s };
  }).filter((x) => x.s > 0);
  const best = Math.max(0, ...scored.map((x) => x.s));
  return scored.filter((x) => x.s === best).map((x) => x.a);
}

const forme = (w: string) => w.replace(/(?<=..)[sx]$/, '');

/**
 * Équipements / pièces NOMMÉS par des termes (pure, testée — ticket 13 §C,
 * §D, §G, §H). Score = termes retrouvés comme mots entiers du nom (ou du
 * type), insensible à la casse, aux accents et au pluriel ; seuls les
 * meilleurs restent. Parmi eux, une entité dont TOUS les mots du nom sont
 * cités l'emporte (« chambre parentale » ≠ « chambre enfant »).
 */
export function entitiesNamedBy(terms: string[], entities: EntityCandidate[]): EntityCandidate[] {
  const cherches = [...new Set(terms.map((t) => forme(normalizeWord(t))).filter((t) => t.length >= 3))];
  if (cherches.length === 0) return [];
  const scored = entities.map((e) => {
    const motsNom = motsDe(`${e.name}`).map(forme);
    const motsType = motsDe(`${e.entityType ?? ''}`).map(forme);
    const score = cherches.filter((t) => motsNom.includes(t) || motsType.includes(t)).length;
    const complet = motsNom.filter((w) => w.length >= 3).every((w) => cherches.includes(w));
    return { e, score, complet };
  }).filter((x) => x.score > 0);
  const best = Math.max(0, ...scored.map((x) => x.score));
  const top = scored.filter((x) => x.score === best);
  const complets = top.filter((x) => x.complet);
  return (complets.length >= 1 ? complets : top).map((x) => x.e);
}

/** Options de la résolution (lectures injectables, champs demandés). */
export interface ResolveOptions {
  /**
   * Champs demandés (clés canoniques) : la recherche d'un équipement / d'une
   * pièce n'a lieu que si l'un d'eux admet cette cible, ou sur indice explicite.
   */
  requestedFacts?: string[];
}

/** Ancienne signature (tests, appelants historiques) : un chargeur de noms. */
type LegacyLoader = (accountId: number) => Promise<Array<{ id: number; name: string } & Partial<AssetCandidate>>>;

const lookupParDefaut = async (): Promise<TargetLookup> => (await import('./target-lookup.repository')).sqlTargetLookup;

function versLookup(l: TargetLookup | LegacyLoader | undefined): Promise<TargetLookup> {
  if (!l) return lookupParDefaut();
  if (typeof l === 'function') return Promise.resolve({ assets: async (a) => (await l(a)).map((x) => ({ category: null, subtype: null, ...x })) });
  return Promise.resolve(l);
}

/** Entités cibles admises par les champs demandés (EQUIPMENT / ROOM). */
function typesEntiteDesChamps(facts: string[] | undefined): Set<NestedEntityKind> {
  const out = new Set<NestedEntityKind>();
  for (const k of facts ?? []) {
    const def = getField(k);
    if (!def) continue;
    for (const ty of fieldTargetTypes(def)) {
      if (ty === 'EQUIPMENT') out.add('equipment');
      if (ty === 'ROOM') out.add('room');
    }
  }
  return out;
}

/**
 * Cibles de la demande, lues dans le compte (voir l'en-tête). Ne lève pas
 * pour une lecture de catalogue impossible : les cibles immédiates restent.
 */
export async function resolveAssistantTargets(
  input: Pick<AssistantRequestInput, 'accountId' | 'message' | 'resume' | 'reference' | 'pageContext'>,
  route?: Pick<IntentRoute, 'entityHints'> | null,
  lookupOrLoader?: TargetLookup | LegacyLoader,
  opts: ResolveOptions = {},
): Promise<AssistantTargets> {
  const t = targetsFromInput(input, route);
  const lookup = await versLookup(lookupOrLoader);
  const biens = await lookup.assets(input.accountId).catch(() => null);
  if (biens === null) return t;
  t.catalog = biens;
  const parId = new Map(biens.map((b) => [b.id, b]));
  const message = input.message ?? '';

  // ── Revalidation des cibles immédiates (ticket 14 §D, §E) ──────────────
  // Un identifiant de page, du fil ou d'une clarification n'autorise rien :
  // un bien devenu indisponible est rejeté, jamais lu.
  if (t.asset && !parId.has(t.asset.id)) {
    t.unavailable!.push({ type: 'asset', id: t.asset.id, origin: t.asset.origin });
    retirer(t, t.asset);
  }
  for (const k of ['equipment', 'room'] as const) {
    const e = t[k];
    if (!e) continue;
    const lu = lookup.entityById ? await lookup.entityById(input.accountId, k, e.id).catch(() => null) : null;
    if (!lu) {
      t.unavailable!.push({ type: k, id: e.id, origin: e.origin });
      retirer(t, e);
    } else {
      e.assetId = lu.assetId; e.assetName = lu.assetName; e.label = lu.name ?? e.label;
    }
  }
  // Aucun bien disponible : les étapes suivantes ne trouvent rien, mais une
  // désignation explicite est signalée comme NON IDENTIFIÉE (jamais lue ailleurs).

  // ── 3. Désignations explicites dans la question ────────────────────────
  const nommes = assetsNamedIn(message, biens);
  t.namedAssets = nommes.map((a) => ({ id: a.id, name: a.name }));
  if (nommes.length === 1 && (!t.asset || RANG[t.asset.origin] > RANG.message)) {
    poser(t, { type: 'asset', id: nommes[0].id, origin: 'message', label: nommes[0].name });
  }
  // VIN / immatriculation EXACTS (8b §D) : jamais de rapprochement approximatif.
  const ids = vehicleIdentifiersIn(message);
  if ((ids.plates.length || ids.vins.length) && lookup.vehiclesByIdentifier && (!t.asset || RANG[t.asset.origin] > RANG.message)) {
    const v = (await lookup.vehiclesByIdentifier(input.accountId, ids).catch(() => [])).filter((x) => parId.has(x.id));
    if (v.length === 1) poser(t, { type: 'asset', id: v[0].id, origin: 'message', label: v[0].name });
    else if (v.length > 1 && !t.ambiguity) t.ambiguity = { kind: 'asset', reason: 'VEHICLE_IDENTIFIER_MULTIPLE_ASSETS', candidates: v };
  }

  // Équipement / pièce : nommé dans la question, puis indice du classifieur.
  // Le bien déjà connu (clarification, fil, question, page) FILTRE la
  // recherche ; il ne remplace jamais l'entité désignée (13 §E, §I).
  const typesChamps = typesEntiteDesChamps(opts.requestedFacts);
  const parentConnu = t.asset ? t.asset.id : null;
  const designations = assetDesignationsIn(message);
  if (lookup.entities && !t.equipment && !t.room) {
    const motsBiens = new Set(nommes.flatMap((a) => extractSearchTerms(a.name)));
    const motsCategorie = new Set(designations.map((d) => d.matched).flatMap((m) => m.split(/\s+/)));
    const termesMessage = extractSearchTerms(withoutFieldPhrases(message))
      .filter((w) => !motsBiens.has(w) && !motsCategorie.has(w) && !MOTS_ENTITE_GENERIQUES.has(w) && w.length >= 3);
    const sources: Array<{ kind: NestedEntityKind; terms: string[]; origin: TargetOrigin; designation: string }> = [];
    for (const kind of ['equipment', 'room'] as const) {
      const indices = kind === 'equipment' ? t.hints.equipmentNames : t.hints.roomNames;
      if (typesChamps.has(kind) && termesMessage.length) sources.push({ kind, terms: termesMessage, origin: 'message', designation: termesMessage.join(' ') });
      for (const h of indices) {
        const termes = extractSearchTerms(h).filter((w) => !MOTS_ENTITE_GENERIQUES.has(w));
        if (termes.length) sources.push({ kind, terms: termes, origin: 'hint', designation: h });
      }
    }
    let retenu: EntityCandidate | null = null;
    let origineRetenue: TargetOrigin = 'hint';
    for (const s of sources) {
      // Le parent connu restreint la recherche. Désigné explicitement (question,
      // fil, clarification) : la recherche s'y LIMITE. Simple contexte de
      // page : sans résultat dans ce bien, tout le compte.
      let cands = parentConnu
        ? entitiesNamedBy(s.terms, await lookup.entities(input.accountId, s.kind, s.terms, { assetIds: [parentConnu] }).catch(() => []))
        : [];
      if (cands.length === 0 && (!parentConnu || t.asset?.origin === 'page')) {
        cands = entitiesNamedBy(s.terms, await lookup.entities(input.accountId, s.kind, s.terms).catch(() => []));
      }
      if (cands.length === 1) { retenu = cands[0]; origineRetenue = s.origin; break; }
      if (cands.length > 1) {
        if (!t.ambiguity) t.ambiguity = { kind: s.kind, reason: s.kind === 'equipment' ? 'EQUIPMENT_MULTIPLE_CANDIDATES' : 'ROOM_MULTIPLE_CANDIDATES', candidates: cands.slice(0, 6) };
        break;
      }
      // Indice explicite du classifieur sans aucun candidat : non identifié
      // (13 AC10) — jamais une recherche de BIEN portant ce nom.
      if (s.origin === 'hint' && !t.notFound) t.notFound = { kind: s.kind, designation: s.designation };
    }
    if (retenu) {
      t.notFound = null;
      poser(t, { type: retenu.kind, id: retenu.id, origin: origineRetenue, label: retenu.name, assetId: retenu.assetId, assetName: retenu.assetName });
      if (t.ambiguity && t.ambiguity.kind !== 'asset') t.ambiguity = null;
    }
  }

  // ── 5. Catégorie / famille (« la maison », « ma voiture ») ─────────────
  // Après le nom et la page : une catégorie n'écrase jamais une cible plus
  // précise ; une cible imbriquée déjà résolue porte son propre parent.
  // Exception : le bien de la PAGE ne correspond pas à la catégorie nommée
  // (« l'adresse de la maison » depuis la fiche de la Polo) — la désignation
  // explicite de la question l'emporte alors sur le contexte.
  const pageIncompatible = t.asset?.origin === 'page' && designations.length > 0
    && parId.has(t.asset.id) && assetsOfDesignation(designations[0], [parId.get(t.asset.id)!]).length === 0;
  if (pageIncompatible && !t.equipment && !t.room && nommes.length === 0) retirer(t, t.asset!);
  if (!t.asset && !t.equipment && !t.room && nommes.length === 0 && designations.length) {
    resoudreDesignation(t, designations[0], biens, 'category');
  }

  // Lecture de champs : un MOT distinctif de la question présent dans le nom
  // de biens disponibles (« la Polo » → « Polo perso », « Polo conjoint »).
  // Un seul bien : retenu ; plusieurs : ambiguïté (clarification) — jamais
  // de choix arbitraire, jamais un bien indisponible (ticket 14 AC05, AC06).
  if (opts.requestedFacts?.length && !t.asset && !t.equipment && !t.room && nommes.length === 0 && !t.ambiguity) {
    const motsCategorie = new Set(designations.map((d) => d.matched).flatMap((m) => m.split(/\s+/)));
    const termes = extractSearchTerms(withoutFieldPhrases(message))
      .filter((w) => w.length >= 3 && !MOTS_ENTITE_GENERIQUES.has(w) && !motsCategorie.has(w));
    if (termes.length) {
      const scored = biens.map((b) => ({ b, n: termes.filter((w) => motsDe(b.name).includes(w)).length })).filter((x) => x.n > 0);
      const best = Math.max(0, ...scored.map((x) => x.n));
      const top = scored.filter((x) => x.n === best).map((x) => x.b);
      if (top.length === 1) poser(t, { type: 'asset', id: top[0].id, origin: 'message', label: top[0].name });
      else if (top.length > 1) t.ambiguity = { kind: 'asset', reason: 'NAME_MULTIPLE_ASSETS', candidates: top };
    }
  }

  // ── 6. Indices du classifieur ramenés au compte ─────────────────────────
  if (!t.asset && !t.equipment && !t.room && nommes.length === 0) {
    const parIndice = [...new Map(t.hints.assetNames.flatMap((h) => assetsNamedIn(h, biens)).map((a) => [a.id, a])).values()];
    if (parIndice.length === 1) poser(t, { type: 'asset', id: parIndice[0].id, origin: 'hint', label: parIndice[0].name });
    else if (parIndice.length > 1 && !t.ambiguity) t.ambiguity = { kind: 'asset', reason: 'HINT_MULTIPLE_ASSETS', candidates: parIndice };
    else if (!t.ambiguity && t.hints.assetDesignations.length) resoudreDesignation(t, t.hints.assetDesignations[0], biens, 'hint');
    else if (!t.ambiguity && t.hints.assetNames.length && !t.notFound) t.notFound = { kind: 'asset', designation: t.hints.assetNames[0] };
  }
  return t;
}

function resoudreDesignation(t: AssistantTargets, d: AssetDesignation, biens: AssetCandidate[], origin: 'category' | 'hint'): void {
  const cands = assetsOfDesignation(d, biens);
  if (cands.length === 1) poser(t, { type: 'asset', id: cands[0].id, origin, label: cands[0].name });
  else if (cands.length > 1) { if (!t.ambiguity) t.ambiguity = { kind: 'asset', reason: 'CATEGORY_MULTIPLE_ASSETS', candidates: cands }; }
  else if (!t.notFound) t.notFound = { kind: 'asset', designation: d.matched };
}

/** La cible imbriquée retenue (équipement ou pièce), la plus prioritaire. */
export function nestedTargetOf(t: AssistantTargets): NestedTarget | null {
  const e = t.equipment ?? null;
  const r = t.room ?? null;
  if (e && r) return RANG[e.origin] <= RANG[r.origin] ? e : r;
  return e ?? r;
}
