/**
 * Salutation de la mascotte — CDC Mascotte UX-002 à UX-004, MIG-004.
 *
 * Déterministe et hors T6 : avant 18:00 « Bonjour », à partir de 18:00
 * « Bonsoir », à l'heure LOCALE du terminal. Le prénom est le nom affiché.
 */
export function greetingWord(now: Date = new Date()): 'Bonjour' | 'Bonsoir' {
  return now.getHours() < 18 ? 'Bonjour' : 'Bonsoir';
}

const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** Bulle desktop (Direction D v2 §3.2) : « Mercredi 23 septembre ». */
export function greetingDateLong(now: Date = new Date()): string {
  const j = JOURS[now.getDay()];
  return `${j.charAt(0).toUpperCase()}${j.slice(1)} ${now.getDate() === 1 ? '1er' : now.getDate()} ${MOIS[now.getMonth()]}`;
}
