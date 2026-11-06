/**
 * Journal technique du déverrouillage de l'application native — lot 111D
 * (anomalie #642 bis : écran « Déverrouiller Verebona » à la place de Face ID).
 *
 * Les 40 dernières décisions de la machine (`unlock-controller.ts`) sont
 * gardées dans le stockage local de la vue, y compris dans les binaires de
 * production (la console n'y est pas inspectable) : on peut ainsi établir,
 * après coup et sur l'appareil, POURQUOI un écran de secours a été affiché
 * (moyen lu, état enregistré, résultat de la fenêtre système, premier plan…).
 *
 * Lot 112E : le même journal reçoit le code `INSTALL_ID` (identifiant
 * d'installation chargé, créé ou différé — jamais sa valeur).
 *
 * Contenu : codes stables et valeurs courtes d'une liste FERMÉE de champs.
 * Jamais de donnée biométrique, d'empreinte d'enrôlement, d'identifiant de
 * compte, d'adresse, de jeton ni de chemin de page. Rien n'est envoyé au
 * serveur. Lecture : inspecteur Web (préproduction) ou
 * `localStorage.getItem('verebona:native:unlock-journal')`.
 */

export const UNLOCK_JOURNAL_KEY = 'verebona:native:unlock-journal';
export const UNLOCK_JOURNAL_MAX = 40;

/** Champs autorisés (liste fermée) : tout autre champ est ignoré. */
const ALLOWED_FIELDS = new Set([
  'from', 'to', 'event', 'session', 'foreground', 'reason', 'actions', 'mode', 'attempt', 'outcome',
  'biometry', 'whyNot', 'available', 'deviceSecure', 'stored', 'type', 'lockDue', 'enrollmentPlugin',
  'platform', 'appVersion', 'build', 'env', 'biometricPlugin', 'secureStoragePlugin', 'readError',
  // Lot 112E : code `INSTALL_ID` (identifiant d'installation chargé / créé / différé).
  'osStatus', 'protectedData',
]);

export interface UnlockJournalEntry {
  /** Instant (ms depuis l'époque). */
  t: number;
  /** Code stable (UNLOCK_BOOT, UNLOCK_PHASE, UNLOCK_METHOD, UNLOCK_PROMPT…). */
  c: string;
  d: Record<string, string | number | boolean | null>;
}

/** Détail réduit aux champs autorisés et aux valeurs simples et courtes (pur, testé). */
export function sanitizeUnlockDetail(detail: Record<string, unknown> | undefined): UnlockJournalEntry['d'] {
  const out: UnlockJournalEntry['d'] = {};
  if (!detail) return out;
  for (const [k, v] of Object.entries(detail)) {
    if (!ALLOWED_FIELDS.has(k)) continue;
    if (v === null || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && /^[A-Za-z0-9_.,: ()-]{0,48}$/.test(v)) out[k] = v;
  }
  return out;
}

export function readUnlockJournal(): UnlockJournalEntry[] {
  try {
    const raw = globalThis.localStorage?.getItem(UNLOCK_JOURNAL_KEY);
    const list = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(list) ? list.filter((e): e is UnlockJournalEntry => !!e && typeof e === 'object' && typeof (e as UnlockJournalEntry).c === 'string') : [];
  } catch {
    return [];
  }
}

export function appendUnlockJournal(code: string, detail?: Record<string, unknown>, now: number = Date.now()): void {
  if (!/^[A-Z0-9_]{1,40}$/.test(code)) return;
  try {
    const list = readUnlockJournal();
    list.push({ t: now, c: code, d: sanitizeUnlockDetail(detail) });
    globalThis.localStorage?.setItem(UNLOCK_JOURNAL_KEY, JSON.stringify(list.slice(-UNLOCK_JOURNAL_MAX)));
  } catch { /* stockage indisponible : journal facultatif */ }
}
