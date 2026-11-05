# Partage natif vers Verebona — lot 110A (iOS et Android)

Décision PO du 04/11/2026 (ticket « Partage natif : trois choix »). Recette : `docs/exploitation/recette-110a-partage-natif.md`.

## 1. Contrat (identique sur les deux OS)

À la sélection de Verebona dans la feuille « Partager », une interface native courte montre le nom des
documents reçus et les choix :

| Choix | Effet |
|---|---|
| « Importer et ouvrir Verebona » | import lancé tout de suite (aucune confirmation), puis Verebona s'ouvre sur le document (s'il est enregistré) ou sur le suivi |
| « Importer sans ouvrir » | import lancé tout de suite, l'interface se ferme, retour à l'application source ; l'import continue sans Verebona |
| « Annuler » | rien n'est envoyé ; les copies provisoires sont effacées |

Sur iOS, « Importer et ouvrir Verebona » **n'est pas proposé** (§ 4 : aucune API publique). Il n'y a plus
d'alerte « Document prêt… OK », plus de formulaire « Ajouter un document » prérempli, plus de carte
« Document partagé en attente d'import ». Le parcours manuel d'ajout reste tel quel.

Les libellés, formats, limites et états sont définis à un seul endroit : `src/lib/mobile/share-import-policy.ts`.
Des tests vérifient que le Swift, le Java, l'AndroidManifest et l'Info.plist les reprennent à l'identique
(`mobile/test/l110a-partage-natif.test.mjs`).

## 2. Une seule opération d'import côté serveur

```
téléphone (extension iOS / WorkManager Android)
  POST /api/mobile/share-import/upload        Authorization: Bearer <jeton d'import>
       corps = le fichier ; X-Verebona-Operation-Id = identifiant d'import tiré sur l'appareil
        │
        ├─ jeton vérifié + garde de la session d'origine (révocation, accès à l'espace, CGUV)
        ├─ POST /api/files/presign   ← la MÊME route que le dépôt de l'app (contrôles, quotas, idempotence)
        ├─ dépôt de l'objet sur l'URL signée rendue par cette route
        └─ POST /api/files/confirm   ← la MÊME route (COMPLETED, événements, T1, miniatures)
```

- L'identité vérifiée est passée aux deux routes par `src/lib/documents/depot-session.ts` (table interne
  liée à l'objet requête : aucun en-tête ni cookie ne peut la reproduire).
- Idempotence : même identifiant d'import ⇒ même document (accusé perdu, double toucher, reprise après
  redémarrage). Un identifiant déjà enregistré répond tout de suite, sans relire le fichier.
- Réponse : `outcome` = `imported` (enregistré, seul cas affiché « Document ajouté »), `refused` (format,
  taille, quota, droits : définitif, cause affichée), `auth` (« En attente de connexion »), `retry` (incident
  passager, nouvel essai automatique). Un 2xx sans accusé lisible est traité comme `retry`, jamais comme un succès.
- Suivi : `GET /api/mobile/share-import/status?ops=…` (session de l'app) — uniquement l'utilisateur ET
  l'espace de la session.

## 3. Jeton d'import (aucune session émise)

L'extension iOS est un processus séparé : elle n'a pas accès aux cookies de la vue (HttpOnly), et le jeton
d'accès de session (15 min, renouvelé par rotation) ne doit être manipulé que par la vue. Un jeton dédié est
donc remis par l'app ouverte à sa partie native :

- émis par `POST /api/mobile/share-import/grant` **derrière la garde de session actuelle** (`getSession`) :
  quand le lot 110B branchera sa garde MFA sur cette garde, l'émission y sera soumise d'elle-même ;
- portée : import seul (aucune lecture), un utilisateur, **l'espace courant** de la session, 72 h
  (`MOBILE_SHARE_IMPORT_GRANT_TTL_HOURS`, 1 à 168), 100 requêtes, révocable (`DELETE` sur la même route,
  rotation à chaque nouveau jeton de la même session) ;
- à chaque usage : révocation globale (changement de mot de passe, « déconnecter les appareils ») et unitaire
  de la session d'origine, statut du compte, adhésion ACTIVE à l'espace, CGUV ; une session révoquée ou un
  accès retiré révoque aussi le jeton ;
- stockage : empreinte SHA-256 seule en base (table `mobile_share_import_grants`, migration 1160) ; sur iOS
  Keychain du groupe d'apps (après premier déverrouillage, propre à l'appareil) ; sur Android préférences
  privées chiffrées AES-GCM par une clé du Keystore. Jamais rendu à la vue après remise, jamais journalisé.

À signaler au lot 110B : si la garde MFA ajoute un état « session non vérifiée » contrôlé ailleurs que dans
`getSession`, il faudra l'appliquer aussi dans `authenticateShareImportGrant`
(`src/services/mobile/share-import/grants.ts`, point unique).

## 4. iOS « et ouvrir » — étude de faisabilité (API publiques)

| Piste | Résultat |
|---|---|
| `NSExtensionContext.open(_:)` | Documentation Apple : « In iOS, the Today and iMessage app extension points support this method » ; une extension de partage reçoit `false`. **Non utilisable.** |
| `UIApplication.shared.open` | Indisponible dans une extension (APPLICATION_EXTENSION_API_ONLY). Le contournement par la chaîne de répondeurs (`UIResponder` → `UIApplication`) est un usage non documenté : **retiré** (il l'était déjà depuis le lot 108G ; un test interdit tout retour). |
| `openURL` de SwiftUI, lien universel affiché dans l'extension | Passe par le contexte d'extension : même limite, aucune ouverture garantie. |
| Lien universel dans Safari | Fonctionne seulement depuis Safari (bannière), pas depuis la feuille de partage. |
| Intents / Raccourcis (`openAppWhenRun`) | Déclenchés par Siri / Raccourcis, pas par l'interface d'une extension de partage. |
| Notification locale cliquable | **Publique et fiable**, mais demande un toucher de l'utilisateur et l'autorisation des notifications : ce n'est pas une ouverture automatique. |

Sources : fil Apple Developer Forums 776488 (réponse acceptée : « This isn't allowed », avec la citation de
la documentation `open`), documentation `NSExtensionContext.open(_:completionHandler:)` ; une question
publique d'avril 2026 sur le même sujet (fil 824629) est restée sans réponse d'Apple.

**Conclusion : aucune voie publique n'ouvre réellement Verebona depuis l'extension de partage.** Le choix 1
n'est donc pas affiché sur iOS, et `mobile/config/environments.mjs › SHARE_IMPORT.ios.openAppChoice` est
verrouillé à `false` (un build qui le passerait à `true` échoue). La preuve sur appareil physique est sans
objet tant que l'option n'existe pas ; la recette vérifie l'inverse (aucune option « et ouvrir » sur iOS).

### Arbitrage demandé au PO (bascule sans développement, par `SHARE_IMPORT` puis nouveau build)

- **Option A** : iOS = « Importer sans ouvrir » + « Annuler ». L'utilisateur ouvre
  Verebona quand il le souhaite ; la carte d'état y montre l'avancement.
- **Option B** : comme A, plus une notification locale après l'accusé serveur : « Document ajouté à
  Verebona — Touchez pour l'ouvrir » (sans nom de fichier) ; le toucher ouvre le document ou le suivi.
  Réglage : `SHARE_IMPORT.ios.completionNotification: true` (autorisation de notifications nécessaire).
- **Décision PO du 05/11/2026 (livrée)** : option B, libellé « Importer dans Verebona ».
- **Libellé** : `SHARE_IMPORT.ios.importLabel` = « Importer sans ouvrir » (validé) ou « Importer dans
  Verebona » si le PO préfère un libellé qui ne parle pas d'ouverture.
- La parité stricte (3 choix sur iOS) demanderait une API qu'Apple ne fournit pas : à ne pas annoncer.

## 5. iOS — fonctionnement

- Extension (`mobile/ios/App/ShareExtension/`) : interface SwiftUI compacte ; copies dans un dossier
  provisoire du groupe d'apps ; au choix d'import, publication du partage (`partages-v2/<id>/manifest.json`)
  et envoi par **URLSession d'arrière-plan** (identifiant propre, `sharedContainerIdentifier` = groupe d'apps)
  AVANT la fermeture ; l'envoi continue application fermée ; à la fin, le système réveille l'app en
  arrière-plan (`AppDelegate.handleEventsForBackgroundURLSession`) qui enregistre l'accusé.
- Cœur commun app / extension : `mobile/ios/App/Shared/VerebonaShareImportCore.swift` (manifeste coordonné
  entre processus, Keychain, envoi, purge, notification de l'option B).
- Plugin de l'app : `VerebonaShareImportPlugin.swift` (état, remise du jeton, acquittement, reprise).
- Purge : copie effacée à l'accusé ou à l'échec définitif ; dossier effacé à l'acquittement, à l'annulation,
  ou après 7 jours ; dossier provisoire abandonné : 1 h.
- Sans jeton valide (jamais connecté, jeton expiré) : le partage reste « En attente de connexion » et se
  termine à la prochaine ouverture de Verebona, sans resélection ni confirmation, dans le compte de
  l'appareil (jamais un autre : § 7).

## 6. Android — fonctionnement

- `ShareReceiverActivity` (ACTION_SEND / ACTION_SEND_MULTIPLE ; documents acceptés par le serveur, images,
  partage multiple de types mêlés) : dialogue léger au-dessus de l'app source, trois choix.
- Copies dans le **stockage interne privé** (`files/share-import/`), jamais le stockage partagé.
- Envoi : **WorkManager** (travail unique par identifiant d'import, contrainte réseau, reprise exponentielle,
  persistant au redémarrage) ; « sans ouvrir » termine l'activité ; « et ouvrir » ouvre `MainActivity`, la vue
  affiche le suivi / le document.
- `MainActivity` ne reçoit plus les partages : plus de formulaire prérempli.

## 7. Isolation des comptes

Chaque partage porte la clé du compte du jeton utilisé (`u<utilisateur>-a<espace>`) ; il n'est envoyé
qu'avec un jeton DE CE compte et n'est montré qu'à ce compte. Sans jeton au moment du partage : rattaché au
dernier compte connu de l'appareil ; sans aucun compte connu : au premier compte qui se connecte. Un
changement d'espace (Duo) ne détourne jamais un import vers le nouvel espace. Côté serveur, le document est
créé dans l'espace du jeton, et le suivi ne répond que pour l'utilisateur ET l'espace de la session.

## 8. Binaires antérieurs

La file 108G (`partages-v1`, plugin `VerebonaShareInbox`, carte « en attente d'import ») reste lue pour
les partages déposés par un binaire antérieur au lot 110A ; aucun nouveau partage n'y entre.
