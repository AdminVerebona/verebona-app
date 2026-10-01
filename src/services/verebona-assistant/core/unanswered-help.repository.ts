/**
 * Questions d'aide restées sans réponse — CDC §10.4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LES TROUS DE LA BASE D'AIDE N'ÉTAIENT VUS DE PERSONNE
 *
 * Une question d'usage sans article pertinent recevait l'aveu « je ne peux
 * pas répondre de façon fiable » et le lien vers le support — puis rien :
 * l'équipe éditoriale n'avait aucun moyen de savoir quels articles manquent.
 *
 * Cette lecture remonte au BO les demandes d'aide SANS source, regroupées
 * par intention et par formulation, avec leur fréquence. Le texte est
 * EXPURGÉ (e-mails, téléphones, IBAN, numéros, noms après civilité,
 * adresses, dates, codes postaux) et tronqué ; ni compte ni utilisateur ne
 * sont exposés. Seules les questions ENCORE conservées sont lues : message
 * non expiré, dans un fil actif et non expiré — une question purgée ou
 * effacée par l'utilisateur ne réapparaît jamais au BO.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { HELP_INTENTS } from './help-corpus.service';
import { redact } from './redaction.service';
import { truthSourceOf } from '@/services/ai/telemetry/t2-observability';

export interface UnansweredHelpQuestion {
  intent: string;
  /** Formulation expurgée et normalisée (≤ 160 caractères). */
  question: string;
  count: number;
  lastSeen: string;
}

const L = "A-Za-zÀ-ÖØ-öø-ÿ";
/** Nom propre après une civilité : « M. Dupont », « Madame Anne-Marie Le Gall ». */
const CIVILITE = new RegExp(
  `(?<![${L}])(M\\.|Mr\\.?|Mme\\.?|Mlle\\.?|Me\\.?|Dr\\.?|Pr\\.?|Monsieur|Madame|Mademoiselle|Maître|Maitre|Docteur|Professeur)`
  + `\\s+(?:[A-ZÀ-ÖØ-Ý][${L}'’-]*)(?:\\s+(?:de |du |le |la |d'|d’)?[A-ZÀ-ÖØ-Ý][${L}'’-]*){0,2}`,
  'g',
);
/** Types de voie, première lettre indifférente à la casse (« rue », « Rue »). */
const VOIES = ['rue', 'avenue', 'av\\.?', 'boulevard', 'bd', 'chemin', 'ch\\.?', 'allée', 'allee', 'impasse', 'place', 'pl\\.?',
  'quai', 'route', 'rte', 'cours', 'square', 'passage', 'lotissement', 'lieu-dit', 'résidence', 'residence', 'voie',
  'sentier', 'faubourg', 'fg']
  .map((v) => `[${v[0]}${v[0].toUpperCase()}]${v.slice(1)}`).join('|');
const PARTICULE = "(?:de |du |des |d'|d’|la |le |les )?";
/**
 * Adresse : numéro (bis/ter) + type de voie + nom de la voie — le premier
 * mot quel qu'il soit, puis jusqu'à deux mots à majuscule (« des Lilas »,
 * « Victor Hugo ») ; la suite de la phrase reste lisible.
 */
const ADRESSE = new RegExp(
  `(?<![${L}\\d])\\d{1,4}\\s*(?:bis|ter|quater|[a-d])?\\s*,?\\s*(?:${VOIES})`
  + `\\s+${PARTICULE}[${L}'’-]+(?:\\s+${PARTICULE}[A-ZÀ-ÖØ-Ý][${L}'’-]*){0,2}`,
  'g',
);
/** Dates jj/mm, jj/mm/aa(aa), jj-mm-aaaa, jj.mm.aaaa (le point seul n'en fait pas une : « 2.5 Mo »). */
const DATE = /(?<!\d)\d{1,2}(?:[/-]\d{1,2}(?:[/-]\d{2,4})?|\.\d{1,2}\.\d{2,4})(?!\d)/g;
/** Code postal français (5 chiffres, Corse 2A/2B). */
const CODE_POSTAL = /(?<![\d\w])(?:\d{5}|2[AB]\d{3})(?![\d\w])/g;

/** Expurge et normalise une question pour l'agrégation. */
export function expurgerQuestion(texte: string): string {
  return redact(String(texte ?? ''))
    // Données personnelles résiduelles, avant les numéros génériques : une
    // adresse ou une date se reconnaît à ses chiffres.
    .replace(CIVILITE, '$1 [nom]')
    .replace(ADRESSE, '[adresse]')
    .replace(DATE, '[date]')
    .replace(CODE_POSTAL, '[code postal]')
    // Numéros résiduels (contrats, dossiers, immatriculations…).
    .replace(/\b[A-Z]{2}-?\d{3}-?[A-Z]{2}\b/gi, '[immatriculation]')
    .replace(/\d{4,}/g, '[numéro]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** Agrège des lignes brutes (pur : testable sans base). */
export function agregerQuestions(
  lignes: Array<{ intent: string | null; content: string | null; created_at: string | Date }>,
  limit = 50,
): UnansweredHelpQuestion[] {
  const groupes = new Map<string, UnansweredHelpQuestion>();
  for (const l of lignes) {
    const question = expurgerQuestion(l.content ?? '');
    if (!question) continue;
    const intent = l.intent ?? 'UNKNOWN';
    const cle = `${intent}|${question.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[?!.\s]+$/g, '')}`;
    const vu = new Date(l.created_at).toISOString();
    const g = groupes.get(cle);
    if (g) {
      g.count += 1;
      if (vu > g.lastSeen) g.lastSeen = vu;
    } else {
      groupes.set(cle, { intent, question, count: 1, lastSeen: vu });
    }
  }
  return [...groupes.values()]
    .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, limit);
}

/**
 * Demandes d'aide sans article (0 source) des `days` derniers jours.
 * Seules les demandes abouties comptent (une panne n'est pas un trou
 * éditorial).
 */
export async function listUnansweredHelpQuestions(opts: { days?: number; limit?: number } = {}): Promise<UnansweredHelpQuestion[]> {
  const days = Math.min(Math.max(Math.floor(opts.days ?? 30), 1), 90);
  const lignes = (await pgClient.unsafe(
    `SELECT r.intent, m.content, r.created_at
       FROM verebona_request_runs r
       JOIN verebona_messages m
         ON m.request_id = r.request_id AND m.account_id = r.account_id AND m.role = 'user'
       -- Fil encore actif et non expiré : un fil effacé ou purgé ne remonte pas.
       JOIN verebona_conversations c
         ON c.id = m.conversation_id AND c.account_id = m.account_id
        AND c.status = 'active' AND c.expires_at > now()
      WHERE r.intent = ANY($1::text[])
        -- Question encore conservée (90 jours, §24.1).
        AND m.expires_at > now()
        AND coalesce(r.source_count, 0) = 0
        AND coalesce(r.status, 'ok') = 'ok'
        AND r.created_at >= now() - make_interval(days => $2::int)
      ORDER BY r.created_at DESC
      LIMIT 2000`,
    [[...HELP_INTENTS], days] as never[],
  )) as unknown as Array<{ intent: string | null; content: string | null; created_at: string }>;
  return agregerQuestions(lignes, Math.min(Math.max(opts.limit ?? 50, 1), 200));
}

// ── §32.5 : demandes non résolues, par intention et MOTIF ───────────────────
//
// Au-delà des questions d'aide sans article, TOUTES les demandes non
// résolues sont regroupées par motif (CDC Assistant §32.5) : aucune donnée,
// ambiguïté, absence d'article d'aide, action non supportée, incident
// technique, hors périmètre. COMPTEURS SEULEMENT : aucun texte, aucun compte,
// aucun utilisateur (« les tableaux de bord privilégient des regroupements »).
// Lecture seule, connexion réservée, `statement_timeout` côté base (cadre
// de l'observabilité, lot 17), sur l'index de date 0226.

export const UNANSWERED_MOTIVES = [
  'aucune_donnee', 'ambiguite', 'absence_article_aide', 'action_non_supportee', 'incident_technique', 'hors_perimetre',
] as const;
export type UnansweredMotive = (typeof UNANSWERED_MOTIVES)[number];

export const UNANSWERED_MOTIVE_LABELS: Readonly<Record<UnansweredMotive, string>> = {
  aucune_donnee: 'Aucune donnée',
  ambiguite: 'Ambiguïté',
  absence_article_aide: 'Absence d’article d’aide',
  action_non_supportee: 'Action non supportée',
  incident_technique: 'Incident technique',
  hors_perimetre: 'Hors périmètre',
};

/** Ligne agrégée de `verebona_request_runs` (sans contenu). */
export interface UnansweredRunGroup {
  intent: string | null;
  status: string | null;
  error_code: string | null;
  state: string | null;
  strategy: string | null;
  no_source: boolean | null;
  ambiguous_ref: boolean | null;
  n: number;
}

/** Codes qui ne sont pas des demandes « non résolues » (refus d'usage, annulation). */
const HORS_DECOMPTE = new Set(['REQUEST_CANCELLED', 'RATE_LIMITED', 'PLAN_NOT_ELIGIBLE', 'VALIDATION_FAILED', 'CONVERSATION_EXPIRED']);
const HORS_PERIMETRE_INTENTS = new Set(['OUT_OF_SCOPE', 'SENSITIVE_ADVICE', 'UNSAFE_OR_MALICIOUS']);

/**
 * Motif d'une demande non résolue, ou `null` si elle a reçu une réponse (ou
 * n'est pas une question : annulation, quota, offre). Pur, testé.
 * Ordre : l'incident prime (la réponse n'a pas pu être construite), puis le
 * périmètre, l'action, l'ambiguïté, l'aide, enfin l'absence de donnée.
 */
export function classifyUnanswered(g: Omit<UnansweredRunGroup, 'n'>): UnansweredMotive | null {
  const code = g.error_code ?? '';
  const strategy = g.strategy ?? '';
  const intent = g.intent ?? '';
  if (HORS_DECOMPTE.has(code) || g.state === 'CANCELLED' || g.status === 'pending') return null;
  if (g.status === 'error' && !['UNSAFE_REQUEST', 'INVALID_ACTION', 'CLARIFICATION_REQUIRED', 'CLARIFICATION_EXPIRED', 'NO_RELEVANT_SOURCE'].includes(code)) {
    return 'incident_technique';
  }
  if (strategy.startsWith('timeout.')) return 'incident_technique';
  if (HORS_PERIMETRE_INTENTS.has(intent) || code === 'UNSAFE_REQUEST') return 'hors_perimetre';
  if (intent === 'UNSUPPORTED_ACTION' || code === 'INVALID_ACTION') return 'action_non_supportee';
  if (g.state === 'CLARIFYING' || strategy.startsWith('clarification.') || strategy === 'reference.clarification'
    || code === 'CLARIFICATION_REQUIRED' || code === 'CLARIFICATION_EXPIRED' || g.ambiguous_ref) return 'ambiguite';
  if (HELP_INTENTS.has(intent) && g.no_source) return 'absence_article_aide';
  if (code === 'NO_RELEVANT_SOURCE' || (g.no_source && truthSourceOf(strategy || null) === 'aucune')) return 'aucune_donnee';
  return null;
}

export interface UnansweredByMotive {
  days: number;
  total: number;
  byMotive: Array<{ motive: UnansweredMotive; label: string; count: number }>;
  byIntent: Array<{ intent: string; motive: UnansweredMotive; label: string; count: number }>;
}

/** Agrège des groupes de demandes (pur : testable sans base). */
export function aggregateUnanswered(groups: UnansweredRunGroup[], days: number, limit = 30): UnansweredByMotive {
  const parMotif = new Map<UnansweredMotive, number>();
  const parIntention = new Map<string, number>();
  for (const g of groups) {
    const m = classifyUnanswered(g);
    if (!m) continue;
    const k = Number(g.n) || 0;
    parMotif.set(m, (parMotif.get(m) ?? 0) + k);
    const cle = `${g.intent ?? 'UNKNOWN'}|${m}`;
    parIntention.set(cle, (parIntention.get(cle) ?? 0) + k);
  }
  return {
    days,
    total: [...parMotif.values()].reduce((a, b) => a + b, 0),
    byMotive: UNANSWERED_MOTIVES.map((motive) => ({ motive, label: UNANSWERED_MOTIVE_LABELS[motive], count: parMotif.get(motive) ?? 0 })),
    byIntent: [...parIntention.entries()]
      .map(([cle, count]) => {
        const [intent, motive] = cle.split('|') as [string, UnansweredMotive];
        return { intent, motive, label: UNANSWERED_MOTIVE_LABELS[motive], count };
      })
      .sort((a, b) => b.count - a.count || a.intent.localeCompare(b.intent))
      .slice(0, limit),
  };
}

/** Demandes non résolues des `days` derniers jours, par motif et intention. */
export async function listUnansweredByMotive(opts: { days?: number } = {}): Promise<UnansweredByMotive> {
  const days = Math.min(Math.max(Math.floor(opts.days ?? 30), 1), 90);
  const { readOnlyObservabilityQuery } = await import('@/services/ai/telemetry/observability.repository');
  const groups = (await readOnlyObservabilityQuery(
    `SELECT intent, COALESCE(status, 'ok') AS status, error_code, machine_final_state AS state,
            retrieval_methods_json->>'strategy' AS strategy,
            (COALESCE(source_count, 0) = 0) AS no_source,
            COALESCE(retrieval_methods_json->'reference'->>'outcome' = 'ambiguous', false) AS ambiguous_ref,
            COUNT(*)::int AS n
       FROM verebona_request_runs
      WHERE created_at >= now() - make_interval(days => $1::int) AND COALESCE(status, 'ok') <> 'pending'
      GROUP BY 1, 2, 3, 4, 5, 6, 7
      LIMIT 5000`,
    [days],
  )) as unknown as UnansweredRunGroup[];
  return aggregateUnanswered(groups, days);
}

