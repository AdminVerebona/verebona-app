/**
 * Sections de l'écran de préparation, par dossier — CDC V12 §5.2
 * (PREP-SECTIONS), §22.2 (PREP-NAV-*), §6.2 (sections optionnelles et
 * leurs défauts).
 *
 * Une section de l'écran = une section du PDF, avec le MÊME titre que les
 * templates validés (`templates/*.ts`) : ce que l'utilisateur coche ici est
 * ce qu'il retrouvera, dans cet ordre, dans le dossier.
 *
 *   · `required`  : section toujours présente (verrouillée, PREP-NAV-012) ;
 *   · `toggle`    : clé de `DEFAULT_SECTIONS` (section décochable) ;
 *   · `items`     : pièces proposées dans la section (documents, photos,
 *                   événements du suivi / de l'agenda) ;
 *   · formulaire « Informations complémentaires » (PREP-INFOFORM,
 *     IC-GEN-003) : affiché dans la section hôte de chaque sous-rubrique lue
 *     par le dossier (`INFO_HOST_SECTION`, `DOSSIER_ADDITIONAL_SECTIONS`) ;
 *   · `cil`       : état des blocs B1 à B9 (§20) et actions pour les compléter.
 *
 * L'index des annexes et la liste « Documents joints au ZIP » ne sont pas
 * des sections de l'écran : ils découlent des modes PDF / ZIP choisis.
 *
 * Module PUR, partagé serveur et client.
 */

import type { DossierCode } from '@/services/exports/catalog';

export type PrepItemType = 'document' | 'photo' | 'event';

export interface PrepSectionDef {
  id: string;
  label: string;
  description: string;
  required: boolean;
  toggle?: string;
  items?: PrepItemType;
  cil?: boolean;
  /** Contenu décrit par les informations complémentaires (pas d'élément à cocher). */
  fedBy?: string;
  /**
   * Description en source canonique (X-02 lot 16, seule source depuis le
   * lot 16b-3) ; à défaut, `description`.
   */
  descriptionCanonical?: string;
}

const COVER = (description: string): PrepSectionDef => ({ id: 'cover', label: 'Couverture', description, required: true });

export const PREP_SECTIONS: Readonly<Record<DossierCode, readonly PrepSectionDef[]>> = {
  CIL: [
    COVER('Nom du logement, adresse et date d’édition.'),
    { id: 'cil', label: 'État des informations disponibles', description: 'Statut des blocs B1 à B9. Les blocs B1, B3 et B8 conditionnent la génération.', required: true, cil: true },
    { id: 'documents', label: 'Documents annexes', description: 'Plans, schémas des réseaux, DPE et diagnostics, rattachés à leur bloc du carnet.', required: false, toggle: 'documents', items: 'document' },
    { id: 'references', label: 'Références, méthode et limites', description: 'État des informations disponibles dans Verebona à la date de génération ; ce n’est pas une certification.', required: true },
  ],
  DOSSIER_COMPLET: [
    COVER('Nom du bien, catégorie et date d’édition.'),
    { id: 'summary', label: 'Synthèse du dossier', description: 'Résumé du bien, statut et état déclaré.', required: true },
    { id: 'info', label: 'Informations principales', description: 'Caractéristiques de la fiche du bien ; les champs vides sont masqués.', required: true },
    { id: 'finance', label: 'Valeur, acquisition et informations financières', description: 'Prix d’acquisition, valeur retenue, frais, charges et taxes saisis. Non inclus par défaut.', required: false, toggle: 'finance', fedBy: 'Prix d’acquisition de la fiche, valeur et charges saisies ci-dessous, coûts des événements.' },
    { id: 'history', label: 'Historique d’entretien', description: 'Section « Calendrier et historique d’entretien » : événements réalisés.', required: false, toggle: 'history', items: 'event' },
    { id: 'deadlines', label: 'Échéances à venir', description: 'Section « Calendrier et historique d’entretien » : prochaines échéances de l’agenda.', descriptionCanonical: 'Section « Calendrier et historique d’entretien » : prochaines échéances de l’agenda et échéances passées à confirmer.', required: false, toggle: 'deadlines', items: 'event' },
    { id: 'contracts', label: 'Garanties et contrats utiles', description: 'Garantie et assurance en cours, telles que saisies dans la fiche.', required: false, toggle: 'contracts' },
    { id: 'documents', label: 'Documents clés', description: 'Factures, garanties, contrats et autres pièces du bien.', required: false, toggle: 'documents', items: 'document' },
    { id: 'photos', label: 'Photos du bien', description: 'De 6 à 8 photos recommandées, choisies une par une.', required: false, toggle: 'photos', items: 'photo' },
    { id: 'references', label: 'Méthode, sources et limites', description: 'Sources des informations et limites du dossier.', required: true },
  ],
  VENTE: [
    COVER('Photo principale, nom du bien et disponibilité.'),
    { id: 'summary', label: 'Synthèse de mise en vente', description: 'Présentation factuelle du bien.', required: true },
    { id: 'info', label: 'Informations principales', description: 'Caractéristiques de la fiche du bien ; les champs vides sont masqués.', required: true },
    { id: 'conditions', label: 'Conditions de vente', description: 'Prix souhaité, disponibilité, modalités de visite. Jamais l’estimation Verebona.', required: true },
    { id: 'highlights', label: 'Mise en valeur du bien', description: 'Points forts documentés du bien.', required: false, toggle: 'highlights', fedBy: 'Points forts choisis dans les conditions de vente (4 au plus) ; sans choix, faits documentés du bien.' },
    { id: 'photos', label: 'Photos', description: 'De 3 à 4 photos recommandées, choisies une par une.', required: false, toggle: 'photos', items: 'photo' },
    { id: 'followUp', label: 'Éléments de suivi', description: 'Entretiens et travaux valorisants. Proposés non cochés.', required: false, toggle: 'followUp', items: 'event' },
    { id: 'documents', label: 'Documents utiles à la vente', description: 'Proposés non cochés : cochez ceux à transmettre à l’acheteur.', required: false, toggle: 'documents', items: 'document' },
    { id: 'references', label: 'Sources et limites', description: 'Sources des informations et limites du kit.', required: true },
  ],
  LOCATION: [
    COVER('Photo principale, nom du logement et disponibilité.'),
    { id: 'summary', label: 'Synthèse locative', description: 'Présentation factuelle du logement.', required: true },
    { id: 'info', label: 'Informations principales', description: 'Caractéristiques de la fiche du bien ; jamais de données d’occupant.', required: true },
    { id: 'conditions', label: 'Conditions de location', description: 'Loyer, charges, dépôt de garantie, type de bail : saisie manuelle uniquement.', required: true },
    { id: 'equipments', label: 'Équipements et diagnostics utiles', description: 'Équipements du logement et performance énergétique.', required: false, toggle: 'equipments', fedBy: 'Équipements de la fiche et classes DPE / GES.' },
    { id: 'photos', label: 'Photos', description: 'De 3 à 4 photos recommandées, choisies une par une.', required: false, toggle: 'photos', items: 'photo' },
    { id: 'followUp', label: 'Éléments de suivi', description: 'Entretiens et travaux rassurants. Proposés non cochés.', required: false, toggle: 'followUp', items: 'event' },
    { id: 'documents', label: 'Documents utiles à la location', description: 'Proposés non cochés ; les pièces d’un ancien locataire ne sont jamais proposées.', required: false, toggle: 'documents', items: 'document' },
    { id: 'references', label: 'Sources et limites', description: 'Sources des informations et limites du dossier.', required: true },
  ],
  ASSURANCE_SOUSCRIPTION: [
    COVER('Nom du bien, objectif de la demande et date d’édition.'),
    { id: 'summary', label: 'Synthèse assurance', description: 'Objectif de la demande et résumé du bien.', required: true },
    { id: 'info', label: 'Informations principales', description: 'Caractéristiques de la fiche du bien ; les champs vides sont masqués.', required: true },
    { id: 'value', label: 'Valeur et éléments à assurer', description: 'Valeur à assurer, montant souhaité, garanties : saisie manuelle, distincte de l’estimation.', required: true },
    { id: 'protections', label: 'Équipements et protections', description: 'Protections et équipements de sécurité du bien.', required: false, toggle: 'protections', fedBy: 'Protections détaillées saisies ci-dessus ; à défaut, éléments particuliers et équipements de la fiche.' },
    { id: 'condition', label: 'État et entretien utile', description: 'Entretiens réalisés qui attestent de l’état du bien.', required: false, toggle: 'condition', items: 'event' },
    { id: 'documents', label: 'Justificatifs de valeur', description: 'Factures, garanties et expertises ; attestations d’assurance proposées non cochées.', required: false, toggle: 'documents', items: 'document' },
    { id: 'photos', label: 'Photos', description: 'Photos utiles à l’assureur, choisies une par une.', required: false, toggle: 'photos', items: 'photo' },
    { id: 'references', label: 'Sources et limites', description: 'Sources des informations et limites du dossier.', required: true },
  ],
  ASSURANCE_SINISTRE: [
    COVER('Nom du bien, type et date du sinistre.'),
    { id: 'summary', label: 'Synthèse du sinistre', description: 'Type, date, références et circonstances du sinistre.', required: true },
    { id: 'timeline', label: 'Chronologie', description: 'Événements datés ; ceux liés au sinistre sont pré-cochés.', required: false, toggle: 'timeline', items: 'event' },
    { id: 'damages', label: 'Dommages et éléments concernés', description: 'Dommages constatés, saisis dans les informations du sinistre.', required: false, toggle: 'damages', fedBy: 'Dommages saisis dans la synthèse du sinistre, avec leurs photos et pièces.' },
    { id: 'photos', label: 'Photos du sinistre', description: 'De 6 à 8 photos prises depuis la date du sinistre, choisies une par une.', required: false, toggle: 'photos', items: 'photo' },
    { id: 'actions', label: 'Actions déjà réalisées', description: 'Mesures conservatoires et interventions.', required: false, toggle: 'actions', fedBy: 'Actions et mesures saisies dans la synthèse du sinistre.' },
    { id: 'documents', label: 'Devis, factures et rapports', description: 'Pièces liées au sinistre pré-cochées ; les autres sont proposées.', required: false, toggle: 'documents', items: 'document' },
    { id: 'exchanges', label: 'Échanges avec l’assureur et l’expert', description: 'Correspondances et échanges saisis.', required: false, toggle: 'exchanges', fedBy: 'Échanges saisis dans la synthèse du sinistre et courriers de l’assureur.' },
    { id: 'references', label: 'Sources et limites', description: 'Sources des informations et limites du dossier.', required: true },
  ],
};

/**
 * Section de l'écran qui accueille le formulaire d'une sous-rubrique des
 * informations complémentaires (les sous-rubriques d'un dossier sont celles
 * de `DOSSIER_ADDITIONAL_SECTIONS`).
 */
export const INFO_HOST_SECTION: Readonly<Record<string, string>> = {
  commercial: 'conditions',
  rental: 'conditions',
  insurance: 'value',
  claim: 'summary',
  finance: 'finance',
};
