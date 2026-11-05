/**
 * Journal technique du partage natif — lot 111P (ticket « partage iOS :
 * “Vous n'êtes pas connecté” à tort »). Même principe que le journal du
 * déverrouillage (lot 111D) : les 40 derniers événements sont gardés dans le
 * stockage local de la vue, y compris en production, pour établir APRÈS COUP
 * et sur l'appareil pourquoi le jeton d'import manquait, a été refusé ou n'a
 * pas pu être écrit.
 *
 * Deux sources, mêmes règles :
 *   · la vue web : demandes de jeton (motif, résultat, nouvel essai),
 *     vérification serveur légère, renouvellements après refus ;
 *   · le natif (extension iOS, app, Android) : lecture / écriture du Keychain
 *     ou du Keystore, refus serveur reçus par l'envoi de fond, état affiché
 *     dans l'interface de partage — repris ici depuis `getState().diagnostics`.
 *
 * Contenu : codes stables et valeurs courtes d'une liste FERMÉE de champs.
 * Jamais de jeton, cookie, identifiant de compte, nom de fichier, document ni
 * chemin de page. Rien n'est envoyé au serveur. Lecture : inspecteur Web
 * (préproduction) ou `localStorage.getItem('verebona:native:share-import-journal')`,
 * et le code du dernier événement est rappelé dans la carte d'état.
 */

export const SHARE_IMPORT_JOURNAL_KEY = 'verebona:native:share-import-journal';
export const SHARE_IMPORT_JOURNAL_MAX = 40;

/** Champs autorisés (liste fermée) : tout autre champ est ignoré. */
const ALLOWED_FIELDS = new Set([
  'trigger', 'reason', 'outcome', 'detail', 'attempt', 'delayMs', 'verdict', 'grantStatus', 'storeCode', 'phase', 'src', 'renewals',
]);

export interface ShareImportJournalEntry {
  /** Instant (ms depuis l'époque). */
  t: number;
  /** Code stable (GRANT_PROVISION, GRANT_CHECK, NATIVE_<code>…). */
  c: string;
  d: Record<string, string | number | boolean | null>;
}

/** Détail réduit aux champs autorisés et aux valeurs simples et courtes (pur, testé). */
export function sanitizeShareImportDetail(detail: Record<string, unknown> | undefined): ShareImportJournalEntry['d'] {
  const out: ShareImportJournalEntry['d'] = {};
  if (!detail) return out;
  for (const [k, v] of Object.entries(detail)) {
    if (!ALLOWED_FIELDS.has(k)) continue;
    if (v === null || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && /^[A-Za-z0-9_.,:-]{0,48}$/.test(v)) out[k] = v;
  }
  return out;
}

export function readShareImportJournal(): ShareImportJournalEntry[] {
  try {
    const raw = globalThis.localStorage?.getItem(SHARE_IMPORT_JOURNAL_KEY);
    const list = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(list)
      ? list.filter((e): e is ShareImportJournalEntry => !!e && typeof e === 'object' && typeof (e as ShareImportJournalEntry).c === 'string')
      : [];
  } catch {
    return [];
  }
}

function write(list: ShareImportJournalEntry[]): void {
  try {
    globalThis.localStorage?.setItem(SHARE_IMPORT_JOURNAL_KEY, JSON.stringify(list.slice(-SHARE_IMPORT_JOURNAL_MAX)));
  } catch { /* stockage indisponible : journal facultatif */ }
}

export function appendShareImportJournal(code: string, detail?: Record<string, unknown>, now: number = Date.now()): void {
  if (!/^[A-Z0-9_]{1,48}$/.test(code)) return;
  const list = readShareImportJournal();
  list.push({ t: now, c: code, d: sanitizeShareImportDetail(detail) });
  write(list);
}

/**
 * Reprend les événements du natif encore absents du journal (même instant et
 * même code = déjà repris). Codes natifs : majuscules, chiffres, `_`, `-`.
 */
export function mergeNativeShareDiagnostics(entries: ReadonlyArray<{ t: number; c: string; s: string }>): number {
  if (entries.length === 0) return 0;
  const list = readShareImportJournal();
  const seen = new Set(list.filter((e) => e.c.startsWith('NATIVE_')).map((e) => `${e.t}|${e.c}`));
  let added = 0;
  for (const e of entries) {
    const c = `NATIVE_${e.c.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`.slice(0, 48);
    if (seen.has(`${e.t}|${c}`)) continue;
    seen.add(`${e.t}|${c}`);
    list.push({ t: e.t, c, d: sanitizeShareImportDetail({ src: e.s }) });
    added += 1;
  }
  if (added > 0) write(list.sort((a, b) => a.t - b.t));
  return added;
}

/** Dernier événement (code seul) — rappelé dans la carte d'état pour la recette. */
export function lastShareImportJournalCode(): string | null {
  const list = readShareImportJournal();
  return list.length ? list[list.length - 1].c : null;
}
