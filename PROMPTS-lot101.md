# Lot 101 — textes de prompt à appliquer par le PO (étapes 10 et 11)

Extrait de docs/exploitation/prompts-a-appliquer-par-le-po.md (le guide complet fait foi). D'abord regarder BO › Configuration IA › Conformité des prompts : en préproduction, le système applique ces blocs seul quand c'est sûr ; ne coller à la main que si l'étape est affichée « bloquée ».

## 10 bis. Étape 10 — T1 : identité du produit, contrat `t1-product-identity-v1` (lot 101A)

### Pourquoi

Cas réel du 30/10/2026 : une fiche Samsung rattachée au micro-onde a donné le
bon modèle (MG23K3515AK), mais aussi le modèle d'un **produit recommandé** de
la page (MC32J7035AK, enregistré « certain ») et le libellé « Micro-Ondes Gril
23L » comme modèle. Et Verebona n'avait pas de propriété pour la **série** du
produit : « série », « modèle », « référence » et « numéro de série » se
mélangeaient.

Depuis le lot 101A, le registre porte des propriétés distinctes :
`brand` (marque), `productSeries` (série du produit, ex. MG23K3515),
`modelName` (modèle, ex. MG23K3515AK), `productReference` (référence
commerciale, ex. MG23K3515AK/EF), `productDesignation` (désignation
commerciale, ex. « Micro-ondes gril 23 L ») et `serialNumber` (numéro de série
de l'appareil). Elles sont transmises à T1 par le catalogue des champs
(`FIELD_CATALOG`, donnée du prompt : aucun texte à changer pour cela).

**Sans ce bloc, le code est déjà sûr** : le garde-fou serveur
`guardProductIdentity` (`src/services/ai/source-analysis/master/product-identity-guard.ts`)
s'applique à toute analyse, avant et après le collage :

* un libellé générique lu comme modèle devient une désignation commerciale ;
* un prix, une date, une offre (« Série Spéciale Livebox ») ou un VIN n'est
  jamais projeté comme série, modèle, référence ou numéro de série ;
* sur une page fournisseur, le **produit principal** est établi par le serveur
  (données structurées de la page, titre, h1) ; les zones de produits
  connexes (recommandés, similaires, carrousels, comparatifs, accessoires) ne
  sont plus transmises à T1, et un code d'un autre produit n'est jamais
  rattaché à l'équipement ;
* deux modèles incompatibles pour un même objet passent en `conflictual`.

Le bloc aide T1 à remplir **séparément** chaque propriété et à ignorer de
lui-même les produits connexes.

### Où

BO › Configuration IA › Prompts maîtres › **T1** › Modifier. Collez le bloc 10
**juste avant** la ligne repère suivante (dernière ligne du prompt) :

```text
Réponds uniquement par le JSON de la branche TASK demandée, sans texte autour.
```

Laissez une ligne vide avant et après. Indépendant des autres étapes (le bloc
de l'étape 4 se colle avant la même ligne : l'ordre des deux blocs est libre).

### Texte exact à coller (bloc 10)

<!-- l89c:bloc id="t1-product-identity-v1" prompt="t1" action="insert-before" anchor="Réponds uniquement par le JSON de la branche TASK demandée, sans texte autour." -->
```text
IDENTITÉ DU PRODUIT (contrat t1-product-identity-v1)

P1 — PROPRIÉTÉS DISTINCTES. Pour un équipement ou un objet, ne confonds jamais : `brand` (marque) ; `productSeries` (série, gamme ou famille du produit, ex. MG23K3515) ; `modelName` (modèle exact, ex. MG23K3515AK) ; `productReference` (référence commerciale complète, ex. MG23K3515AK/EF) ; `productDesignation` (désignation commerciale générique, ex. « Micro-ondes gril 23 L ») ; `serialNumber` (numéro de série de l’EXEMPLAIRE, identifiant physique unique, souvent précédé de « S/N » ou « N° de série »). Une série n’est jamais un numéro de série. Un libellé générique n’est jamais un modèle.
P2 — PAGE FOURNISSEUR. Sur une fiche produit, seul le PRODUIT PRINCIPAL de la page (titre, bloc principal, caractéristiques de ce produit) est rattaché à la cible. Les produits recommandés, similaires, comparés, accessoires ou présentés en carrousel ne sont JAMAIS rattachés : si tu les cites, `target.type: GENERIC`, `entityId: null`, `canonicalKey: null`, `subject` = « Produit connexe ».
P3 — UNE IDENTITÉ PAR OBJET. Ne rattache jamais deux modèles différents au même objet avec `confidence: certain` : en cas de doute, `conflictual`. Une variante d’écriture ou une valeur plus précise (MG23K3515** puis MG23K3515AK) désigne le même produit.
P4 — NATURE DE LA VALEUR. Un prix, une date, une offre commerciale (« Série Spéciale ») ou un VIN n’est jamais une série, un modèle, une référence ni un numéro de série.

Exemple de faits (page produit d’un micro-onde, équipement 8) :

{
  "facts": [
    {"canonicalKey": "productSeries", "label": "Série", "rawValue": "MG23K3515", "normalizedValue": "MG23K3515", "valueType": "string", "target": {"type": "EQUIPMENT", "entityId": 8, "confidence": "certain", "evidenceSignals": ["titre de la page"]}, "provenance": "TEXT_EXTRACTION", "confidence": "probable", "evidence": {"excerpt": "Micro-ondes Gril MG23K3515AK"}},
    {"canonicalKey": "modelName", "label": "Modèle", "rawValue": "MG23K3515AK", "normalizedValue": "MG23K3515AK", "valueType": "string", "target": {"type": "EQUIPMENT", "entityId": 8, "confidence": "certain", "evidenceSignals": ["titre de la page"]}, "provenance": "TEXT_EXTRACTION", "confidence": "certain", "evidence": {"excerpt": "Micro-ondes Gril MG23K3515AK"}},
    {"canonicalKey": "productReference", "label": "Référence", "rawValue": "MG23K3515AK/EF", "normalizedValue": "MG23K3515AK/EF", "valueType": "string", "target": {"type": "EQUIPMENT", "entityId": 8, "confidence": "certain", "evidenceSignals": ["référence"]}, "provenance": "TEXT_EXTRACTION", "confidence": "certain", "evidence": {"excerpt": "Référence : MG23K3515AK/EF"}},
    {"canonicalKey": "productDesignation", "label": "Désignation", "rawValue": "Micro-Ondes Gril 23L", "normalizedValue": "Micro-Ondes Gril 23L", "valueType": "string", "target": {"type": "EQUIPMENT", "entityId": 8, "confidence": "certain", "evidenceSignals": ["titre de la page"]}, "provenance": "TEXT_EXTRACTION", "confidence": "certain", "evidence": {"excerpt": "Micro-Ondes Gril 23L"}},
    {"canonicalKey": null, "rawKey": "modelName", "subject": "Produit connexe", "attribute": "Modèle", "rawValue": "MC32J7035AK", "normalizedValue": "MC32J7035AK", "valueType": "string", "target": {"type": "GENERIC", "entityId": null, "confidence": "certain", "evidenceSignals": ["produits recommandés"]}, "provenance": "TEXT_EXTRACTION", "confidence": "certain", "evidence": {"excerpt": "Vous aimerez aussi : MC32J7035AK"}}
  ]
}
```

Le bloc contient le marqueur `t1-product-identity-v1`, seul lu par le code
(`promptCarriesProductIdentity`,
`src/services/ai/source-analysis/master/product-identity-contract.ts`).
Format validé par le serveur : schéma réel des faits T1 (`t1Fact`,
`src/services/ai/source-analysis/master/t1-contract.ts`), puis garde-fou
`guardProductIdentity` : les cinq faits de l'exemple sont acceptés tels quels
(rien n'est requalifié), et le fait connexe reste générique.

### Vérifier après activation

1. **Dans le brouillon** : aucun encadré rouge, aucun avertissement nouveau.
2. **Conformité des prompts** (BO › Configuration IA) : l'étape 10 est
   *activée*. Comme l'étape 4, elle peut rester *bloquée* en préproduction
   faute de cas de référence T1 vérifiable : le collage manuel reste alors
   possible.
3. **Sur un cas connu** : relancez l'analyse de la page Samsung du micro-onde
   (tiroir du document › « Relancer l'analyse »). Le tiroir de l'équipement
   montre Marque, Série du produit, Modèle, Référence commerciale et
   Désignation dans des lignes distinctes ; MC32J7035AK n'y apparaît pas.
4. **Diagnostic global** : avertissements `FACT_REJECTED_BY_RULE`
   (« produit connexe de la page ») et faits `projection_rule` =
   `PRODUCT_SECONDARY_ON_PAGE` sur ce document ; contrôle
   `COH-EQUIPMENT-IDENTITY` cohérent pour l'équipement.

### Retour arrière

Réactivez la version T1 précédente (§1.4). Le garde-fou serveur reste actif :
aucune régression de sûreté.

---

## 10 ter. Étape 11 — T2 : ellipses et propriété exacte, contrat `t2-property-continuity-v1` (lot 101A)

### Pourquoi

Cas réel : « C'est quoi la marque de mon micro-onde ? » → « Samsung », puis
« Et la série ? » → dix valeurs sans rapport (tickets Decathlon, offre Orange,
compteur EDF, VIN). Le micro-onde n'était pas retenu comme objet du fil, la
demande partait en recherche sur tout le compte, et rien ne vérifiait que les
valeurs concernaient le micro-onde et la série.

**Sans ce bloc, le code est déjà sûr** (lot 101A) :

* l'objet actif du fil est retenu par son **identifiant** (« Et la série ? »,
  « Et le modèle ? », « Et sa référence ? » visent le même équipement) ; deux
  objets possibles : une question de précision, jamais un choix au hasard ;
* une demande dépendante du contexte, ou sur une propriété sans cible, passe
  par la compréhension (UNDERSTAND) **avant** toute recherche ; sans objet
  identifiable dans le fil, la réponse demande de préciser — jamais une
  recherche du compte entier ;
* la recherche est bornée à l'objet et à ses documents rattachés ; chaque
  candidat est validé (objet → propriété → source → valeur) **avant** toute
  revalidation : un prix n'est jamais un numéro de série, un VIN jamais une
  série de micro-onde ;
* « série » (série du produit) et « numéro de série » sont deux propriétés ;
  une propriété absente est dite absente, sans la remplacer par une autre.

Le bloc aide UNDERSTAND quand la question n'emploie aucun mot reconnu
(« Et son prix ? », « Et la date ? ») : il rend la propriété exacte et ne
change jamais d'objet sans désignation explicite.

### Où

BO › Configuration IA › Prompts maîtres › **T2** › Modifier. Collez le bloc 11
**juste avant** la ligne repère suivante (sortie de la branche UNDERSTAND) :

```text
SORTIE UNDERSTAND
```

Laissez une ligne vide avant et après. Aucun emplacement nouveau, aucune autre
étape requise.

### Texte exact à coller (bloc 11)

<!-- l89c:bloc id="t2-property-continuity-v1" prompt="t2" action="insert-before" anchor="SORTIE UNDERSTAND" -->
```text
CONTINUITÉ ET PROPRIÉTÉ EXACTE (contrat t2-property-continuity-v1)

A10 — ELLIPSES. « Et la série ? », « Et son modèle ? », « Et sa référence ? », « Et le prix ? » portent sur l’objet du tour précédent. Si le contexte conversationnel indique une « Référence résolue », recopie sa désignation dans `entityHints` avec son type (equipment, room ou asset). Ne change jamais d’objet sans désignation explicite de l’utilisateur.
A11 — PROPRIÉTÉ EXACTE. `requestedFacts` contient la propriété demandée et elle seule : série, gamme, famille → productSeries ; modèle → modelName ; référence → productReference ; désignation → productDesignation ; numéro de série, n° de série, S/N → serialNumber ; marque → brand (equipment, objet) ou make (véhicule). Ne remplace jamais une propriété par une voisine.
A12 — AMBIGUÏTÉ. Si plusieurs objets du contexte peuvent être visés, `confidence=ambiguous` : ne choisis pas.

Exemple (« Et la série ? » après une question sur la marque du micro-onde) :

{
  "mode": "UNDERSTAND",
  "intent": "ACCOUNT_FACT_ASSET",
  "confidence": "exact",
  "entityHints": [{"type": "equipment", "value": "micro-onde"}],
  "requestedFacts": ["productSeries"],
  "requestedTopics": [],
  "filters": {"documentType": null, "periodStart": null, "periodEnd": null, "unlinked": null, "status": null, "supplier": null, "upcoming": null},
  "reason": "ellipse : série du produit de l’équipement du tour précédent",
  "interactionMode": "QUERY",
  "suppliedFacts": [],
  "semanticDecision": null
}
```

Le bloc contient le marqueur `t2-property-continuity-v1`, seul lu par le code
(`promptCarriesPropertyContinuity`,
`src/services/verebona-assistant/core/property-continuity-contract.ts`).
Format validé par le serveur : schéma réel `T2UnderstandOutput`
(`src/services/ai/assistant/master/t2-contract.ts`) puis `toT2Understanding` :
`requestedFacts` = `productSeries` (clé du catalogue des champs), indice
`equipment` conservé.

### Vérifier après activation

1. **Dans le brouillon** : aucun encadré rouge, aucun avertissement nouveau.
2. **Conformité des prompts** : l'étape 11 est *activée*.
3. **Sur un cas connu**, dans un même fil : « C'est quoi la marque de mon
   micro-onde ? » (→ Samsung), puis « Et la série ? », puis « Et son numéro de
   série ? ». Les réponses ne parlent que du micro-onde ; une information
   absente est dite absente.
4. **BO › Exécutions & logs › Routage T2** : la trace de chaque tour porte
   `turn` (objets actifs avant le tour, référence, cibles résolues,
   propriété, décision de routage, périmètre, candidats et motifs) ; aucune
   anomalie `ELLIPTIC_CONTEXT_UNRESOLVED`.

### Retour arrière

Réactivez la version T2 précédente (§1.4). La résolution serveur, le
garde-fou de routage et la validation des candidats restent actifs.

---

