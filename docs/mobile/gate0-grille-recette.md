# Grille de recette Gate 0 — application mobile Verebona (lot 95)

Exigences G0-01 à G0-10 **au libellé exact du CDC 12 §3.2**, complétées des vérifications des décisions
PO M1, M2 et M9 et des mesures d'architecture (`docs/mobile/gate0-comparaison-architectures.md` § 8).

**Répartition des rôles (décision M10)** — organisation de recette, pas exigence fonctionnelle :
- **Développeur (Dév)** : prépare les versions installables (TestFlight, Google Play tests internes),
  exécute **d'abord** les tests techniques sur de **vrais** iPhone et Android, joint les preuves, corrige
  et reteste.
- **PO** : teste l'expérience sur son téléphone (directement ou avec des testeurs), **valide** chaque
  exigence et prononce la validation finale.
- **Autres testeurs** : peuvent couvrir l'autre plateforme ou d'autres appareils ; la validation finale
  reste au PO.

**Règles de passage** : chaque ligne renseignée par plateforme ; simulateurs et émulateurs ne
remplacent pas les appareils physiques (CDC §33) ; aucune anomalie critique ou majeure ouverte sur les
parcours visés à la clôture ; toute correction donne lieu à un nouveau test ciblé et à une
non-régression.

**Remplissage** : Résultat = `OK` / `KO` / `Réserve` ; Appareil = modèle exact ; OS = version exacte ;
Version = version marketing et numéro de build de l'app (Mon compte ou TestFlight / Play) ; Preuve =
capture, vidéo d'écran ou extrait de journal (jamais de mot de passe ni de jeton) ; Anomalies =
référence du ticket et gravité (critique / majeure / mineure).

Matrice d'appareils minimale (CDC §33) : 1 iPhone récent + 1 iPhone plus ancien compatible ; 1 Android
récent + 1 Android milieu de gamme (deux constructeurs si possible).

---

## 1. Exigences Gate 0 (CDC 12 §3.2)

| ID | Exigence (CDC 12) | Critère de sortie (CDC 12) | Plateforme | Test technique (Dév) | Validation (PO) | Résultat | Appareil | OS | Version (build) | Preuve | Anomalies |
|---|---|---|---|---|---|---|---|---|---|---|---|
| G0-01 | Coque Capacitor iOS et Android connectée à la préprod | Lancement sur terminaux réels, navigation sans erreur bloquante. | iOS | | | | | | | | |
| G0-01 | Coque Capacitor iOS et Android connectée à la préprod | Lancement sur terminaux réels, navigation sans erreur bloquante. | Android | | | | | | | | |
| G0-02 | Auth e-mail/mot de passe | Connexion, session, refresh, déconnexion fonctionnent. | iOS | | | | | | | | |
| G0-02 | Auth e-mail/mot de passe | Connexion, session, refresh, déconnexion fonctionnent. | Android | | | | | | | | |
| G0-03 | Accès API Next.js | Accueil + au moins un bien et un document chargés. | iOS | | | | | | | | |
| G0-03 | Accès API Next.js | Accueil + au moins un bien et un document chargés. | Android | | | | | | | | |
| G0-04 | Scan + upload | Document scanné reçu et créé une seule fois. | iOS | | | | | | | | |
| G0-04 | Scan + upload | Document scanné reçu et créé une seule fois. | Android | | | | | | | | |
| G0-05 | Upload en arrière-plan | Quitter l’app : transfert continue ou reprend selon OS sans perte. | iOS | | | | | | | | |
| G0-05 | Upload en arrière-plan | Quitter l’app : transfert continue ou reprend selon OS sans perte. | Android | | | | | | | | |
| G0-06 | Push + deep link | Push reçu ; clic ouvre l’écran cible. | iOS | | | | | | | | |
| G0-06 | Push + deep link | Push reçu ; clic ouvre l’écran cible. | Android | | | | | | | | |
| G0-07 | Partage entrant | PDF/image partagé depuis une app tierce est pris en charge. | iOS | | | | | | | | |
| G0-07 | Partage entrant | PDF/image partagé depuis une app tierce est pris en charge. | Android | | | | | | | | |
| G0-08 | Secure storage | Tokens/session stockés via Keychain/Keystore, pas localStorage. | iOS | | | | | | | | |
| G0-08 | Secure storage | Tokens/session stockés via Keychain/Keystore, pas localStorage. | Android | | | | | | | | |
| G0-09 | Build test | Build disponible via TestFlight et Google Internal Testing. | iOS | | | | | | | | |
| G0-09 | Build test | Build disponible via TestFlight et Google Internal Testing. | Android | | | | | | | | |
| G0-10 | Réutilisation UI | La solution n’impose pas une duplication massive de l’interface existante. | iOS + Android | (analyse du code) | | | — | — | | `gate0-comparaison-architectures.md` §2, §7 | |

**Décision Gate 0 (CDC 12)** : « Capacitor est validé si les points structurants fonctionnent sans
duplication excessive. Sinon l'architecture est réévaluée avant industrialisation ; React Native n'est
envisagé qu'en cas d'échec démontré. »

### Mode opératoire technique (Dév) — ce que chaque ligne doit montrer

| ID | Étapes et preuves attendues |
|---|---|
| G0-01 | Installer « Verebona Préprod » depuis TestFlight / Play ; nom et icône Préprod ; ouverture sur la préprod (et refus d'un serveur d'un autre environnement : écran « Application inutilisable ici ») ; parcourir Accueil, Biens, Documents, Agenda, À traiter, Mon compte ; retour Android ; aucune autorisation demandée au premier lancement. |
| G0-02 | Connexion ; app fermée puis rouverte (session conservée) ; attendre > 15 min puis ouvrir une page protégée (renouvellement, **point clé Android en mode A**) ; arrêt forcé + redémarrage du téléphone ; déconnexion (Mon compte › Sécurité ne montre plus l'appareil). |
| G0-03 | Accueil, une fiche de bien, un document ouvert ; en-têtes `X-Verebona-*` visibles (BO › Exploitation › Application mobile : version / build de l'appareil). |
| G0-04 | Formulaire d'ajout › « Scanner un document » ; 3 pages ; PDF unique dans « Mes documents » ; **rejouer** l'envoi (coupure réseau pendant la confirmation) : un seul document. |
| G0-05 | Lancer un envoi (~20 Mo), revenir à l'écran d'accueil du téléphone, attendre ; puis variante arrêt forcé pendant le transfert : noter le comportement (limite UPL-08 connue). |
| G0-06 | Autoriser les notifications (invitation dans l'app) ; déclencher un rappel d'échéance en préprod ; clic app fermée, app en arrière-plan, app verrouillée (> 5 min) : l'échéance s'ouvre après déverrouillage. |
| G0-07 | Depuis Photos, Fichiers, Mail et une messagerie : partager 1 PDF, puis 3 images ; un fichier non pris en charge (ZIP) affiche son nom et le motif. |
| G0-08 | Inventaire du stockage de l'app (préprod, débogage) : identifiant d'installation, préférence biométrique, vérificateur Google / Apple au Keychain / Keystore ; **aucun jeton dans localStorage / IndexedDB** ; emplacement réel des cookies de session noté (magasin de la WebView) → décision n° 1 du document de comparaison. |
| G0-09 | Lien du run GitHub Actions, numéro de build visible dans TestFlight et dans la piste de tests internes. |
| G0-10 | Revue de code : aucun écran dupliqué ; liste des fichiers ajoutés côté site (`src/lib/native`, `src/components/native`). |

---

## 2. Décision M1 — Connexion Google et Apple

| Vérification (relevé de décisions M1) | Plateforme | Test technique (Dév) | Validation (PO) | Résultat | Appareil | OS | Version (build) | Preuve | Anomalies |
|---|---|---|---|---|---|---|---|---|---|
| Tester les connexions Google et Apple sur iOS et Android, y compris un compte créé auparavant sur le web. | iOS | | | | | | | | |
| Tester les connexions Google et Apple sur iOS et Android, y compris un compte créé auparavant sur le web. | Android | | | | | | | | |
| Vérifier le cas des comptes Apple utilisant une adresse e-mail masquée ; confirmer l’absence de doublon de compte et de perte de données. | iOS | | | | | | | | |
| Vérifier le cas des comptes Apple utilisant une adresse e-mail masquée ; confirmer l’absence de doublon de compte et de perte de données. | Android | | | | | | | | |
| Tester l’échec, l’annulation et la reprise du flux de connexion sans exposer de jetons ni créer de session incohérente. | iOS | | | | | | | | |
| Tester l’échec, l’annulation et la reprise du flux de connexion sans exposer de jetons ni créer de session incohérente. | Android | | | | | | | | |
| Contrôle technique : le parcours s’ouvre dans le **navigateur système** (ASWebAuthenticationSession / Custom Tabs), jamais dans la vue de l’app. | iOS + Android | | | | | | | | |

Préalable : `APP_OAUTH_RETURN_URL` posée en préprod (voir `docs/mobile/builds-et-secrets.md` § 5).

## 3. Décision M2 — « Appareils connectés » sur web et mobile

| Vérification (relevé de décisions M2) | Plateforme | Test technique (Dév) | Validation (PO) | Résultat | Appareil | OS | Version (build) | Preuve | Anomalies |
|---|---|---|---|---|---|---|---|---|---|
| La déconnexion distante empêche toute réutilisation de la session révoquée. | iOS | | | | | | | | |
| La déconnexion distante empêche toute réutilisation de la session révoquée. | Android | | | | | | | | |
| Un appareil uniquement enregistré pour le push n’est jamais présenté à tort comme une session active. | iOS + Android | | | | | | | | |
| La vue web et la vue mobile exposent les mêmes données de sécurité et respectent l’isolation des comptes. | iOS + Android | | | | | | | | |
| Contrôle technique : après « Déconnecter cet appareil » depuis le web, le téléphone ne reçoit plus de notification personnelle. | iOS + Android | | | | | | | | |

## 4. Décision M9 — Scanner documentaire

| Vérification (relevé de décisions M9) | Plateforme | Test technique (Dév) | Validation (PO) | Résultat | Appareil | OS | Version (build) | Preuve | Anomalies |
|---|---|---|---|---|---|---|---|---|---|
| Tester documents simples et multipages, pages mal cadrées, petits caractères, erreur de réseau et reprise. | iOS | | | | | | | | |
| Tester documents simples et multipages, pages mal cadrées, petits caractères, erreur de réseau et reprise. | Android | | | | | | | | |
| Vérifier qu’un PDF scanné suit exactement les mêmes règles métier et contrôles que celui importé depuis le web. | iOS + Android | | | | | | | | |
| Contrôle technique : caméra refusée ou scanner indisponible → l’import classique est proposé. | iOS + Android | | | | | | | | |
| Contrôle technique : fichiers temporaires du scanner effacés après envoi (inspection du conteneur de l’app). | iOS + Android | | | | | | | | |

## 5. Mesures d'architecture (option A — à joindre à la décision)

| Mesure | Plateforme | Cible | Valeur mesurée | Appareil | OS | Version (build) | Preuve |
|---|---|---|---|---|---|---|---|
| Démarrage à froid jusqu'à l'accueil affiché (réseau 4G / Wi-Fi) | iOS / Android | < 3 s (PERF-01) | | | | | |
| Retour au premier plan | iOS / Android | < 1,5 s (PERF-02) | | | | | |
| Session conservée après arrêt forcé et redémarrage du téléphone | iOS / Android | Oui | | | | | |
| Page protégée après 15 min d'inactivité (relais `server.url` Android) | Android | Pas de retour à la connexion | | | | | |
| Lecture d'un fichier natif depuis la page distante (scan / partage) | iOS | Voie rapide ou repli `Filesystem` | | | | | |
| Violations CSP observées dans l'app (inspecteur Safari / Chrome) | iOS / Android | Aucune bloquante | | | | | |
| Sonde B : connexion par l'API depuis l'interface embarquée | iOS / Android | Constat (refus CSRF attendu sans changement serveur) | | | | | |
| Revue bêta TestFlight (groupe externe) | iOS | Acceptée | | | | | |
| Hors réseau au lancement puis retour du réseau | iOS / Android | Page « Connexion Internet requise » puis reprise | | | | | |

---

## 6. Procès-verbal de validation Gate 0

| Champ | Valeur |
|---|---|
| Date | |
| Builds testés (iOS / Android) | |
| Appareils | |
| Anomalies critiques ou majeures ouvertes | |
| Architecture retenue (A renforcé / B) | |
| Décisions PO n° 1 et n° 2 (document de comparaison § 10) | |
| Décision Gate 0 | Validé / Validé avec réserves / Non validé |
| Validation PO (nom, date) | |
