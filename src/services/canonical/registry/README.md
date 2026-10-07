# Registre canonique des champs d'un bien

CDC 15 §5 (REG-01, REG-02), §12 (`CanonicalFieldRegistry`), §13 (matrice des événements), T1-01, T1-03, T4-01, T4-03, T4-04, T4-13, R6. Lot 11.

Le registre est la seule définition des clés métier d'un bien. T1, T2, T3, T4, À traiter, les validations et les exports s'appuient dessus. Il ne lit ni n'écrit la base : `CanonicalAssetView` et `writeCanonicalAssetField` (`../asset-state`) l'utilisent.

## API (`index.ts`)

| Symbole | Rôle |
|---|---|
| `AssetFamily` | `'IMMOBILIER' \| 'VEHICULE' \| 'OBJECT'`, les codes de `assets.category`. `toAssetFamily()` ramène `OBJET` (assistant), `MATERIEL_PRO` et `AUTRE` à `OBJECT` — délégué au résolveur unique `toAssetFamilyCode()` de `lib/asset-taxonomy` (lot 30). |
| `CanonicalFieldDef` | Clé, libellé, familles, type, unité, alias, colonnes miroirs, effet agenda, droits T2, règle de complétude, sensibilité. Champs facultatifs en plus du contrat : `enumValues`/`enumLabels`, `integer`, `range`, `section`, `targetType`, `assistantPhrases`, `aliasUnits`. |
| `getField(key)` | Définition d'une clé **canonique**. Un alias ne donne rien. |
| `resolveAlias(raw, family?, { documentType }?)` / `resolveAliasDetailed` | Clé brute → clé canonique. La version détaillée renvoie aussi l'unité portée par l'alias (`purchasePriceCents` → `sourceUnit: 'cents'`). Le contexte documentaire tranche les alias contextuels (D-C, lot 20). |
| `CONTEXTUAL_ALIASES`, `isContextualAlias`, `documentContextOf` | Alias dont la clé dépend du type documentaire (`dateFinContrat`, `numeroContrat`, `dateEtablissement`). |
| `isInputOnlyKey(raw)` | Champ de saisie seule (`inputOnly`, D-D) : jamais inféré par l'IA. |
| `documentMayCreateEvent(entry, { businessType, nature })` | Droit de création automatique d'un type documentaire, restreint par sa `creationScope` (D-B). |
| `listFields(family?)` | Champs applicables à une famille. |
| `normalizeValue(key, raw, { sourceUnit })` | Normalisation. C'est **le seul endroit** où une unité est convertie. |
| `toMirrorValue(key, value)` / `toMirrorPatch` | Colonnes miroirs : nom SQL → valeur, ou propriété Drizzle → valeur. |
| `eurToCents` / `centsToEur` | Conversions exactes. |
| `EVENT_CATALOG`, `getEventEntry` | Types d'événements agenda. |
| `DOCUMENT_CATALOG`, `resolveDocumentType` | Types documentaires, autorité, création d'agenda et preuves d'exécution. Depuis le lot 30, `resolveDocumentType` suit aussi les anciens codes équivalents et les correspondances V1 → V2 certaines (ordre unique : `docs/exploitation/referentiels.md`). |
| `catalogForPrompts({ family })` | DTO sérialisable pour `EXPECTED_FIELDS` / `FIELD_CATALOG` / `EVENT_CATALOG` des prompts T1 (R6, inférence : `inputOnly` exclu). |
| `catalogForT2Read()`, `fieldAssistantVocabulary(def)` | Projection officielle pour la LECTURE T2 (lot 30, AC19 / AC20) : champs `assistantReadable`, familles, cibles, type, unité, enum, sensibilité et vocabulaire (libellé + `assistantPhrases`, jamais les `aliases`). Seule source du FIELD_CATALOG de UNDERSTAND et du matcher déterministe. |
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

6. Un alias **contextuel** (`CONTEXTUAL_ALIASES`) dépend du type documentaire passé en contexte (décisions PO D-C et D-D, lot 20) :

   | Alias | Bail / location (LLD, LOA, bail) | Assurance | DPE | Diagnostic | Sinon |
   |---|---|---|---|---|---|
   | `dateFinContrat` | `leaseEndDate` | | | | `contractEndDate` |
   | `numeroContrat` | | `insuranceContractNumber` | | | `contractNumber` |
   | `dateEtablissement` | | | `dpeDate` | `diagnosticDate` | date du document (non résolue) |

   La nature du document vient du catalogue (types d'événement du type), sinon du code (`RENTAL_LEASE`, `INSURANCE_POLICY`…). Sans contexte, ou si la clé ne s'applique pas à la famille (bail d'un objet), la branche « sinon » : la résolution historique est inchangée. Points d'application : projection T1 (`document-projection.ts`), candidats T4 (`build-agenda-candidates.step.ts`), preuves du chemin « étapes » (`persist-evidence.step.ts`, clé réécrite seulement si le document change la résolution).

Les formulations de l'assistant (« date d'achat », « prochain ct »…) sont dans `assistantPhrases`. Ce ne sont pas des clés.

## Champs de saisie seule (D-D, lot 20)

`listingPrice` (alias `prixAnnonce`) et `listedArea` (alias `surfaceAnnoncee`) portent `inputOnly: true` : ils ne sont **jamais inférés par l'IA**.
- absents du `FIELD_CATALOG` des prompts (`catalogForPrompts`) ;
- projection T1 : connaissance générique, avertissement `KEY_INPUT_ONLY` ;
- preuves : jamais écrites (`INPUT_ONLY_FIELD` côté maître, ignorées côté « étapes ») ;
- T3 : ni collectés, ni appliqués (`applyDecision` les ignore dans tous les modes) ;
- `writeCanonicalAssetField` refuse toute origine autre que USER / ADMIN / IMPORT (`protected`, `INPUT_ONLY_FIELD`).

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
- `mayCreateAgenda` reprend les 11 types du lot 10 (`AUTHORIZED_CREATION_TYPES` en est dérivé), et un test l'impose. Décision PO D-A (01/10/2026) : `ACTE_AUTHENTIQUE` (achat, vente) et `CONTROLE_TECHNIQUE` (PV) créent aussi des événements.
- Décision PO D-B : `CONSTAT_SINISTRE` crée l'événement HISTORIQUE « sinistre », et lui seul (`creationScope: { businessTypes: ['claim'], natures: ['HISTORICAL'] }`) ; toute autre échéance du constat est proposée. Un constat sans fait daté produit le sinistre à la date du document (mono-bien). Le statut du bien reste **proposé** par la carte À traiter ASSET-STATUS (D-15), jamais appliqué.
- `completionProofs` décrit, par type, les formes de preuve qui établissent l'exécution (`completed`) ou non (`not_proven`). Exemples :
  - PV favorable : `completed` ;
  - PV avec contre-visite : `not_proven` ;
  - facture acquittée décrivant la prestation : `completed` ;
  - facture simple : `not_proven` ;
  - devis, bon de commande, avis d'échéance : `not_proven`.

## Questions ouvertes

Les questions 1 à 7 et 10 sont tranchées par les décisions PO du 01/10/2026 (lot 20) :

1. **`dateFinContrat`** → alias contextuel (D-C1) : bail / location → `leaseEndDate`, sinon `contractEndDate`.
2. **`numeroContrat`** → alias contextuel (D-C2) : assurance → `insuranceContractNumber`, sinon `contractNumber`.
3. **`dateEtablissement`** → alias contextuel (D-D) : DPE → `dpeDate`, diagnostic → `diagnosticDate` (nouveau champ), sinon date du document.
4. **`surfaceCarrez`** → `carrezArea` (D-D), distinct de `livingArea` ; même ordre d'autorité.
5. **`parking`** → clé canonique `parking` (D-D), lue par les exports.
6. **`surfaceAnnoncee`, `prixAnnonce`** → `listedArea`, `listingPrice`, **saisie seule** (D-D).
7. **`puissance`, `cop`, `fluideFrigorigene`** → `powerKw` (alias `puissance`, colonne `equipment_cil_specs.power_kw`), `cop` et `refrigerant`, cible ÉQUIPEMENT (D-D).
8. **Champs ajoutés hors fiche** : décision D-E (affichage dans la fiche), hors registre.
9. **Familles de `lastRevision`.** Le champ est déclaré pour toutes les familles (matrice §13 : « entretien réalisé »), mais la fiche ne l'affiche que pour les objets.
10. **Constat de sinistre** → autorisé pour le sinistre historique seulement (D-B).
11. **`mileage` en heures.** La colonne `mileage_or_hours` porte des heures quand `mileageUnit = 'h'`. Le compteur horaire a désormais sa clé, `hourMeter` (D-D, bien ou équipement, sans colonne miroir) ; aucune conversion entre heures et kilomètres.
