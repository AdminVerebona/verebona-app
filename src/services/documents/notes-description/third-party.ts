/**
 * « Notes / Description » et sorties destinées à des TIERS — lot 113Z
 * (Trello #723, §3.D). Module PUR.
 *
 * Règle : dans un dossier destiné à un tiers (vente, location, assurance…) et
 * dans une transmission à un tiers, le contenu affiché dans « Notes /
 * Description » est EXCLU PAR DÉFAUT, qu'il vienne de T1 ou de l'utilisateur.
 * Il n'est inclus qu'après une action explicite (option décochée par défaut),
 * et alors c'est le texte AFFICHÉ (et lui seul) qui part — jamais la note ET
 * une description masquée, jamais une description effacée par l'utilisateur.
 * Les exports personnels (données brutes, RGPD, diagnostic) ne sont pas
 * concernés.
 */
import { resolveNotesDescription, type NotesDescriptionRecord } from '@/lib/documents/notes-description';

/** Inclusion par défaut dans une sortie tiers : NON (ticket #723). */
export const THIRD_PARTY_NOTES_DESCRIPTION_DEFAULT = false as const;

/** Libellé de l'option d'inclusion (à valider par le PO). */
export const THIRD_PARTY_NOTES_DESCRIPTION_OPTION_LABEL = 'Inclure « Notes / Description » des documents';

export interface ThirdPartyNotesDescription {
  notes: string | null;
  description: string | null;
  notesUserOwned: boolean;
  descriptionSource: 'T1' | null;
}

/** Valeurs à copier vers le tiers pour un document. Pure. */
export function notesDescriptionForThirdParty(doc: NotesDescriptionRecord, include: boolean | null | undefined): ThirdPartyNotesDescription {
  const rien: ThirdPartyNotesDescription = { notes: null, description: null, notesUserOwned: false, descriptionSource: null };
  if (include !== true) return rien;
  const v = resolveNotesDescription(doc);
  if (!v.text) return rien;
  if (v.fromNotes) return { notes: v.text, description: null, notesUserOwned: true, descriptionSource: null };
  return { notes: null, description: v.text, notesUserOwned: false, descriptionSource: v.origin === 'AI' ? 'T1' : null };
}
