# Matrice CIL — donnée par donnée (v3, lot 112F, 06/11/2026 ; v2 : lot 111U deuxième passe, 05/11/2026 — validée par le PO le 06/11)

Version code : `src/lib/cil/cil-catalog.ts` (mêmes identifiants, même ordre). Toute évolution modifie les deux.

**Avertissement.** Les textes de référence sont cités **par référence seulement** (Code de la construction et de l'habitation, articles L126-35-2 à L126-35-11 et R126-32 à R126-34 ; arrêté du 27 décembre 2022 ; fiche Service-Public « Carnet d'information du logement », vérifiée le 26/05/2026). La **catégorie** indiquée est un **classement produit** proposé pour la recette, **à valider par le PO** ; elle ne vaut ni avis juridique ni certification. Le PDF généré l'indique déjà : « Ce document n'est pas un carnet certifié ni une validation réglementaire ».

## 0. Règles communes

| Sujet | Règle |
|---|---|
| Catégories | `OBLIGATOIRE` (attendu dans tous les cas), `CONDITIONNEL` (attendu selon le contexte ou l'installation), `COMPLEMENT` (information proposée par Verebona, comptée à part). |
| Avancement réglementaire | OBLIGATOIRE + CONDITIONNEL applicables. Renseigné = 1, partiel = ½. Non applicable et présence « à confirmer » : hors dénominateur, jamais au numérateur (`cilProgress`, test L111U-U-PROGRESS). |
| Couverture complémentaire | Même formule sur les seules données COMPLEMENT, affichée séparément. |
| Statuts | renseigné · partiel (les seules données manquantes listées) · manquant · à confirmer (présence inconnue, contradiction, ambiguïté) · non applicable (déclaration utilisateur ou règle sur profil CIL validé). |
| Pastille de bloc (préparation, PDF) — lot 112A | `lib/cil/cil-block-pill.ts`, une seule règle : statut de bloc de la préparation (présence, B6 75A, blocage CIL-RULE-002) + statut granulaire du bloc dans l'état commun. Renseigné (état renseigné) · **Partiel** (bloc documenté, état partiel ou à confirmer ; manques réglementaires cités dans la source du PDF) · À compléter (aucun élément, ou état manquant) · Manquant (bloquant B1/B3/B8) · Non applicable (déclaration effective, justification au PDF). Libellés texte identiques (impression N&B), tons du moteur V12. Tests L112A-U-*, L112A-E2E-01/02/03. |
| Non applicable | Bloc (B3-B7, B9 : règle existante) ou donnée autorisée (`naAllowed`). Refusé pour B1, B8 (400) et pour une donnée renseignée ou partielle (409 `CIL_ITEM_DATA_PRESENT`). B6 : règle 75A conservée. |
| Jamais déduit | Absence de gaz (chauffage électrique ≠ pas de gaz), fin de validité du DPE, réalisation de travaux à partir d'une recommandation, existence d'un plan à partir d'un descriptif DPE, exigibilité RE2020 sans profil. |
| Périmètre documentaire | `documentInAssetsCondition` : `asset_id`, `linked_asset_id`, liens N-N ACTIFS PRIMARY / SECONDARY ; un bien seulement CITÉ (MENTIONED) exclu. Documents ouverts : non supprimés, non regroupés, dépôt terminé, ni brouillon ni ignorés ; liens web exclus (comme les pièces du PDF). |
| Classement | `documentKind` (v12) : `document_type_code` V2 d'abord, puis codes V1 (`retained_function_code`, `document_type`) via le résolveur unique, puis rubriques CIL (`cil_rubric_codes`). |
| Source de vérité | Service commun `src/services/cil/state` (`loadCilStateInput` + `evaluateCilState`). Lecteurs : onglet Informations (`/api/assets/[id]/cil-checklist`), préparation et blocage (`evaluateCilReadiness` → `readinessFromCilInput`), mappeur PDF (`readiness.state`), contrôle COH-CIL-DOCUMENT-PROJECTION. |
| T1 | Faits persistés `document_facts` (clé canonique ou connaissance générique sujet / attribut / valeur / unité, preuve page / extrait / unités source, confiance, cible). Non projetés : conservés (`document_facts`, `document_unresolved_facts`). |
| T3 registre | Champs du bien : moteur T3 existant (`reconcileAsset` → `applyDecision` → `writeCanonicalAssetField`), autorité des preuves, protections USER / ADMIN. |
| T3 CIL | `projectCilDocumentsForAsset` (même travail T3, après le moteur) : faits des documents de nature DPE / AUDIT_ENERGETIQUE / ENERGIE_TECHNIQUE → `energy_materials`, `equipments` + `equipment_cil_specs`. Déterministe, idempotent (empreinte + `cil_projection_journal`), verrou par bien, USER / ADMIN protégés, le plus récent fait foi, même date divergente = CONFLICT, recommandation = `RECOMMENDATION_ONLY`. **Lot 112F** : pièces PROBANTES (facture, rapport / attestation) des Opérations INTERVENTION réalisées et prouvées → matériaux / équipements **posés** (`projectInstalled`, clés `cil:inst:<opération>:<poste>`, `cil:insteq:<opération>:<usage>`). |
| Déclencheurs | Passage T3 du bien (`reconcileAsset` : analyse, rattachement tardif, relance) ; **lot 112F** : toute écriture d'une Opération (création, réalisation, justificatif ajouté / dissocié, invalidation, fusion, changement de bien) → bus des Opérations → relais existant `coherence/events.ts` (`BUSINESS_OPERATION_CHANGED`) → demande durable du contrôle ciblé `COH-CIL-DOCUMENT-PROJECTION` (v3) sur les biens de l'Opération (liens actifs ou non) et ceux qui portent une décision CIL pour elle → passage ciblé de la tâche `coherence-control` (temporisation des rafales) ; campagne quotidienne. Aucune nouvelle file, aucun cron parallèle. Écriture selon le mode du contrôle de cohérence (correctif ; à blanc = « réparerait »). |

## 1. B1 — Identification du logement (bloquant : adresse, CP, commune)

| Id | Ligne PDF | Nature / cible | Type | Catégorie | Applicabilité | BDD | Sources / T1 | Contrat T3 | Informations / PDF | Statut / tests |
|---|---|---|---|---|---|---|---|---|---|---|
| B1.address | Adresse | bien | texte | OBLIGATOIRE | toujours | `assets.address` | saisie ; acte, facture (rattachement) | saisie fiche (pas d'écriture CIL) | valeur + « Fiche du bien » ; PDF `asset.location` | renseigné / manquant (bloquant) — L111U-U-READINESS, exports-bugfixes §5 |
| B1.postalCode | Code postal | bien | texte | OBLIGATOIRE | toujours | `assets.postal_code` | idem | idem | idem | idem |
| B1.city | Commune | bien | texte | OBLIGATOIRE | toujours | `assets.city` | idem | idem | idem | idem |
| B1.nature | Type de logement | bien | texte | COMPLEMENT | toujours | `assets.subtype` | saisie | — | PDF `typeLabel` | renseigné / manquant |
| B1.livingArea | Surface habitable | bien | m² | COMPLEMENT | toujours | `key_characteristics.livingArea` | acte, DPE (surface de référence) | registre T3 : autorité des preuves ; une mesure DPE ne remplace pas l'acte sans arbitrage (preuves conservées) | valeur + document preuve (`field_evidence`) ; PDF `livingAreaSqm` | renseigné / manquant |
| B1.constructionYear | Année de construction | bien | entier | COMPLEMENT | toujours | `key_characteristics.constructionYear` | acte, DPE | registre T3 | idem ; PDF `constructionYear` | renseigné / manquant |

## 2. B2 — Contexte de constitution

| Id | Ligne PDF | BDD | Sources | Contrat | Statut |
|---|---|---|---|---|---|
| B2.trigger | Motif + date | `asset_cil_profiles.trigger_type` (construction / renovation_energetique / volontaire / inconnu), `trigger_date`, `authorization_type`, `voluntary_reason` **+ migration 1301** `origin` (USER / ADMIN / DOCUMENT), `source_file_id`, `evidence` | saisie (onglet Informations, formulaire B2 ; route `cil-profile` → origine USER) ; **fait EXPLICITE d'un document** (`recognizeCilContextFact`) : sujet « Carnet d'information du logement » + attribut motif / date de constitution ; sujet « Permis de construire » / « Déclaration préalable » → autorisation, et motif « construction » seulement si l'objet déclaré des travaux est une construction | projection T3 CIL (`cil:profile`) : profil USER / ADMIN jamais modifié (PROTECTED, `USER_VALUE_DIFFERS`) ; documents divergents → CONFLICT (rien d'écrit, « à confirmer ») ; plus de source → profil DOCUMENT retiré ; un permis ne date jamais la constitution ; une recommandation / un projet n'établit rien ; aucun motif déduit de travaux réalisés | COMPLEMENT ; renseigné (motif + date), partiel (motif sans date), à confirmer (contradiction), manquant (à saisir). Pilote IF_CONSTRUCTION / IF_RENOVATION. Tests L111U-U-B2, L111U-E2E-06 |

## 3. B3 — Plans et coupes (bloquant : plans, sauf « non applicable »)

| Id | Ligne PDF | BDD | Sources admissibles | Contrat | Statut / tests |
|---|---|---|---|---|---|
| B3.plans | Plans de surface et coupes | `asset_files` (V2 `WORKS_PLAN`, `ASSET_REFERENCE_PLAN` ; V1 `PLAN_CONSTRUCTION`), `document_cil_metadata.cil_category` | plans déposés | rattachement documentaire seulement ; **un DPE ne remplace jamais un plan** | CONDITIONNEL, bloquant ; renseigné si ≥ 1 plan |
| B3.planState | État conception / exécution | `document_cil_metadata.plan_state` | saisie sur le document | saisie | COMPLEMENT ; partiel si un plan sans état |

## 4. B4 — Réseaux

| Id | BDD | Sources | Règle | Statut |
|---|---|---|---|---|
| B4.eau / B4.electricite / B4.aeration | `asset_files` codes `RESEAU_EAU`, `RESEAU_ELECTRICITE`, `RESEAU_AERATION` (codes, rubriques) | schémas, plans de réseaux | un descriptif DPE n'atteste pas un plan | CONDITIONNEL ; renseigné / manquant / N/A déclaré |
| B4.gaz | `RESEAU_GAZ` | idem | IF_PRESENT : présence connue seulement par une donnée positive (équipement d'énergie « gaz », champ `mainEnergy` / `heatingType` contenant « gaz ») ; sinon **à confirmer** hors dénominateur ; jamais N/A déduit | CONDITIONNEL — L111U-U-STATE (gaz), L111U-E2E-01 |

## 5. B5 — Matériaux à incidence énergétique

BDD : `energy_materials` (category ∈ toiture, murs_exterieurs, parois_vitrees, planchers_bas ; material_nature, brand, reference, thermal_resistance_r, lambda, thickness_mm, surface_sqm, document_id) **+ migration 1300** : `origin` (USER / ADMIN / DOCUMENT), `installation_state` (constate / installe / prevu), `source_file_id`, `projection_key`, `evidence` (faits, page) **+ migration 1430 (112F)** : `installed_at` (date de pose), `operation_id` (Opération INTERVENTION réalisée et prouvée, même identité que B7).

| Id | Ligne PDF | Sources T1 (vocabulaire `cil-fact-vocabulary.ts`) | Contrat T3 CIL | Informations / PDF | Statut / tests |
|---|---|---|---|---|---|
| B5.toiture | Toiture / combles | faits génériques sujet en tête « toiture, combles, rampants, plafond, plancher haut… » ; attribut isolant / matériau / épaisseur (mm, cm, m) / résistance thermique (m²·K/W) / λ / surface ; documents DPE, audit, technique énergie | une ligne DOCUMENT par poste (`cil:mat:<poste>`), état « constaté » ; USER présente → PROTECTED (journal `USER_VALUE_DIFFERS` si divergente) ; supprimée par l'utilisateur → non recréée (`USER_REMOVED`) ; plusieurs valeurs dans un document → AMBIGUOUS ; deux sources même date divergentes → CONFLICT (valeur déjà prouvée conservée, « à confirmer ») ; plus de source → ligne DOCUMENT retirée | valeurs + « Voir le document » ; PDF `materials` (source « DPE du … ») ; manques cités dans la source du bloc | CONDITIONNEL ; renseigné = nature + (R, épaisseur ou λ) ; partiel sinon — L111U-U-VOCAB, L111U-E2E-01/03/04 |
| B5.murs_exterieurs | Murs extérieurs | sujet « murs, façade, parois opaques… » | idem | idem | idem |
| B5.parois_vitrees | Parois vitrées et portes | sujet « menuiseries, fenêtres, vitrages, portes… » ; attribut type de vitrage → nature | idem | idem | idem (souvent partiel : U non représenté) |
| B5.planchers_bas | Planchers bas | sujet « plancher bas, dalle, vide sanitaire… » | idem ; **sans description : rien n'est créé** (AC09) | idem | idem — L111U-E2E-01 |

**Matériaux posés (lot 112F).** Sources : pièces de rôle INVOICE ou REPORT (`business_operation_sources` actives, document ouvert) d'une Opération INTERVENTION **REALIZED** qualifiée B7 (`cil:work:<op>` WRITTEN). Faits : même vocabulaire que ci-dessus (un fait « devis / projet / recommandation » est écarté). Contrat : une ligne DOCUMENT par Opération et poste (`cil:inst:<op>:<poste>`), `installation_state = installe`, `installed_at` = date de réalisation de l'Opération, `operation_id`, `source_file_id` = la facture (sinon l'attestation), performances prouvées (R, λ, U, épaisseur, surface) ; facture et attestation divergentes → CONFLICT (rien d'écrit, « à confirmer ») ; plusieurs valeurs dans une pièce → AMBIGUOUS ; ligne USER / ADMIN du poste → PROTECTED ; ligne posée supprimée par l'utilisateur → non recréée (USER_REMOVED) ; Opération plus prouvée (invalidée, fusionnée, détachée, justificatif dissocié, redevenue envisagée) ou poste plus décrit → ligne retirée (RETRACTED). Un devis, un bon de commande, une Opération envisagée : jamais « posé ». Aucune ligne `energy_works`. Statut : renseigné = nature + performance ; **partiel si la date de pose manque** (attestation sans date) ; posés affichés avant les constats de diagnostic, « (posé le …) ». Tests L112F-U-INST, L112F-U-STATE, L112F-E2E-01/02/03.

Coefficient **U** (Uw, Ud, Up, « coefficient U ») : **migration 1301** `energy_materials.u_value` (W/(m²·K), 0 < U < 20), écrit par la projection, compté comme performance (renseigné = nature + R, U, épaisseur ou λ), imprimé « U = x W/(m²·K) » ; **jamais converti en R** (ni l'inverse). Migration absente : U reste dans les faits (lacune comptée). Tests L111U-U-U, L111U-E2E-06. Aucune autre performance sans emplacement identifiée (facteur solaire, perméabilité : non lus — à ouvrir si la recette en montre le besoin).

## 6. B6 — Équipements à incidence énergétique

BDD : `equipments` (type, category, energy_usage), `equipment_cil_specs` (energy_type, evacuation_mode, power_kw, brand, model, serial_number, energy_label, heat_network_delivery_station) **+ migration 1300** `field_origins` (origine par champ ; renseigné sans origine = USER ; **`WORKS` = écrit depuis une facture de pose, lot 112F**) **+ migration 1430** `installed_at`, `installation_operation_id`. Classification : `classifyCilEnergyEquipment` (lots 69 / 70B / 75A : usage déclaré, catégorie, type en tête, caractéristiques CIL ; **aucun repli « tous les équipements »**).

| Id | Sources T1 | Contrat T3 CIL | Statut |
|---|---|---|---|
| B6.chauffage | sujet « chauffage, générateur, chaudière, pompe à chaleur… » ; attribut type / énergie / puissance (kW, W) / marque / modèle ; clé canonique `heatingType` (type) | cible : équipement désigné par le fait (EQUIPMENT + id vérifié), sinon celui créé auparavant, sinon l'unique équipement de l'usage ; aucun → **création** (nom = type décrit, `category` = usage, `key_characteristics.__cilProjection`) si type ou énergie décrit ; plusieurs → AMBIGUOUS ; enrichissement des champs VIDES ou DOCUMENT seulement ; équipement créé dont la source disparaît → `SOURCE_REMOVED` (jamais supprimé) ; scénario / recommandation (« PAC après travaux ») jamais créé | CONDITIONNEL ; renseigné si équipement + énergie ; partiel sans énergie — L111U-E2E-01/04 |
| B6.ecs | sujet « eau chaude sanitaire, ECS, chauffe-eau, ballon… » | idem | idem |
| B6.ventilation | sujet « ventilation, VMC » | idem | CONDITIONNEL ; renseigné si équipement |
| B6.refroidissement | sujet « climatisation, refroidissement » | idem | IF_PRESENT : à confirmer hors dénominateur sans donnée |
| B6.enr | sujet « panneaux solaires, photovoltaïque, énergie renouvelable » | idem | IF_PRESENT |

**Équipement posé (lot 112F)** — clé `cil:insteq:<op>:<usage>`, mêmes sources que les matériaux posés. Cible : l'équipement de l'usage **rattaché à l'Opération** (`business_operation_equipment_links` actif ; plusieurs → AMBIGUOUS), sinon celui déjà retenu pour cette Opération, sinon un équipement existant de **même marque et modèle** ; un autre équipement du même usage sans preuve d'identité → AMBIGUOUS `EXISTING_EQUIPMENT_FOR_USAGE` (« précisez s'il remplace l'équipement existant », rien n'est créé ni archivé) ; aucun équipement de l'usage → création (`key_characteristics.__cilProjection`, origines `WORKS`) si type ou énergie décrit. Complément des champs vides ou `WORKS` seulement (USER et valeur d'un diagnostic protégées → `PARTIAL_USER_PROTECTED`) ; `installed_at` / `installation_operation_id` posés si vides ou déjà de cette Opération. Opération plus prouvée : date de pose effacée, équipement créé jamais supprimé (SOURCE_REMOVED). La projection diagnostic n'enrichit pas un équipement posé APRÈS la date du diagnostic. Statut B6 : « posé le … » ; partiel si la date de pose manque ; à confirmer si remplacement non prouvé. L'Opération n'est jamais modifiée (aucun lien créé).

Notice, mode d'emploi, entretien d'un équipement : rattachement document ↔ équipement existant (lot 71A `syncDocumentEquipmentLinks`) ; une notice alimente l'équipement, jamais le bien (entity-state, lot 18).

## 7. B7 — Travaux de rénovation énergétique réalisés

| Id | BDD | Sources | Contrat | Statut |
|---|---|---|---|---|
| B7.works | **Opérations existantes** `business_operations` type INTERVENTION (identité économique unique : statut, date de réalisation, intervenant) + `business_operation_sources` (rôle), `business_operation_documents`, `business_operation_equipment_links` ; `energy_works` (saisies historiques) lu en plus | facture de travaux (rôle INVOICE), rapport / attestation d'intervention (rôle REPORT) ; nature énergétique établie par un équipement à incidence énergétique lié à l'Opération ou par les faits d'un de ses documents (vocabulaire B5 / B6, recommandations exclues) | projection T3 CIL (`cil:work:<opération>`) : **qualifie** l'Opération sans l'écrire ni créer de ligne `energy_works` (pas de double identité) ; REALIZED + facture / attestation → WRITTEN ; ENVISAGED (devis, projet) → ABSTAINED `NOT_REALIZED` ; REALIZED sans facture ni attestation (commande, paiement seuls) → ABSTAINED `REALIZATION_NOT_PROVEN` ; intervention sans incidence énergétique → hors B7 ; Opération invalidée / fusionnée / détachée → RETRACTED. Recommandations d'un diagnostic → `RECOMMENDATION_ONLY`. Acquisition (111S) : jamais lue ici (type INTERVENTION seulement). **Lot 112F** : la même Opération porte les matériaux / équipements posés (B5 / B6, `operation_id`) — une seule identité, aucune copie `energy_works` (décision PO du 06/11) ; mise à jour déclenchée par les écritures d'Opérations (contrôle ciblé) | IF_RENOVATION : manquant si profil « rénovation énergétique » sans travaux ; sinon à confirmer hors dénominateur ; partiel si date de réalisation manquante ; source = la facture ouvrable ; PDF `works` = même liste (saisis + Opérations). Tests L111U-U-B7, L111U-E2E-05 |

## 8. B8 — Performance énergétique et justificatifs (bloquant : DPE)

| Id | Ligne PDF | BDD | Sources T1 | Contrat T3 | Statut |
|---|---|---|---|---|---|
| B8.dpeDocument | DPE (pièce) | `asset_files` V2 `DPE` (V1 `DPE`, ancien `PEB`) | classement T1 | rattachement ; plusieurs DPE : le plus récent fait foi, les autres consultables (notice) | OBLIGATOIRE, bloquant |
| B8.dpeClass | Classe énergie | `key_characteristics.dpeClass` (A-G) | clé canonique | registre T3 | CONDITIONNEL (IF_DPE) ; valeur + document + page |
| B8.gesClass | Classe climat | `gesClass` | idem | idem | idem |
| B8.dpeDate | Date | `dpeDate` (événement HISTORICAL) | idem | idem + T4 | idem |
| B8.energyConsumption | Consommation | `energyConsumption` (kWh/m²/an) | idem | idem | COMPLEMENT |
| B8.gesEmissions | Émissions | **`gesEmissions` (kg CO2/m²/an) — ajouté au registre au lot 111U** (alias `dpeEmissions`…) ; transmis à T1 par le FIELD_CATALOG (données, aucun texte de prompt modifié) | idem | idem | COMPLEMENT |
| B8.dpeAdemeNumber | N° ADEME | `dpeAdemeNumber` | idem | idem | COMPLEMENT |
| B8.dpeExpiryDate | Fin de validité | `dpeExpiryDate` (DEADLINE seulement si explicite) | idem | jamais calculée | COMPLEMENT |
| B8.re2020 | Attestation RE | V2 `RE2020_CERTIFICATE` / V1 `RE2020` | classement | — | IF_CONSTRUCTION ; N/A par règle si profil rénovation / volontaire ; à confirmer si profil inconnu |
| B8.audit | Audit | V2 `ENERGY_AUDIT` | classement | — | COMPLEMENT |
| B8.label | Label | V2 `BUILDING_LABEL_CERTIFICATE` / V1 `LABEL_CERTIFICATION` | classement | — | COMPLEMENT |

## 9. B9 — Annexes

| Id | BDD | Règle | Statut |
|---|---|---|---|
| B9.annexes | `asset_files` hors plans / réseaux / DPE / audit / photos / autres ; `document_cil_metadata.include_in_annex`, `sort_order` | une pièce citée par plusieurs blocs n'est intégrée qu'une fois (sélection V12 existante) | COMPLEMENT |

## 10. Tables auditées (écrivain → lecteur)

| Table | Écrivains | Lecteurs | Alimentation documentaire |
|---|---|---|---|
| `assets.key_characteristics` | fiche (USER), T3 `writeCanonicalAssetField`, T2 | état CIL, mappeur | oui (registre) |
| `energy_materials` | route `energy-materials` (USER), **projection CIL (DOCUMENT, U compris ; posés depuis une facture / attestation : `installed_at`, `operation_id`, 112F)** | état CIL, mappeur, préparation | **oui (111U, 112F)** |
| `equipments` / `equipment_cil_specs` | routes équipements (USER), entity-state T3 (brand, model, n° série, puissance), **projection CIL (énergie, puissance, marque, modèle ; création par usage ; équipement posé : `installed_at`, `installation_operation_id`, origines `WORKS`, 112F)** | état CIL, B6, mappeur | **oui (111U, 112F)** |
| `energy_works` | aucun écrivain applicatif constaté (seul l'Agenda détache `agenda_item_id`) | état CIL, mappeur (lu en plus des Opérations) | non : le rôle « travaux réalisés » est tenu par les Opérations (identité économique) ; écrire `energy_works` en double créerait deux identités du même travail |
| `business_operations` (+ sources, documents, liens équipements) | consolidation T3 des Opérations | **projection CIL B7 (lecture seule, qualification au journal) et B5 / B6 posés (pièces INVOICE / REPORT, 112F)**, état CIL ; écritures relayées au contrôle ciblé CIL (112F) | oui (existant) |
| `asset_cil_profiles` | route `cil-profile` (USER, formulaire B2 de l'onglet Informations), **projection CIL (DOCUMENT, fait explicite)** | état CIL (applicabilité), mappeur B2 | **oui (111U, 2e passe)** |
| `document_cil_metadata` | préparation (USER) | état CIL (B3), sélection | non (choix utilisateur) |
| `cil_block_resolutions` | route `resolutions` (USER) — blocs et données autorisées | état CIL, mappeur | jamais par T3 (autorité utilisateur) |
| `cil_projection_journal` (1300) | projection CIL | état CIL (à confirmer, recommandations), contrôle de cohérence | — |

## 11. Historique des corrections réutilisées

| Ticket | État constaté dans le code | Réutilisé |
|---|---|---|
| #487 diagnostics codés en dur / B6 | livré lot 69 : `lib/cil/energy-equipment.ts`, messages de blocage calculés (`cil-blocking.ts`) | règle B6 unique |
| #510 diagnostics réels B6 | livré lots 69 / 75A (`evaluateCilB6`, neutralisation de la déclaration) | conservé tel quel |
| #523 usage énergétique visible | livré lots 70B / 75A (`energy_usage`, `isEnergyUsageFieldRelevant`) | prioritaire dans la classification |
| #565 consommation T1 exhaustive par T3 | probable : lot 85F `COH-T1-KNOWLEDGE-CONSUMPTION` + 76J inventaire T3 | faits génériques relus par la projection CIL |
| #626 rattachement rétroactif | livré lots 105D / 108E (`COH-DOC-PRIMARY-LINK`, `projectDocumentKnowledgeToAsset`) | la projection CIL suit `reconcileAsset` (rattachement tardif compris) |
| #630 cohérence Agenda / DPE | livré lot 106A (`COH-AGENDA-EQUIVALENT-REPRESENTATIONS`) | inchangé |
