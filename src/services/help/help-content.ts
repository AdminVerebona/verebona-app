/**
 * Contenu du centre d'aide — 4 catégories, 12 articles.
 * Source de vérité côté front (même structure que help/verebona-help-v1.fr-FR.json).
 */

export interface HelpPara { step?: number; text: string }
export interface HelpArticle {
  id: string;
  cat: HelpCatId;
  title: string;
  excerpt: string;
  updated: string; // affiché tel quel : « le 12 juillet 2026 »
  paras: HelpPara[];
}
export type HelpCatId = 'start' | 'docs' | 'echeances' | 'compte';

export const HELP_CATS: Record<HelpCatId, string> = {
  start: 'Premiers pas',
  docs: 'Biens et documents',
  echeances: 'Échéances et rappels',
  compte: 'Compte et sécurité',
};

export const HELP_ARTICLES: HelpArticle[] = [
  { id: 'premier-bien', cat: 'start', title: 'Ajouter votre premier bien', excerpt: 'Créez la fiche d\u2019un bien en moins d\u2019une minute.', updated: 'le 12 juillet 2026', paras: [
    { text: 'Un bien est la fiche centrale de Verebona : documents, informations et échéances s\u2019y rattachent. Commencez par lui.' },
    { step: 1, text: 'Cliquez sur le bouton « + » de la barre latérale, puis « Ajouter un bien ».' },
    { step: 2, text: 'Donnez-lui un nom clair (« Appartement Lyon »), une catégorie et, si vous la connaissez, sa date d\u2019achat.' },
    { step: 3, text: 'Ajoutez une photo : elle rend la carte reconnaissable d\u2019un coup d\u2019œil.' },
    { text: 'Enregistrez. Vous pouvez maintenant importer ses documents — Verebona les lit et les classe pour vous.' },
  ] },
  { id: 'decouvrir-accueil', cat: 'start', title: 'Comprendre votre page d\u2019accueil', excerpt: 'À faire, prochaines dates, coup d\u2019œil : lisez votre situation en un regard.', updated: 'le 12 juillet 2026', paras: [
    { text: 'L\u2019accueil est votre résumé de situation. La mascotte vous dit l\u2019essentiel : ce qui attend une action, et ce qui arrive.' },
    { text: '« À faire » liste les actions attendues, la plus urgente en premier. « En un coup d\u2019œil » compte vos biens, événements, documents et éléments à traiter — chaque carte ouvre la page correspondante.' },
    { text: '« Prochaines dates » anticipe les échéances ; « Verebona a organisé pour vous » montre ce qui a été complété automatiquement.' },
  ] },
  { id: 'assistant', cat: 'start', title: 'Poser une question à Verebona', excerpt: 'L\u2019assistant répond à partir de vos données et cite ses sources.', updated: 'le 20 juillet 2026', paras: [
    { text: 'Verebona connaît vos biens, vos documents, vos échéances et le centre d\u2019aide. Posez votre question en français courant.' },
    { step: 1, text: 'Cliquez sur la mascotte en bas à droite (« Demander à Verebona »).' },
    { step: 2, text: 'Tapez votre question, ou choisissez une suggestion.' },
    { step: 3, text: 'La réponse cite ses sources : cliquez-les pour ouvrir l\u2019écran concerné.' },
    { text: 'Les réponses décrivent votre compte ; elles ne constituent ni une certification, ni une validation juridique, ni un conseil juridique.' },
  ] },
  { id: 'import-analyse', cat: 'docs', title: 'Importer un document et valider l\u2019analyse automatique', excerpt: 'Déposez un fichier, Verebona en extrait les informations utiles.', updated: 'le 28 juillet 2026', paras: [
    { text: 'Quand vous importez un document, Verebona le lit et en extrait le type, la date, le montant et le fournisseur, puis le rattache au bon bien.' },
    { step: 1, text: 'Bouton « + » → « Ajouter un document », puis déposez votre fichier (PDF, JPG, PNG · 10 Mo max).' },
    { step: 2, text: 'Laissez « Détection automatique » ou choisissez le type vous-même.' },
    { step: 3, text: 'Quand l\u2019analyse est terminée, l\u2019élément apparaît dans « À traiter » : vérifiez les informations extraites et validez.' },
    { text: 'Vous validez, c\u2019est classé. Une information douteuse reste modifiable à tout moment depuis la fiche du document.' },
  ] },
  { id: 'dossier-vente', cat: 'docs', title: 'Préparer un dossier de vente', excerpt: 'Exportez en un geste tout l\u2019historique d\u2019un bien.', updated: 'le 15 juin 2026', paras: [
    { text: 'Quand il est temps de vendre, le dossier est déjà assemblé : factures, entretiens, diagnostics et notices rattachés au bien.' },
    { step: 1, text: 'Ouvrez la fiche du bien concerné.' },
    { step: 2, text: 'Choisissez « Exporter le dossier » : Verebona compose un document unique, daté et ordonné.' },
    { step: 3, text: 'Partagez le PDF avec l\u2019acheteur ou votre notaire.' },
  ] },
  { id: 'organiser-docs', cat: 'docs', title: 'Retrouver et organiser vos documents', excerpt: 'Filtres par type, recherche, rattachement à un bien.', updated: 'le 3 juillet 2026', paras: [
    { text: '« Mes documents » regroupe tout, tous biens confondus. Les filtres (Factures, Contrats, Diagnostics) réduisent la liste en un clic.' },
    { text: 'La recherche de la barre du haut trouve un document par son nom, son fournisseur ou son montant.' },
    { text: 'Un document sans bien ? Ouvrez-le puis « Modifier » pour le rattacher — les échéances liées suivront.' },
  ] },
  { id: 'archiver-bien', cat: 'docs', title: 'Archiver ou supprimer un bien', excerpt: 'Conservez l\u2019historique sans encombrer vos listes.', updated: 'le 3 juillet 2026', paras: [
    { text: 'Archivez un bien vendu ou donné : sa fiche et ses documents restent consultables, mais il quitte vos listes actives.' },
    { text: 'La suppression, elle, est définitive : Verebona demande toujours une confirmation, et les documents et échéances liés ne sont plus suivis.' },
  ] },
  { id: 'rappels', cat: 'echeances', title: 'Configurer les rappels d\u2019échéances', excerpt: 'Choisissez quand Verebona vous prévient.', updated: 'le 22 juillet 2026', paras: [
    { text: 'Chaque événement d\u2019agenda porte son propre rappel : 30 jours avant, 7 jours avant, la veille, ou aucun.' },
    { step: 1, text: 'Ouvrez « Mon compte » → « Notifications ».' },
    { step: 2, text: 'Activez ou coupez chaque famille de notifications (rappels, retards, fin d\u2019analyse, résumé hebdomadaire).' },
    { step: 3, text: 'Pour un événement précis, modifiez son rappel depuis sa fiche dans « Mon agenda ».' },
  ] },
  { id: 'retard', cat: 'echeances', title: 'Traiter une échéance en retard', excerpt: 'Le rouge signifie « en retard » — voici comment le résorber.', updated: 'le 22 juillet 2026', paras: [
    { text: 'Une échéance dépassée passe en rouge et remonte en tête de « À faire » et de « À traiter ».' },
    { step: 1, text: 'Ouvrez l\u2019événement, puis choisissez « Traiter ».' },
    { step: 2, text: 'Une fois l\u2019action réalisée (révision faite, contrat renouvelé…), marquez l\u2019événement « Réalisé ».' },
    { text: 'L\u2019événement passe en teal « Réalisé » et reste dans l\u2019historique du bien.' },
  ] },
  { id: 'vues-agenda', cat: 'echeances', title: 'Utiliser les vues Liste, Mensuel et Annuel', excerpt: 'Trois lectures du même agenda.', updated: 'le 30 juin 2026', paras: [
    { text: 'La vue Liste ordonne les événements par date. La vue Mensuel les place sur un calendrier. La vue Annuel donne la charge de l\u2019année, mois par mois.' },
    { text: 'Dans toutes les vues, cliquer un événement ouvre sa fiche : modifier, marquer réalisé, supprimer.' },
  ] },
  { id: 'duo', cat: 'compte', title: 'Partager vos biens avec un compte Duo', excerpt: 'Deux personnes, un espace commun.', updated: 'le 18 juillet 2026', paras: [
    { text: 'Premium Duo ouvre votre espace à un second membre : mêmes biens, mêmes documents, mêmes échéances.' },
    { step: 1, text: 'Ouvrez « Mon compte » → « Mon offre » et choisissez Premium Duo.' },
    { step: 2, text: 'Invitez votre proche par e-mail : il crée son accès personnel.' },
    { step: 3, text: 'Chacun garde son mot de passe ; les modifications sont visibles des deux.' },
  ] },
  { id: 'securite', cat: 'compte', title: 'Sécurité de vos données', excerpt: 'Hébergement en France, chiffrement, sauvegardes.', updated: 'le 10 juin 2026', paras: [
    { text: 'Vos documents sont chiffrés, hébergés en France et sauvegardés automatiquement. L\u2019accès requiert votre mot de passe, renforcé par la double authentification.' },
    { text: 'Verebona ne vend aucune donnée. Vous pouvez exporter ou supprimer l\u2019intégralité de votre compte depuis « Mon compte ».' },
  ] },
];
