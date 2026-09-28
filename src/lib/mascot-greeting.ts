/**
 * Salutation de la mascotte — CDC Mascotte UX-002 à UX-004, MIG-004.
 *
 * Déterministe et hors T6 : avant 18:00 « Bonjour », à partir de 18:00
 * « Bonsoir », à l'heure LOCALE du terminal. Le prénom est le nom affiché.
 */
export function greetingWord(now: Date = new Date()): 'Bonjour' | 'Bonsoir' {
  return now.getHours() < 18 ? 'Bonjour' : 'Bonsoir';
}

/** « vendredi 25 septembre 2026 » — date locale, format naturel français. */
export function formatGreetingDate(now: Date = new Date()): string {
  return now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Découpe un paragraphe autour du segment mis en valeur (T6-010) : le texte
 * reste lisible sans mise en forme, le segment est simplement renforcé.
 */
export function splitHighlight(text: string, highlight: string | null): Array<{ text: string; strong: boolean }> {
  if (!highlight) return [{ text, strong: false }];
  const i = text.indexOf(highlight);
  if (i === -1) return [{ text, strong: false }];
  return [
    { text: text.slice(0, i), strong: false },
    { text: highlight, strong: true },
    { text: text.slice(i + highlight.length), strong: false },
  ].filter((p) => p.text.length > 0);
}

const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const JOURS_COURTS = ['Dim.', 'Lun.', 'Mar.', 'Mer.', 'Jeu.', 'Ven.', 'Sam.'];
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const MOIS_COURTS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

/** Bulle desktop (Direction D v2 §3.2) : « Mercredi 23 septembre ». */
export function greetingDateLong(now: Date = new Date()): string {
  const j = JOURS[now.getDay()];
  return `${j.charAt(0).toUpperCase()}${j.slice(1)} ${now.getDate() === 1 ? '1er' : now.getDate()} ${MOIS[now.getMonth()]}`;
}

/** Bulle mobile (Direction D v2 §4.2) : « Mer. 23 sept. ». */
export function greetingDateShort(now: Date = new Date()): string {
  return `${JOURS_COURTS[now.getDay()]} ${now.getDate()} ${MOIS_COURTS[now.getMonth()]}`;
}
