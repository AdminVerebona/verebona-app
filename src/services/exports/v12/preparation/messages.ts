/**
 * Messages obligatoires de l'écran de préparation — CDC V12 §5.4
 * (MSG-PREP-001 à 008), textes contractuels repris mot pour mot.
 *
 * Module PUR, partagé serveur (API prepare / estimate) et client (écran).
 */

export const PREP_MESSAGES = {
  /** Aucun élément utile (ALT-001). */
  'MSG-PREP-001': 'Aucun contenu complémentaire n’a été trouvé pour ce dossier. Vous pouvez compléter le bien ou ajouter des documents avant de générer.',
  /** Pièces ZIP + clic « Générer le PDF » (ALT-002). */
  'MSG-PREP-002': 'Certaines pièces sélectionnées ne seront pas incluses dans le PDF seul. Voulez-vous continuer sans elles ?',
  /** Document sensible (PREP-SENSITIVE). */
  'MSG-PREP-003': 'Sensible',
  /** Seuil documents PDF (§6.3). */
  'MSG-PREP-004': 'Trop de documents sont sélectionnés pour intégration PDF. Réduisez la sélection ou passez certaines pièces en ZIP.',
  /** Fichier indisponible (SEL-GEN-006, ALT-004). */
  'MSG-PREP-005': 'Un fichier sélectionné n’est plus disponible. Il sera exclu du dossier généré.',
  /** Échec de l'enregistrement automatique (IC-GEN-004). */
  'MSG-PREP-006': 'Les informations de préparation des dossiers n’ont pas pu être enregistrées. Réessayez avant de générer.',
  /** Génération partielle (ALT-004). */
  'MSG-PREP-007': 'Le dossier a été généré, mais certains fichiers n’ont pas pu être intégrés.',
  /** Génération longue. */
  'MSG-PREP-008': 'La génération peut prendre plus de temps en raison du volume de documents.',
} as const;

export type PrepMessageCode = keyof typeof PREP_MESSAGES;

export interface PrepMessage {
  code: PrepMessageCode;
  /** `info` : informatif ; `warning` : à lire avant de générer ; `blocking` : génération impossible. */
  level: 'info' | 'warning' | 'blocking';
  text: string;
}

export const prepMessage = (code: PrepMessageCode, level: PrepMessage['level'] = 'warning'): PrepMessage =>
  ({ code, level, text: PREP_MESSAGES[code] });
