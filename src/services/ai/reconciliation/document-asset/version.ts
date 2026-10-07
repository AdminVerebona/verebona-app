/**
 * Version MÉTIER du moteur T3 DOCUMENT_ASSET (lot 32C — ticket « Rattrapage
 * des documents déjà ABSTAINED / NO_CANDIDATE »).
 *
 * Une décision T3 n'est réutilisable que si les entrées pertinentes ET la
 * version du moteur sont toujours les mêmes. La version est persistée sur
 * chaque issue (`document_asset_resolutions.resolution_version`, migration
 * 0274) ; le rattrapage horaire rejoue une abstention produite par une
 * version antérieure (ou sans version : lignes historiques, NULL) à partir
 * des données T1 DÉJÀ persistées — jamais une nouvelle analyse T1.
 *
 * ── QUAND INCRÉMENTER ──────────────────────────────────────────────────────
 *
 * À chaque modification fonctionnelle qui peut changer la décision :
 *   · nouvel identifiant exploitable (`identifiers.ts`, `IDENTIFIER_KEYS`) ;
 *   · amélioration de normalisation (adresse, plaque, VIN, série…) ;
 *   · changement des règles déterministes (`decideDeterministic`) ou de
 *     décision après le modèle (`decideFromAiOutput`, seuils, marges) ;
 *   · évolution importante du prompt / de la relation DOCUMENT_ASSET.
 * Jamais le hash du commit : une version ne bouge que pour une raison métier,
 * consignée ci-dessous. Incrémenter rejoue PROGRESSIVEMENT (pages bornées du
 * balayage horaire, file durable) les abstentions encore sans bien — les
 * cas résolubles en déterministe sont rattachés sans appel modèle, les vrais
 * cas ambigus repassent UNE fois par le modèle avec la nouvelle version.
 *
 * Historique :
 *   · 1 (implicite, NULL en base) — lot 31B : première version de T3
 *     DOCUMENT_ASSET ;
 *   · 2 — lot 32C : version persistée ; correspondance d'adresse côté
 *     serveur (`address1` normalisé) appliquée au rattrapage des anciennes
 *     abstentions ; invalidation par les identifiants canoniques des biens.
 */
export const DOCUMENT_ASSET_RESOLUTION_VERSION = 2;
