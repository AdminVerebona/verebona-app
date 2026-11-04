# Application mobile — conformité App Store / Google Play : constats et risques (lot 108G)

Version du 03/11/2026. **Ce document ne garantit aucune acceptation** : Apple et Google décident à la
revue, et leurs règles évoluent (à relire au moment de la soumission). Il liste ce que fait l'app, le
risque restant et ce que le PO doit préparer. Architecture : `architecture-distante.md` (interface
distante, décision PO du 03/11/2026).

## 1. Apple 4.2 « fonctionnalité minimale » (le risque principal du mode distant)

Règle : une app qui n'est qu'un site « emballé », sans valeur propre à l'app, peut être refusée (4.2,
et 4.2.2 pour le contenu « principalement web »).

| Ce que l'app apporte en plus du site | État | Preuve en recette |
|---|---|---|
| Scanner de documents du système (VisionKit) → PDF multipage | Fait (lot 95) | CA04 |
| **Partage entrant** depuis Mail, Outlook, Gmail, Photos, Fichiers (extension de partage) | Fait (lot 108G) | CA04 |
| Notifications natives (rappels, documents à traiter), ouverture de l'écran ciblé | Fait (lot 95/97) | CA04 |
| Face ID / Touch ID, verrou après 5 min, aperçu multitâche masqué | Fait (lot 107A) | CA04 |
| Liens universels (e-mails Verebona ouverts dans l'app) | Fait | CA04 |
| Envoi de documents en arrière-plan | Fait (lot 95) | CA05 |
| Écran natif hors connexion, liens externes vers Safari, aucune barre de navigateur | Fait (lot 108G) | CA05 |

Constat : c'est le profil habituellement accepté (service réel + fonctions natives effectives), **sans
garantie**. Risques : réviseur qui teste sans compte abonné (voir § 5), écrans perçus comme « site
mobile ». Parade : revue **bêta TestFlight externe** dès la préproduction (premier avis), notes de revue
décrivant les fonctions natives, vidéo de démonstration si demandée.

## 2. Abonnements numériques et liens commerciaux (Apple 3.1.1 / 3.1.3(f), Google « Paiements »)

| Constat | État | Risque |
|---|---|---|
| Aucun achat intégré, aucun prix, aucun bouton ni lien vers les offres, le paiement ou le portail Stripe (lot 97B) | Fait — 3 barrières : interface, navigation directe (`/app/abonnement`), API (403 `NOT_AVAILABLE_IN_APP`) | Faible |
| Texte « La gestion de l'abonnement se fait sur le site. » sans lien ni adresse | Fait | Un réviseur peut le juger incitatif : texte à revoir si demandé |
| Liens externes génériques ouverts dans Safari / Chrome (lot 108G) | Fait | Un lien vers une page tarifaire du site public serait un « appel à acheter » : **aucun** lien commercial ne doit être ajouté dans l'app (règle pour les lots futurs, dont 108H) |
| Messages serveur « Limite atteinte » / « essai terminé » affichés tels quels | Existant | Moyen : texte spécifique à l'app si un réviseur le juge incitatif |
| Résiliation, rétractation, parrainage, invitation Duo conservés (A9) | Fait (lot 100D) | Faible : ce ne sont pas des achats |

Positionnement à tenir dans la fiche : Verebona est un **service en ligne** (gestion de biens et de
documents), l'app en est le compagnon ; les abonnements se prennent sur le site (profil 3.1.3(f)).

## 3. Suppression de compte (Apple 5.1.1(v), Google « Suppression de compte »)

- Dans l'app : Mon compte › zone dangereuse (suppression à J+30 avec annulation possible) — existant,
  conservé (A9). À vérifier en recette : accessible sans passer par le site.
- Google Play exige en plus une **adresse web** de demande de suppression dans la fiche (Data safety) :
  à fournir par le PO (page du site public ou de l'app).

## 4. Confidentialité et sécurité des données

| Déclaration | Contenu à déclarer (à confirmer par le PO) |
|---|---|
| App Store « App Privacy » / Play « Data safety » | Données de compte (e-mail, nom), contenus déposés (documents, photos), identifiants d'appareil (identifiant d'installation, jeton de notification), diagnostics techniques serveur ; **aucun** suivi publicitaire, Firebase Analytics désactivé (lot 102C) ; données chiffrées en transit (HTTPS) ; suppression possible |
| Manifeste de confidentialité iOS (`PrivacyInfo.xcprivacy`) | **Non fourni par l'app** à ce jour ; les SDK (Capacitor, Firebase Messaging) fournissent le leur. **À vérifier** au premier envoi : Apple signale les « Required Reason API » manquantes (ex. date de modification de fichier lue par `VerebonaShareInbox.swift` pour purger les partages interrompus ; `UserDefaults` utilisé par des plugins) — risque de rejet à l'envoi |
| Permissions | Caméra (scanner), Face ID, notifications — demandées à l'usage, textes en français ; Android sans permission CAMERA ; service de premier plan « synchronisation de données » à déclarer dans la Play Console |
| Chiffrement (export) | `ITSAppUsesNonExemptEncryption = false` (HTTPS standard) |
| Sécurité | Pont natif limité à l'origine de l'environnement, CSP de l'app, aucun secret dans le binaire, préprod / prod isolées |

## 5. Préparation de la revue (PO)

- Compte de démonstration **déjà abonné** (pas de parcours d'achat à montrer), avec biens et documents.
- Notes de revue : service en ligne, abonnement sur le site (3.1.3(f)), liste des fonctions natives, où
  trouver la suppression de compte.
- Captures et vidéo de l'app de production (après recette de production).

## 6. Séparation préparation / soumission / ouverture publique (CA06)

| Étape | Qui | Ce qui se passe | Public ? |
|---|---|---|---|
| Préparation technique | Dév + PO (approbation GitHub `production-mobile`) | Builds de production en mode distant → TestFlight (app de production), Play « Tests internes » de la fiche de production | Non |
| Recette de production | PO + testeurs | `recette-108g-mobile-distant.md` partie B | Non |
| Revue bêta externe (facultative) | PO | Groupe externe TestFlight | Non (testeurs invités) |
| Soumission | PO, à la main | App Store Connect : soumettre la version, **« Publication manuelle »** ; Play : version en brouillon / non lancée | Non |
| Ouverture publique | Décision PO séparée | Bouton « Publier » (App Store) ; « Lancer le déploiement » (Play) | Oui |

Aucun workflow ne soumet ni ne publie : ils s'arrêtent à TestFlight / pistes de test / brouillon.
