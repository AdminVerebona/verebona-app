/**
 * Sélection des suggestions partagées — lot 108J. FONCTIONS PURES (testées).
 *
 * Le MÊME résultat sert l'accueil (zone sous la bulle de la mascotte) et
 * l'état initial de « Demander à Verebona » (ordinateur et mobile) : mêmes
 * trois éléments, même ordre, même version, pour un même utilisateur et un
 * même état du compte.
 *
 * Règles :
 *   · 3 suggestions au plus (`MAX_HOME_SUGGESTIONS`), réparties LIBREMENT
 *     entre les objectifs : au plus 2 personnelles (A / B) pour laisser une
 *     place au guide quand il a une question répondable ; sans fait
 *     personnel fiable, le guide remplit les trois places — jamais de fait
 *     inventé pour respecter un quota ;
 *   · une question par sujet (pas deux questions d'échéances) ;
 *   · guide : questions de l'étape constatée ; une suggestion CONSULTÉE
 *     (cliquée) laisse sa place pendant son repos puis peut revenir ;
 *   · rotation DÉTERMINISTE entre visites : la période de rotation change
 *     l'ordre des questions du guide (et l'univers de départ des Ressources)
 *     sans aucun appel IA ni fausse progression ;
 *   · réserve : les suivantes, déjà validées, prennent la place d'une
 *     suggestion cliquée sans rechargement.
 */
import { createHash } from 'node:crypto';
import type { VerebonaIntent } from '@/services/verebona-assistant/types/intents';
import type { GuideStage, GuideStockEntry, SuggestionObjective, SuggestionUniverse } from './stock';
import type { Answerability } from './answerability';

export const SHARED_SUGGESTIONS_CONTRACT = 'shared-suggestions-v1';
/** Au plus deux questions personnelles (A / B) quand le guide a une question répondable. */
export const MAX_PERSONAL_SUGGESTIONS = 2;
/** Réserve transmise (remplacements sans rechargement après un clic). */
export const SHARED_SUGGESTIONS_RESERVE_MAX = 6;
/** Période de rotation entre visites (heures). */
export const SHARED_SUGGESTION_ROTATION_HOURS = 12;
/** Repos d'une suggestion consultée (heures) : elle peut revenir ensuite. */
export const SHARED_SUGGESTION_CONSULTED_REST_HOURS = 24;

export type SuggestionSourceKind = 'ACCOUNT_DATA' | 'HELP_CENTER' | 'RESOURCES';

/** Élément servi aux deux surfaces (aucune donnée au-delà du libellé et de la cible). */
export interface SharedSuggestion {
  /** Identifiant stable (jamais le libellé). */
  id: string;
  label: string;
  objective: SuggestionObjective;
  /** Intention T2 canonique (revalidée au clic). */
  canonicalIntent: VerebonaIntent;
  /** Corpus attendu de la réponse. */
  corpus: 'ACCOUNT' | 'HELP' | 'RESOURCES';
  /** Provenance admissible : données du compte, article du Centre d'aide ou Ressource (identifiant, version). */
  source: { kind: SuggestionSourceKind; ref: string; version: string | null };
  /** Bien nommé dans la question (revalidé côté serveur au clic). */
  target: { assetId: number } | null;
  stage: GuideStage | null;
  universe: SuggestionUniverse | null;
  answerability: Exclude<Answerability, 'NOT_ANSWERABLE'>;
  /** Sujet (dédoublonnage). */
  topic: string;
}

export interface SharedSuggestionSelection {
  contract: typeof SHARED_SUGGESTIONS_CONTRACT;
  /** Version de la sélection : identique tant que le stock et les faits pertinents ne changent pas. */
  version: string;
  generatedAt: string;
  stage: GuideStage;
  items: SharedSuggestion[];
  reserve: SharedSuggestion[];
}

export interface AccountCandidate {
  catalogId: string;
  label: string;
  objective: 'EXPLOIT' | 'ANTICIPATE';
  priority: number;
  canonicalIntent: VerebonaIntent;
  topic: string;
  assetId?: number;
}

export interface GuideCandidate { entry: GuideStockEntry; answerability: Exclude<Answerability, 'NOT_ANSWERABLE'>; version: string | null }

/** Graine stable d'un utilisateur dans un compte (Duo : chacun la sienne). */
export function selectionSeedOf(accountId: number, userId: number | null): number {
  return Number.parseInt(createHash('sha256').update(`${accountId}:${userId ?? 0}:sugg`).digest('hex').slice(0, 8), 16);
}

/** Période de rotation courante. */
export function rotationBucketOf(now: Date): number {
  return Math.floor(now.getTime() / (SHARED_SUGGESTION_ROTATION_HOURS * 3_600_000));
}

const UNIVERS: readonly SuggestionUniverse[] = ['HOUSING', 'VEHICLE', 'EQUIPMENT'];

/**
 * Ordre du guide (pur) : questions du Centre d'aide d'abord à l'étape de
 * prise en main ; à l'étape établie, Ressources d'abord, univers servis à
 * tour de rôle (départ qui tourne avec la période), puis le reste. Dans
 * chaque groupe, décalage circulaire par (graine + période).
 */
export function orderGuide(cands: readonly GuideCandidate[], stage: GuideStage, seed: number, bucket: number): GuideCandidate[] {
  // Prise en main : l'ordre du stock (les fondamentaux d'abord : bien, document, analyse) ;
  // ensuite, décalage circulaire par (graine + période) entre visites.
  const rot = <T>(l: T[]): T[] => (stage === 'START' || !l.length ? l : [...l.slice((seed + bucket) % l.length), ...l.slice(0, (seed + bucket) % l.length)]);
  const aide = rot(cands.filter((c) => c.entry.corpus === 'HELP'));
  const ress = cands.filter((c) => c.entry.corpus === 'RESOURCES');
  const depart = (seed + bucket) % UNIVERS.length;
  const files = UNIVERS.map((_, i) => rot(ress.filter((c) => c.entry.universe === UNIVERS[(depart + i) % UNIVERS.length])));
  const alterne: GuideCandidate[] = [];
  for (let k = 0; files.some((f) => f.length > k); k += 1) for (const f of files) if (f[k]) alterne.push(f[k]);
  const sansUnivers = rot(ress.filter((c) => !c.entry.universe));
  return stage === 'ESTABLISHED' ? [...alterne, ...sansUnivers, ...aide] : [...aide, ...alterne, ...sansUnivers];
}

function versionOf(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

/**
 * Sélection (pure, testée). `consulted` : suggestions cliquées encore au
 * repos — placées en fin de réserve (jamais réaffichées tout de suite, sauf
 * s'il ne reste rien d'autre : l'accueil n'est jamais vide).
 */
export function selectSharedSuggestions(p: {
  stage: GuideStage;
  account: readonly AccountCandidate[];
  guide: readonly GuideCandidate[];
  consulted: ReadonlySet<string>;
  seed: number;
  bucket: number;
  max: number;
  /** Empreinte des faits pertinents (versions de corpus, compteurs) : entre dans la version. */
  fingerprint: string;
  now: Date;
}): SharedSuggestionSelection {
  const perso: SharedSuggestion[] = [...p.account]
    .sort((a, b) => a.priority - b.priority || (a.objective === b.objective ? 0 : a.objective === 'EXPLOIT' ? -1 : 1))
    .map((a) => ({
      id: `acc_${a.catalogId}`, label: a.label, objective: a.objective, canonicalIntent: a.canonicalIntent, corpus: 'ACCOUNT' as const,
      source: { kind: 'ACCOUNT_DATA' as const, ref: a.catalogId, version: null },
      target: a.assetId ? { assetId: a.assetId } : null, stage: null, universe: null, answerability: 'VERIFIED' as const, topic: a.topic,
    }));
  // A et B alternés : la meilleure question de chaque objectif d'abord.
  const exploit = perso.filter((x) => x.objective === 'EXPLOIT');
  const anticipe = perso.filter((x) => x.objective === 'ANTICIPATE');
  const persoAlterne: SharedSuggestion[] = [];
  for (let k = 0; k < Math.max(exploit.length, anticipe.length); k += 1) {
    if (exploit[k]) persoAlterne.push(exploit[k]);
    if (anticipe[k]) persoAlterne.push(anticipe[k]);
  }
  const guide: SharedSuggestion[] = orderGuide(p.guide, p.stage, p.seed, p.bucket).map((g) => ({
    id: g.entry.id, label: g.entry.label, objective: 'GUIDE' as const, canonicalIntent: g.entry.canonicalIntent, corpus: g.entry.corpus,
    source: { kind: g.entry.corpus === 'HELP' ? 'HELP_CENTER' as const : 'RESOURCES' as const, ref: g.entry.articleId, version: g.version },
    target: null, stage: p.stage, universe: g.entry.universe ?? null, answerability: g.answerability, topic: `article:${g.entry.articleId}`,
  }));

  const frais = (l: SharedSuggestion[]) => l.filter((x) => !p.consulted.has(x.id));
  const items: SharedSuggestion[] = [];
  const sujets = new Set<string>();
  const libelles = new Set<string>();
  const prendre = (x: SharedSuggestion, into: SharedSuggestion[]) => {
    if (sujets.has(x.topic) || libelles.has(x.label)) return false;
    sujets.add(x.topic); libelles.add(x.label); into.push(x);
    return true;
  };
  const persoFrais = frais(persoAlterne);
  const guideFrais = frais(guide);
  const placePerso = guideFrais.length > 0 ? Math.min(MAX_PERSONAL_SUGGESTIONS, p.max) : p.max;
  for (const x of persoFrais) { if (items.length >= placePerso) break; prendre(x, items); }
  for (const x of guideFrais) { if (items.length >= p.max) break; prendre(x, items); }
  for (const x of persoFrais) { if (items.length >= p.max) break; prendre(x, items); }
  // Dernier recours : une suggestion consultée revient plutôt qu'une zone vide.
  const consultees = [...persoAlterne, ...guide].filter((x) => p.consulted.has(x.id));
  for (const x of consultees) { if (items.length >= p.max) break; prendre(x, items); }

  const reserve: SharedSuggestion[] = [];
  for (const x of [...guideFrais, ...persoFrais, ...consultees]) {
    if (reserve.length >= SHARED_SUGGESTIONS_RESERVE_MAX) break;
    prendre(x, reserve);
  }
  return {
    contract: SHARED_SUGGESTIONS_CONTRACT,
    version: versionOf([p.fingerprint, p.bucket, p.stage, items.map((x) => [x.id, x.label, x.target?.assetId ?? null]), reserve.map((x) => x.id)]),
    generatedAt: p.now.toISOString(),
    stage: p.stage,
    items,
    reserve,
  };
}
