export interface HelpArticleTags {
  themes: string[];
  offers: ('standard' | 'premium' | 'premium_duo')[];
  states: ('new' | 'updated' | 'coming_soon')[];
}

export interface HelpArticleStep {
  title: string;
  body: string;
}

export interface HelpArticle {
  slug: string;
  title: string;
  seoTitle: string;
  tags: HelpArticleTags;
  isPublished: boolean;
  publishedAt: string;
  updatedAt?: string;
  summary: string;
  intro: string;
  description: string;
  steps: HelpArticleStep[];
  illustration: string;
  body?: string;
}

export const HELP_ARTICLES: HelpArticle[] = [
  {
    slug: 'creer-un-bien',
    title: 'Créer un bien',
    seoTitle: 'Créer un bien',
    tags: { themes: ['biens', 'démarrage'], offers: ['standard'], states: [] },
    isPublished: true,
    publishedAt: '2024-01-01',
    summary: 'Apprenez à créer votre premier bien immobilier ou mobilier dans Verebona.',
    intro: `Un bien est l'unité centrale de Verebona : il regroupe vos documents, équipements, pièces et événements autour d'un seul objet (appartement, maison, cave, véhicule…).`,
    description: `Verebona vous permet de gérer l'intégralité de votre patrimoine depuis un seul endroit. Chaque bien peut accueillir des documents (factures, garanties, contrats), des pièces, des équipements et un agenda de rappels. La création d'un bien est la première étape pour organiser votre patrimoine.`,
    steps: [
      { title: 'Accéder à la section Mes biens', body: 'Depuis le menu principal, cliquez sur **Mes biens** dans la barre de navigation latérale.' },
      { title: 'Cliquer sur « Ajouter un bien »', body: `En haut à droite de la liste, cliquez sur le bouton **Ajouter un bien**. Un formulaire s'ouvre.` },
      { title: 'Choisir la catégorie', body: 'Sélectionnez le type de bien dans la liste déroulante : Appartement, Maison, Terrain, Véhicule, Objet de valeur, etc.' },
      { title: `Renseigner le nom et la date d'acquisition`, body: `Donnez un nom parlant à votre bien (ex : "Appartement Paris 11e") et indiquez sa date d'acquisition.` },
      { title: 'Enregistrer', body: 'Cliquez sur **Enregistrer**. Votre bien apparaît immédiatement dans la liste et vous pouvez commencer à lui ajouter des documents.' },
    ],
    illustration: '/aide/creer-un-bien.jpg',
  },
  {
    slug: 'completer-fiche-bien',
    title: `Compléter la fiche d'un bien`,
    seoTitle: `Compléter la fiche d'un bien`,
    tags: { themes: ['biens'], offers: ['standard'], states: [] },
    isPublished: true,
    publishedAt: '2024-01-01',
    summary: 'Renseignez toutes les informations de votre bien pour une gestion optimale.',
    intro: `Une fiche bien complète vous permet d'avoir une vue d'ensemble précise de votre patrimoine et d'activer des fonctionnalités avancées comme la génération d'exports ou le CIL.`,
    description: `La fiche d'un bien contient plusieurs onglets : Informations, Pièces, Équipements et Documents. L'onglet Informations centralise les données descriptives du bien (surface, année de construction, valeur estimée, adresse). Vous pouvez remplir ces champs manuellement ou laisser Verebona les déduire automatiquement depuis vos documents importés.`,
    steps: [
      { title: 'Ouvrir la fiche du bien', body: 'Depuis **Mes biens**, cliquez sur le bien que vous souhaitez compléter.' },
      { title: `Aller dans l'onglet Informations`, body: `Cliquez sur l'onglet **Informations** en haut de la fiche.` },
      { title: 'Remplir les champs manuellement', body: `Renseignez la surface, l'année de construction, la valeur estimée et l'adresse complète directement dans les champs.` },
      { title: '« Alimenter depuis les documents »', body: `Si vous avez importé des documents (acte, DPE…), cliquez sur **Alimenter depuis les documents** pour que l'IA propose automatiquement les valeurs détectées.` },
      { title: 'Enregistrer les modifications', body: 'Cliquez sur **Enregistrer** pour valider. Les informations sont immédiatement mises à jour.' },
    ],
    illustration: '/aide/completer-fiche-bien.jpg',
  },
  {
    slug: 'ajouter-un-document',
    title: 'Ajouter un document',
    seoTitle: 'Ajouter un document',
    tags: { themes: ['documents'], offers: ['standard'], states: [] },
    isPublished: true,
    publishedAt: '2024-01-01',
    summary: 'Importez une facture, garantie, contrat ou tout autre document lié à vos biens.',
    intro: `Centraliser vos documents dans Verebona vous permet de les retrouver en quelques secondes, de ne jamais perdre une garantie ou une facture, et de déclencher l'analyse automatique par l'IA.`,
    description: `Vous pouvez importer n'importe quel type de fichier : PDF, image (JPG, PNG), document Word ou Excel. Chaque document peut être associé à un bien, une pièce ou un équipement précis. Après l'import, Verebona analyse automatiquement le contenu pour en extraire les informations clés.`,
    steps: [
      { title: `Accéder à Mes documents ou à la fiche d'un bien`, body: `Vous pouvez ajouter un document depuis **Mes documents** (vue globale) ou directement depuis l'onglet **Documents** d'un bien.` },
      { title: '« Ajouter un document »', body: 'Cliquez sur le bouton **Ajouter un document** ou glissez-déposez votre fichier dans la zone prévue.' },
      { title: 'Sélectionner le fichier', body: 'Choisissez le fichier depuis votre ordinateur. Les formats acceptés sont : PDF, JPG, PNG, DOCX, XLSX.' },
      { title: 'Associer au bon bien', body: `Si ce n'est pas déjà fait, sélectionnez le bien auquel ce document appartient dans le champ **Bien associé**.` },
      { title: `Valider l'import`, body: `Cliquez sur **Importer**. L'analyse IA démarre automatiquement. Vous recevrez une notification quand les propositions sont prêtes.` },
    ],
    illustration: '/aide/ajouter-un-document.jpg',
  },
  {
    slug: 'comprendre-analyse-automatique',
    title: `Comprendre l'analyse automatique`,
    seoTitle: `Comprendre l'analyse automatique des documents`,
    tags: { themes: ['documents', 'ia'], offers: ['standard'], states: [] },
    isPublished: true,
    publishedAt: '2024-01-01',
    summary: 'Découvrez comment Verebona extrait automatiquement les informations de vos documents.',
    intro: `Après chaque import, Verebona lit votre document et propose automatiquement le titre, le type, la date, le montant et le fournisseur — vous n'avez plus qu'à valider ou corriger.`,
    description: `L'analyse automatique est réalisée par une IA spécialisée dans les documents de gestion de patrimoine. Elle lit le texte, les images et les tableaux pour identifier les informations structurées. Pour les photos, elle produit une description visuelle exhaustive qui rend vos images retrouvables par la recherche. Les propositions sont présentées dans un panneau de validation avant d'être enregistrées.`,
    steps: [
      { title: 'Importer un document', body: `L'analyse démarre automatiquement après l'import. Vous pouvez suivre sa progression dans la section **À traiter**.` },
      { title: 'Recevoir la notification', body: `Une notification apparaît dans la cloche en haut de l'écran quand les propositions sont prêtes.` },
      { title: 'Ouvrir le panneau de validation', body: `Cliquez sur la notification ou sur le document pour ouvrir le tiroir d'analyse. Les champs extraits sont pré-remplis.` },
      { title: 'Vérifier les propositions', body: 'Pour chaque champ (titre, type, date, montant…), vérifiez la valeur proposée. Vous pouvez la modifier si besoin.' },
      { title: 'Valider ou rejeter', body: 'Cliquez sur **Valider** pour enregistrer les informations. Les propositions rejetées ne seront pas écrites.' },
    ],
    illustration: '/aide/comprendre-analyse-automatique.jpg',
  },
  {
    slug: 'ajouter-evenement-agenda',
    title: 'Ajouter un événement agenda',
    seoTitle: 'Ajouter un événement à son agenda patrimonial',
    tags: { themes: ['agenda'], offers: ['standard'], states: [] },
    isPublished: true,
    publishedAt: '2024-01-01',
    summary: 'Planifiez une échéance, un rappel ou une intervention depuis Mon agenda.',
    intro: `L'agenda Verebona vous permet de ne jamais rater une échéance importante : renouvellement d'assurance, contrôle de chaudière, fin de garantie ou prochaine intervention planifiée.`,
    description: `Les événements agenda sont liés à vos biens. Ils peuvent être créés manuellement ou générés automatiquement par l'IA lors de l'analyse d'un document (ex : une facture crée un événement "Achat", un contrat d'assurance crée un rappel de renouvellement). Vous recevez une notification avant chaque échéance.`,
    steps: [
      { title: 'Ouvrir Mon agenda', body: 'Depuis le menu principal, cliquez sur **Mon agenda**.' },
      { title: '« Ajouter un événement »', body: 'Cliquez sur le bouton **Ajouter un événement** en haut à droite.' },
      { title: 'Renseigner le titre et la date', body: `Donnez un titre explicite à l'événement (ex : "Révision chaudière 2025") et sélectionnez la date de l'échéance.` },
      { title: 'Associer à un bien', body: `Sélectionnez le bien concerné dans le champ **Bien associé**. Cela permet de retrouver l'événement depuis la fiche du bien.` },
      { title: 'Enregistrer', body: `Cliquez sur **Enregistrer**. L'événement apparaît dans la vue calendrier et vous recevrez un rappel avant la date.` },
    ],
    illustration: '/aide/ajouter-evenement-agenda.jpg',
  },
  {
    slug: 'utiliser-la-recherche',
    title: 'Utiliser la recherche',
    seoTitle: 'Utiliser la recherche globale dans Verebona',
    tags: { themes: ['recherche'], offers: ['standard'], states: [] },
    isPublished: true,
    publishedAt: '2024-01-01',
    summary: 'Trouvez rapidement un bien, un document ou un événement grâce à la recherche globale.',
    intro: 'La recherche globale de Verebona parcourt simultanément vos biens, documents, équipements et événements — y compris le contenu analysé de vos fichiers et la description de vos photos.',
    description: `La recherche est alimentée par l'analyse IA de vos documents. Pour les PDF, elle retrouve les numéros de référence, les montants, les dates et les noms. Pour les photos, elle retrouve les éléments visuels décrits par l'IA (ex : taper "volet bleu" ou "parquet chêne" pour retrouver la photo correspondante). La recherche est instantanée et ne nécessite pas de validation préalable.`,
    steps: [
      { title: 'Cliquer sur la barre de recherche', body: `La barre de recherche est accessible depuis le haut de n'importe quelle page de l'application.` },
      { title: 'Taper votre mot-clé', body: `Saisissez n'importe quel terme : nom d'un bien, d'un fournisseur, d'un équipement, ou un mot décrivant un document ou une photo.` },
      { title: 'Explorer les résultats', body: 'Les résultats apparaissent en temps réel, regroupés par catégorie : Biens, Documents, Équipements, Événements.' },
      { title: 'Affiner si nécessaire', body: 'Ajoutez des mots-clés supplémentaires pour affiner les résultats. Plusieurs termes peuvent être combinés.' },
      { title: 'Ouvrir un résultat', body: `Cliquez sur un résultat pour l'ouvrir directement. Pour les documents, le tiroir s'affiche avec toutes les informations.` },
    ],
    illustration: '/aide/utiliser-la-recherche.jpg',
  },
  {
    slug: 'traiter-documents-incomplets',
    title: 'Traiter les documents incomplets',
    seoTitle: 'Traiter les documents incomplets dans Verebona',
    tags: { themes: ['documents'], offers: ['standard'], states: [] },
    isPublished: true,
    publishedAt: '2024-01-01',
    summary: 'Complétez les informations manquantes des documents analysés automatiquement.',
    intro: `La section **À traiter** regroupe tous les documents dont l'analyse automatique est terminée et qui attendent votre validation — c'est votre file de travail quotidienne.`,
    description: `Après chaque analyse, Verebona ne modifie pas vos données sans votre accord. Les propositions sont mises en attente dans la section "À traiter" jusqu'à ce que vous les validiez ou rejetiez. Certains documents peuvent avoir des informations partiellement détectées : vous pouvez compléter les champs manquants directement dans le tiroir.`,
    steps: [
      { title: 'Accéder à la section À traiter', body: 'Depuis le tableau de bord ou le menu, cliquez sur **À traiter**. Le nombre de documents en attente est affiché en badge.' },
      { title: 'Sélectionner un document', body: `Cliquez sur un document de la liste pour ouvrir son tiroir d'analyse.` },
      { title: 'Vérifier chaque champ', body: `Les champs extraits par l'IA sont affichés avec leur valeur proposée. Les champs en orange indiquent une faible confiance ou une information manquante.` },
      { title: 'Corriger si nécessaire', body: 'Modifiez directement les valeurs qui ne vous semblent pas correctes avant de valider.' },
      { title: 'Valider le document', body: `Cliquez sur **Valider** pour enregistrer toutes les informations. Le document est retiré de la file "À traiter".` },
    ],
    illustration: '/aide/traiter-documents-incomplets.jpg',
  },
  {
    slug: 'generer-un-export',
    title: 'Générer un export',
    seoTitle: 'Générer un export de son patrimoine',
    tags: { themes: ['export'], offers: ['premium'], states: [] },
    isPublished: true,
    publishedAt: '2024-01-01',
    summary: 'Exportez vos données patrimoniales en PDF ou CSV (offre Premium).',
    intro: `L'export vous permet de produire un document de synthèse de votre patrimoine — idéal pour un dossier bancaire, une succession, ou simplement pour garder une copie hors ligne.`,
    description: `Disponible avec l'offre Premium, l'export génère un fichier PDF ou CSV contenant vos biens, documents, équipements et événements agenda selon les sections que vous sélectionnez. Les exports PDF sont mis en page automatiquement avec le logo Verebona et sont prêts à être partagés.`,
    steps: [
      { title: `Accéder à la fonction export`, body: `Depuis la fiche d'un bien ou depuis le tableau de bord, cliquez sur **Exporter**. Vous pouvez aussi accéder à cette fonction depuis le menu principal.` },
      { title: 'Choisir le format', body: 'Sélectionnez **PDF** pour un document mis en page prêt à imprimer, ou **CSV** pour un tableau de données brutes.' },
      { title: `Sélectionner les sections à inclure`, body: `Cochez les sections à inclure dans l'export : Biens, Documents, Équipements, Agenda. Vous pouvez tout sélectionner ou choisir uniquement ce qui vous intéresse.` },
      { title: 'Définir la période', body: 'Pour les exports incluant des documents ou événements, vous pouvez filtrer par période en définissant une date de début et de fin.' },
      { title: `Générer et télécharger`, body: `Cliquez sur **Générer l'export**. Le fichier est prêt en quelques secondes et se télécharge automatiquement.` },
    ],
    illustration: '/aide/generer-un-export.jpg',
  },
  {
    slug: 'inviter-proche-duo',
    title: 'Inviter un proche (offre Duo)',
    seoTitle: 'Inviter un proche dans son espace Duo',
    tags: { themes: ['partage'], offers: ['premium_duo'], states: [] },
    isPublished: true,
    publishedAt: '2024-01-01',
    summary: `Partagez votre espace patrimonial avec un proche grâce à l'offre Duo.`,
    intro: `L'offre Duo permet à deux personnes de gérer le même patrimoine ensemble — idéal pour un couple, des cohabitants ou un gestionnaire et son client.`,
    description: `Avec l'offre Duo, votre proche a accès à l'ensemble de vos biens, documents et événements. Il peut consulter, ajouter et modifier des éléments selon les permissions que vous lui accordez. Chacun garde un accès indépendant avec son propre compte et ses propres identifiants.`,
    steps: [
      { title: `Souscrire à l'offre Duo`, body: 'Depuis **Mon compte > Abonnement**, sélectionnez l\'offre **Duo** et confirmez votre souscription.' },
      { title: 'Accéder aux paramètres de partage', body: 'Depuis **Mon compte**, cliquez sur l\'onglet **Partage & accès**.' },
      { title: `Saisir l'adresse email de votre proche`, body: 'Entrez l\'adresse email de la personne que vous souhaitez inviter dans le champ prévu.' },
      { title: `Définir le niveau d'accès`, body: 'Choisissez entre **Accès complet** (consultation et modification) ou **Lecture seule** (consultation uniquement).' },
      { title: `Envoyer l'invitation`, body: `Cliquez sur **Envoyer l'invitation**. Votre proche recevra un email avec un lien pour rejoindre votre espace Duo.` },
    ],
    illustration: '/aide/inviter-proche-duo.jpg',
  },
  {
    slug: 'ajouter-une-piece',
    title: 'Ajouter une pièce',
    seoTitle: 'Ajouter une pièce à un bien immobilier',
    tags: { themes: ['biens'], offers: ['standard'], states: [] },
    isPublished: true,
    publishedAt: '2024-01-01',
    summary: 'Structurez votre bien par pièces pour une organisation plus précise.',
    intro: `Décomposer un bien en pièces vous permet d'associer précisément équipements et documents à chaque espace, et de retrouver en un clic tout ce qui concerne la cuisine ou la salle de bain.`,
    description: `Les pièces sont disponibles pour les biens de type immobilier. Elles permettent de qualifier l'emplacement d'un équipement ou d'un document. Un document peut être lié à une pièce précise (ex : la facture du carrelage de la salle de bain), tout comme un équipement (ex : le lave-vaisselle de la cuisine).`,
    steps: [
      { title: 'Ouvrir la fiche du bien', body: 'Depuis **Mes biens**, cliquez sur le bien immobilier auquel vous souhaitez ajouter une pièce.' },
      { title: `Accéder à l'onglet Pièces`, body: `Cliquez sur l'onglet **Pièces** en haut de la fiche.` },
      { title: '« Ajouter une pièce »', body: 'Cliquez sur le bouton **Ajouter une pièce** en haut à droite.' },
      { title: 'Nommer la pièce', body: 'Saisissez le nom de la pièce (ex : "Cuisine", "Salle de bain", "Chambre parentale") puis cliquez sur **Enregistrer**.' },
      { title: 'Associer équipements et documents', body: 'Une fois la pièce créée, vous pouvez y associer des équipements et des documents depuis leurs fiches respectives.' },
    ],
    illustration: '/aide/ajouter-une-piece.jpg',
  },
  {
    slug: 'ajouter-un-equipement',
    title: 'Ajouter un équipement',
    seoTitle: 'Ajouter un équipement à un bien',
    tags: { themes: ['biens'], offers: ['standard'], states: [] },
    isPublished: true,
    publishedAt: '2024-01-01',
    summary: 'Référencez vos équipements (chaudière, VMC, climatisation…) depuis la fiche de votre bien.',
    intro: `Référencer vos équipements dans Verebona vous permet de centraliser leurs documents (notices, factures, contrats d'entretien) et de suivre leurs dates d'installation et de garantie.`,
    description: `Un équipement est un appareil ou une installation rattaché à un bien : chaudière, VMC, climatiseur, chauffe-eau, tableau électrique, porte de garage, etc. Chaque équipement dispose de sa propre fiche avec ses caractéristiques techniques, ses documents et ses événements agenda associés.`,
    steps: [
      { title: 'Ouvrir la fiche du bien', body: 'Depuis **Mes biens**, cliquez sur le bien concerné.' },
      { title: `Accéder à l'onglet Équipements`, body: `Cliquez sur l'onglet **Équipements**.` },
      { title: '« Ajouter un équipement »', body: 'Cliquez sur **Ajouter un équipement** pour ouvrir le formulaire.' },
      { title: 'Renseigner les caractéristiques', body: `Saisissez la marque, le modèle, la date d'installation et la durée de garantie si connue. Associez-le à une pièce si pertinent.` },
      { title: 'Importer les documents associés', body: `Après la création, vous pouvez glisser directement la notice, la facture ou le contrat d'entretien dans l'onglet **Documents** de la fiche équipement.` },
    ],
    illustration: '/aide/ajouter-un-equipement.jpg',
  },
  {
    slug: 'gerer-mon-compte',
    title: 'Gérer mon compte',
    seoTitle: 'Gérer son compte Verebona',
    tags: { themes: ['compte'], offers: ['standard'], states: [] },
    isPublished: true,
    publishedAt: '2024-01-01',
    summary: 'Modifiez vos informations personnelles, mot de passe et préférences depuis Mon compte.',
    intro: 'La section Mon compte centralise toutes vos préférences personnelles : profil, sécurité, abonnement et notifications.',
    description: `Depuis Mon compte, vous gérez l'ensemble de votre relation avec Verebona : informations de profil, changement de mot de passe, gestion de l'abonnement, et paramètres de notification. Vous pouvez aussi consulter l'historique des connexions et supprimer votre compte si nécessaire.`,
    steps: [
      { title: 'Accéder à Mon compte', body: `Cliquez sur votre avatar en haut à droite de l'application, puis sur **Mon compte**.` },
      { title: 'Modifier vos informations personnelles', body: 'Dans l\'onglet **Profil**, modifiez votre prénom, nom et adresse email, puis cliquez sur **Enregistrer**.' },
      { title: 'Changer votre mot de passe', body: 'Dans l\'onglet **Sécurité**, cliquez sur **Modifier le mot de passe**. Saisissez votre mot de passe actuel puis le nouveau.' },
      { title: 'Gérer votre abonnement', body: 'Dans l\'onglet **Abonnement**, consultez votre offre actuelle, la date de renouvellement et les options pour passer à Premium ou Duo.' },
      { title: 'Configurer les notifications', body: 'Dans l\'onglet **Notifications**, activez ou désactivez les alertes par email et les notifications push selon vos préférences.' },
    ],
    illustration: '/aide/gerer-mon-compte.jpg',
  },
];

export const HELP_QUICK_LINKS = [
  { slug: 'creer-un-bien', title: 'Créer un bien' },
  { slug: 'ajouter-un-document', title: 'Ajouter un document' },
  { slug: 'traiter-documents-incomplets', title: 'Traiter les documents incomplets' },
  { slug: `comprendre-analyse-automatique`, title: `Comprendre l'analyse automatique` },
  { slug: 'ajouter-evenement-agenda', title: 'Ajouter un événement agenda' },
];
