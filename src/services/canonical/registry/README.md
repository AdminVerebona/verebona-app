# Registre canonique des champs d'un bien

CDC 15 §5 (REG-01, REG-02), §12 (`CanonicalFieldRegistry`), §13 (matrice des événements), T1-01, T1-03, T4-01, T4-03, T4-04, T4-13, R6. Lot 11.

Le registre est la seule définition des clés métier d'un bien. T1, T2, T3, T4, À traiter, les validations et les exports s'appuient dessus. Il ne lit ni n'écrit la base : `CanonicalAssetView` et `writeCanonicalAssetField` (`../asset-state`) l'utilisent.

## API (`index.ts`)

| Symbole | Rôle |
|---|---|
| `AssetFamily` | `'IMMOBILIER' \| 'VEHICULE' \| 'OBJECT'`, les codes de `assets.category`. `toAssetFamily()` ramène `OBJET` (assistant), `MATERIEL_PRO` et `AUTRE` à `OBJECT`. |
| `CanonicalFieldDef` | Clé, libellé, familles, type, unité, alias, colonnes miroirs, effet agenda, droits T2, règle de complétude, sensibilité. Champs facultatifs en plus du contrat : `enumValues`/`enumLabels`, `integer`, `range`, `section`, `targetType`, `assistantPhrases`, `aliasUnits`. |
| `getField(key)` | Définition d'une clé **canonique**. Un alias ne donne rien. |
| `resolveAlias(raw, family?)` / `resolveAliasDetailed` | Clé brute → clé canonique. La version détaillée renvoie aussi l'unité portée par l'alias (`purchasePriceCents` → `sourceUnit: 'cents'`). |
| `listFields(family?)` | Champs applicables à une famille. |
| `normalizeValue(key, raw, { sourceUnit })` | Normalisation. C'est **le seul endroit** où une unité est convertie. |
| `toMirrorValue(key, value)` / `toMirrorPatch` | Colonnes miroirs : nom SQL → valeur, ou propriété Drizzle → valeur. |
| `eurToCents` / `centsToEur` | Conversions exactes. |
| `EVENT_CATALOG`, `getEventEntry` | Types d'événements agenda. |
| `DOCUMENT_CATALOG`, `resolveDocumentType` | Types documentaires, autorité, création d'agenda et preuves d'exécution. |
| `catalogForPrompts({ family })` | DTO sérialisable pour `EXPECTED_FIELDS` / `FIELD_CATALOG` / `EVENT_CATALOG` des prompts (R6). |
| `EXCLUDED_KEYS`, `isExcludedKey` | Clés volontairement hors registre, avec le motif. |

## Décisions appliquées

- **D-09. Montants.** Les montants de la fiche sont en euros (`money_eur`, unité `EUR`). Seules les clés `*Cents` sont en centimes (`money_cents`), et un test l'impose. Il n'y a aucune règle « ×100 » tirée du nom du champ ou de l'ordre de grandeur. Une conversion n'a lieu que si l'unité est connue : `opts.sourceUnit`, l'unité d'un alias (`aliasUnits`) ou une unité écrite dans la valeur (« 749 € », « 45 k€ », « 74900 cts »). Une valeur à plus de deux décimales, ou dont le séparateur est ambigu (« 12.500 »), est refusée plutôt que devinée. Recette T1-03 : 749 € donne 749 sur la fiche et 74 900 dans `purchase_price_cents`.
- **D-10. Source de vérité.** La source de vérité est `keyCharacteristics`. Les colonnes de `assets` sont des miroirs déclarés par clé :

  | Clé | Colonne | Transformation |
  |---|---|---|
  | acquisitionDate | purchase_date | date |
  | acquisitionPrice | purchase_price_cents | eur_to_cents |
  | acquisitionLocation | purchase_location | identité |
  | estimatedValue | estimated_value_cents | eur_to_cents |
  | notes | notes | identité |
  | lastRevision | last_maintenance_date | date |
  | warrantyEndDate | warranty_end_date | date |
  | address1 / postalCode / city | address / postal_code / city | identité |
  | registrationNumber | registration_number | identité |
  | mileage | mileage_or_hours | entier |
  | engine | engine_info | identité |
  | generalCondition (immobilier), condition (objet) | general_condition | identité |
  | dimensions | dimensions | identité |
  | objectCategory | object_category | identité |

  `toMirrorValue` normalise la valeur, puis lève une erreur si elle est invalide : un miroir qui diverge est pire qu'un refus. Un test vérifie que chaque colonne existe dans `db/schema.ts` et qu'elle n'a qu'une clé source par famille.
- **D-12. Informations complémentaires.** Elles restent hors registre. Leurs clés (`monthlyRentCents`, `desiredSalePriceCents`…) sont listées dans `EXCLUDED_KEYS` (type `ADDITIONAL_INFO`) et ne sont jamais résolues.
- **D-13, D-14, D-15.** Ces décisions sont portées par `EVENT_CATALOG` :
  - un événement historique n'est jamais notifié ;
  - un sinistre ou une vente reste un événement historique seul ;
  - la recopie d'un achat vers la date d'acquisition est notée sur l'entrée `purchase`.

## Résolution des alias

1. La comparaison ignore la casse, les accents, `_`, `-` et les espaces. Ainsi `purchase_date` et `date_achat` donnent `acquisitionDate`, et `kilométrage` donne `mileage`.
2. Une clé canonique applicable à la famille l'emporte sur un alias. Exemple : `generalCondition` donne `generalCondition` pour un bien immobilier et `condition` pour un objet.
3. Un alias n'est valable que dans les familles du champ qui le déclare. Par exemple, `marque` donne `make` pour un véhicule et `brand` pour un objet.
4. Sans famille, une forme qui désigne plusieurs clés n'est pas résolue. C'est le cas de `loyerMensuel`, qui peut désigner `monthlyRent` ou `leaseMonthlyPayment`.
5. Les clés exclues et les origines `*_origin` / `*__origin` ne sont jamais résolues.

Les formulations de l'assistant (« date d'achat », « prochain ct »…) sont dans `assistantPhrases`. Ce ne sont pas des clés.

## Droits T2

`assistantWritable` couvre exactement les 9 champs de `verebona-assistant/commands/asset-fields.ts`, et un test l'impose. Le lot 15 étendra la liste depuis le registre. Tous les champs sont lisibles par T2 (`assistantReadable`). Les champs `sensitive` (adresse, complément, GPS, n° client assurance) doivent être masqués dans les traces.

## Effets agenda (T4-01, T4-03, §13)

| Nature | Champs |
|---|---|
| HISTORICAL | acquisitionDate (achat), lastRevision (entretien), lastInspectionDate (contrôle), dpeDate (DPE) |
| DEADLINE | maintenanceDueDate, nextInspection, insuranceExpiry, warrantyEndDate, contractEndDate, leaseEndDate, dpeExpiryDate, registrationExpiry |

Changement délibéré par rapport à `DEADLINE_FIELDS` : `dpeDate` devient HISTORICAL (T4-03). Réparation, sinistre et vente sont des événements sans champ de bien.

Catégorie d'accueil par défaut :
- HISTORICAL : `information` ;
- DEADLINE : `action`, `information` (garantie) ou `selon_evenement` (assurance, contrat, bail, expiration DPE ; T4-11).

La récurrence déclarée (`FREQ=YEARLY` pour l'assurance) est seulement indicative : T4 ne l'applique que si la source la démontre.

## Catalogue documentaire (T4-04, T4-13)

- Les codes suivent la table d'autorité (`evidence/authority-score.ts`). Les codes du référentiel V2 (`ACQUISITION_INVOICE`, `VEHICLE_TECHNICAL_INSPECTION`…) et les anciens codes V1 sont déclarés comme alias.
- **Un type inconnu n'est jamais autoritaire** : `resolveDocumentType` renvoie `undefined`.
- `mayCreateAgenda` reprend les 11 types de `AUTHORIZED_CREATION_TYPES`, et un test l'impose. Deux extensions restent **à valider** : `ACTE_AUTHENTIQUE` (achat, vente) et `CONTROLE_TECHNIQUE` (PV).
- `completionProofs` décrit, par type, les formes de preuve qui établissent l'exécution (`completed`) ou non (`not_proven`). Exemples :
  - PV favorable : `completed` ;
  - PV avec contre-visite : `not_proven` ;
  - facture acquittée décrivant la prestation : `completed` ;
  - facture simple : `not_proven` ;
  - devis, bon de commande, avis d'échéance : `not_proven`.

## Questions ouvertes

1. **`dateFinContrat`.** Le CDC indique « contractEndDate / leaseEndDate selon contexte ». La clé est résolue en `contractEndDate` par défaut, et T1 doit émettre `leaseEndDate` pour un bail, une LOA ou une LLD.
2. **`numeroContrat`.** La clé est résolue en `contractNumber` (générique), alors que le corpus l'emploie pour des contrats d'assurance (`insuranceContractNumber`). Le contexte documentaire devrait trancher en T1.
3. **`dateEtablissement`.** C'est `dpeDate` pour un DPE et `documentDate` sinon. Elle est exclue et classée `UNCLASSIFIED`.
4. **`surfaceCarrez`.** Faut-il créer un champ distinct de `livingArea` ? Il est exclu pour l'instant.
5. **`parking`.** Il est lu par l'export Vente mais jamais écrit. Il faut soit le classer, soit retirer la lecture.
6. **`surfaceAnnoncee`, `prixAnnonce`.** Ce sont des faits d'annonce, pas des champs du bien.
7. **`puissance`, `cop`, `fluideFrigorigene`.** Ils concernent un équipement (cible `EQUIPMENT`) et restent hors registre du bien.
8. **Champs ajoutés hors fiche**, présents dans le CDC ou le corpus mais sans écran : `maintenanceDueDate`, `lastInspectionDate`, `dpeExpiryDate`, `energyConsumption`, `dpeAdemeNumber`, `engineDisplacement`, `leaseMonthlyPayment`, `leaseDurationMonths`, `leaseResidualValue`, `contractNumber`, `contractStartDate`, `warrantyStartDate`, `registrationExpiry`. Il faut décider de leur affichage.
9. **Familles de `lastRevision`.** Le champ est déclaré pour toutes les familles (matrice §13 : « entretien réalisé »), mais la fiche ne l'affiche que pour les objets.
10. **Constat de sinistre.** La matrice §13 le cite comme source, mais `mayCreateAgenda` vaut `false`, comme dans l'existant. Faut-il l'autoriser pour l'historique ?
11. **`mileage` en heures.** La colonne `mileage_or_hours` porte des heures quand `mileageUnit = 'h'`. Le registre n'applique aucune conversion entre heures et kilomètres.
