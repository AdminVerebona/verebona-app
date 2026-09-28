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
