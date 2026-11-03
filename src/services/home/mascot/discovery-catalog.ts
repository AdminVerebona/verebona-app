/**
 * Lot 106B — catalogue ÉDITORIAL des invitations de découverte de l'accueil
 * (ticket « Mascotte — réparer les suggestions et ajouter des invitations de
 * découverte »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * À QUOI SERT CE CATALOGUE
 *
 * Une invitation de découverte propose d'AJOUTER un type de document des
 * biens Verebona (logement, véhicule, objet / équipement), avec son bénéfice
 * en une phrase. Ce n'est JAMAIS un constat personnel : aucune donnée du
 * compte n'y figure (pas de « votre voiture », pas de « il vous manque »).
 *
 * Source normale : T6 (prompt maître, contrat `t6-discovery-v1`, étape 13 du
 * guide du PO). Ce catalogue est le comportement SÛR, sans IA, quand T6 ne
 * peut pas les rédiger (prompt actif sans le contrat, IA indisponible ou en
 * erreur, compte vide sans contexte de questions, formulation en cours) :
 * les invitations restent disponibles sans traitement IA ni donnée
 * personnelle, et les questions personnalisées restent soumises à leur
 * propre contrat (`t6-suggestions-v3`).
 *
 * Les textes reprennent les références éditoriales de recette du ticket
 * (une liste d'exemples, pas des règles métier). Chaque entrée passe le
 * MÊME validateur que les invitations rédigées par T6
 * (`validateDiscoveryInvitation`, test L106B-U). Ajouter ou retirer une
 * entrée ne demande aucune autre modification ; garder les trois univers
 * équilibrés (rotation équitable, aucune surpondération du logement).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { MascotDiscoveryDocumentKind, MascotDiscoveryUniverse } from './types';

export interface DiscoveryCatalogEntry {
  universe: MascotDiscoveryUniverse;
  documentKind: MascotDiscoveryDocumentKind;
  text: string;
}

export const DISCOVERY_CATALOG: readonly DiscoveryCatalogEntry[] = [
  // ── Logement ───────────────────────────────────────────────────────────
  { universe: 'HOUSING', documentKind: 'INVOICE', text: 'Une facture de travaux ? Ajoutez-la pour retrouver les interventions, leur date et leur coût.' },
  { universe: 'HOUSING', documentKind: 'CONTRACT', text: 'Ajoutez un contrat d’assurance habitation pour retrouver les garanties et les échéances qu’il précise.' },
  { universe: 'HOUSING', documentKind: 'DIAGNOSTIC', text: 'Ajoutez un diagnostic du logement pour retrouver ses résultats et sa date.' },
  // ── Véhicules ──────────────────────────────────────────────────────────
  { universe: 'VEHICLE', documentKind: 'INVOICE', text: 'Ajoutez une facture d’entretien automobile pour retrouver les interventions et leur coût.' },
  { universe: 'VEHICLE', documentKind: 'DOCUMENT', text: 'Un vélo électrique ? Ajoutez sa facture pour conserver ses références et les informations d’achat.' },
  { universe: 'VEHICLE', documentKind: 'CONTRACT', text: 'Ajoutez un contrat d’assurance auto pour retrouver les garanties qu’il précise.' },
  // ── Objets / équipements ───────────────────────────────────────────────
  { universe: 'EQUIPMENT', documentKind: 'INVOICE', text: 'Ajoutez la facture d’un appareil pour retrouver son prix et sa date d’achat.' },
  { universe: 'EQUIPMENT', documentKind: 'NOTICE', text: 'Une notice d’équipement ? Ajoutez-la pour retrouver ses consignes et ses références.' },
  { universe: 'EQUIPMENT', documentKind: 'WARRANTY', text: 'Ajoutez un document de garantie pour retrouver sa durée et les conditions qu’il prévoit.' },
];
