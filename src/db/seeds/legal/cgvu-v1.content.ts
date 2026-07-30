/**
 * Contenu de la version initiale des CGVU.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ CE TEXTE EST REPRIS TEL QUEL DU SITE VITRINE — IL EST PÉRIMÉ
 *
 * Il provient de `src/views/LegalView.vue` du dépôt `verebona-public`, seul
 * texte contractuel existant à ce jour. Il présente au moins une contradiction
 * connue avec le CDC tarification : l'offre Standard y est définie comme
 * « accessible sans contrepartie financière », alors qu'elle est facturée
 * 2,90 € par mois.
 *
 * Il est amorcé ici DÉLIBÉRÉMENT, pour deux raisons :
 *
 *   1. le dispositif de versionnement a besoin d'une version 1 pour exister ;
 *   2. publier la version corrigée passera par le workflow que ce lot met en
 *      place — ce qui le valide au passage, et laisse l'ancienne version
 *      accessible par son permalien, comme l'exige le §3.3.
 *
 * La rédaction du texte définitif relève du conseil juridique de Verebona, pas
 * du développement. Une fois disponible, il fera l'objet d'une version
 * `AAAA-MM-JJ-v1` publiée par l'administration.
 *
 * ⚠️ Le texte emploie « CGSU » (Conditions Générales d'Utilisation et de
 * Services) là où le CDC 7 impose « CGVU » (Conditions générales de vente et
 * d'utilisation). Le code technique retenu est `CGVU`, conformément au §14.1.
 * Le vocabulaire du texte lui-même n'a pas été modifié : réécrire un document
 * contractuel n'est pas un acte de développement.
 * ══════════════════════════════════════════════════════════════════════════
 */

export const CGVU_V1_VERSION_CODE = '2026-07-30-v1';

export const CGVU_V1_CHANGE_SUMMARY =
  'Version initiale, reprise du texte publié sur verebona.fr. ' +
  'Aucune modification de fond apportée lors de la reprise.';

/** Corps du document, en HTML structuré. Enveloppé à la publication. */
export const CGVU_V1_BODY_HTML = `
      <h2>1. Objet</h2>
      <p>Les présentes Conditions Générales d'Utilisation et de Services (ci-après les « CGSU ») ont pour objet de définir les conditions dans lesquelles :</p>
      <ul>
      <li>la société Verebona (ci-après « Verebona » ou « l'Éditeur ») met à disposition des utilisateurs un service en ligne de gestion et d'organisation d'informations et de documents relatifs à leurs biens patrimoniaux (ci-après le « Service ») ;</li>
      <li>toute personne physique ou morale (ci-après l'« Utilisateur ») accède au Service et l'utilise.</li>
      </ul>
      <p>Les CGSU constituent le socle contractuel de la relation entre Verebona et l'Utilisateur. Toute utilisation du Service implique l'acceptation pleine et entière des CGSU en vigueur au jour de l'utilisation.</p>
      <h2>2. Définitions</h2>
      <p>Aux fins des présentes, les termes suivants ont la signification ci-dessous :</p>
      <p><strong>« Site » :</strong> le site internet édité par Verebona et accessible à l'adresse https://verebona.fr ainsi que l'ensemble de ses sous-domaines et versions mobiles.</p>
      <p><strong>« Service » :</strong> l'ensemble des fonctionnalités proposées par Verebona via le Site, permettant notamment à l'Utilisateur de créer un compte, d'enregistrer certaines informations et documents relatifs à ses biens patrimoniaux, de les organiser et de les consulter.</p>
      <p><strong>« Compte » :</strong> l'espace personnel de l'Utilisateur accessible après authentification, à partir duquel celui-ci peut utiliser le Service.</p>
      <p><strong>« Offre » ou « Offre Standard » :</strong> version du Service accessible sans contrepartie financière, avec des fonctionnalités et/ou un volume limité, telles que décrites sur le Site.</p>
      <p><strong>« Offres Payantes » :</strong> offres d'abonnement (notamment « Premium » et/ou « Pro ») donnant accès à des fonctionnalités et/ou capacités supplémentaires, telles que décrites sur le Site, moyennant le paiement d'un prix.</p>
      <p><strong>« Données » :</strong> l'ensemble des informations, fichiers, contenus et documents, y compris les données à caractère personnel, que l'Utilisateur renseigne ou téléverse dans le cadre du Service.</p>
      <p><strong>« Documents » :</strong> tout fichier ou contenu documentaire (factures, contrats, certificats, photos, etc.) téléversé par l'Utilisateur dans le Service.</p>
      <p><strong>« Documents sensibles » :</strong> tout Document contenant des informations personnelles, patrimoniales, financières et/ou d'identification d'un bien ou d'une personne (notamment factures, justificatifs de propriété, contrats, certificats, attestations, expertises ou tout document dont la perte, l'altération ou la divulgation est susceptible de causer un préjudice matériel ou moral à l'Utilisateur ou à un tiers).</p>
      <p><strong>« Consommateur » :</strong> l'Utilisateur répondant à la définition de consommateur au sens du Code de la consommation.</p>
      <p><strong>« Professionnel » :</strong> l'Utilisateur agissant dans le cadre de son activité commerciale, industrielle, artisanale, libérale ou agricole.</p>
      <h2>3. Acceptation, opposabilité et modification des CGSU</h2>
      <h3>3.1. Acceptation</h3>
      <p>Les CGSU sont portées à la connaissance de l'Utilisateur lors de la création de son Compte et/ou de l'utilisation du Service.</p>
      <p>L'Utilisateur les accepte en cochant la case prévue à cet effet et/ou en poursuivant l'utilisation du Service.</p>
      <h3>3.2. Opposabilité</h3>
      <p>Les CGSU applicables sont celles en vigueur au jour de l'utilisation du Service étant précisé que les conditions tarifaires applicables à une période d'abonnement payée demeurent celles acceptées lors de la souscription/du renouvellement pour ladite période. Elles prévalent sur tout autre document, sauf accord écrit spécifique.</p>
      <h3>3.3. Modification des CGSU</h3>
      <p>Verebona peut modifier les CGSU à tout moment, notamment pour les adapter à l'évolution du Service ou de la réglementation.</p>
      <p>L'Utilisateur sera informé de toute modification substantielle par tout moyen approprié (notification sur le Site, email, etc.). Les modifications tarifaires sont régies par l'article 9.2.</p>
      <p>En cas de désaccord, l'Utilisateur peut résilier son abonnement (désactiver la reconduction) avant l'entrée en vigueur de la nouvelle version. L'utilisation du Service après ce délai vaut acceptation des nouvelles CGSU.</p>
      <h2>4. Accès au Site et au Service</h2>
      <h3>4.1. Accès technique</h3>
      <p>L'Utilisateur dispose, sous sa responsabilité, des moyens techniques et logiciels nécessaires pour accéder à Internet et au Site.</p>
      <p>Les frais de connexion restent à la charge de l'Utilisateur.</p>
      <h3>4.2. Éligibilité</h3>
      <p>Le Service est réservé :</p>
      <ul>
      <li>aux personnes physiques majeures capables juridiquement, ou mineures dûment autorisées par leurs représentants légaux ;</li>
      <li>et/ou aux personnes morales via leurs représentants habilités.</li>
      </ul>
      <p>Verebona peut demander tout justificatif et suspendre ou refuser l'accès en cas de doute raisonnable sur l'éligibilité ou l'identité.</p>
      <h3>4.3. Disponibilité</h3>
      <p>Verebona met en œuvre des moyens raisonnables pour assurer la disponibilité du Site et du Service.</p>
      <p>Le Service peut toutefois être momentanément interrompu, notamment pour maintenance, mise à jour ou cas de force majeure.</p>
      <p>Verebona ne garantit pas la disponibilité continue et sans erreur du Service.</p>
      <h2>5. Description générale du Service</h2>
      <p>Les fonctionnalités du Service (gratuites et payantes) sont décrites sur le Site.</p>
      <p>De manière générale, le Service permet à l'Utilisateur, selon l'Offre choisie :</p>
      <ul>
      <li>de créer et gérer un Compte ;</li>
      <li>d'enregistrer certaines informations relatives à ses biens patrimoniaux ;</li>
      <li>d'importer, stocker et organiser des Documents ;</li>
      <li>de consulter et éventuellement exporter certaines Données.</li>
      </ul>
      <p>Le Service a pour vocation de faciliter la gestion et l'organisation des informations et Documents de l'Utilisateur. Il ne constitue ni :</p>
      <ul>
      <li>un service de conseil juridique, fiscal, comptable, financier ou assurantiel ;</li>
      <li>un service d'archivage électronique qualifié ou à valeur probante ;</li>
      <li>un coffre-fort électronique bénéficiant d'une certification spécifique.</li>
      </ul>
      <p>L'Utilisateur demeure seul responsable des décisions prises sur la base des informations gérées via le Service et de la pertinence du Service au regard de ses besoins propres.</p>
      <h2>6. Création de Compte</h2>
      <h3>6.1. Procédure d'inscription</h3>
      <p>Pour utiliser le Service, l'Utilisateur doit créer un Compte en fournissant les informations demandées (par exemple : nom, prénom, adresse email, mot de passe, etc.).</p>
      <p>L'Utilisateur s'engage à fournir des informations exactes, complètes et à jour, et à les mettre à jour en cas de changement.</p>
      <p>Verebona se réserve le droit de suspendre ou résilier tout Compte créé sur la base d'informations manifestement fausses, inexactes ou usurpant l'identité d'un tiers.</p>
      <h3>6.2. Identifiants</h3>
      <p>Les identifiants de connexion (email, mot de passe) sont personnels et confidentiels.</p>
      <p>L'Utilisateur s'engage à :</p>
      <ul>
      <li>ne pas les communiquer à des tiers ;</li>
      <li>prendre les mesures nécessaires pour éviter toute utilisation non autorisée (mot de passe robuste, non réutilisation, etc.) ;</li>
      <li>informer immédiatement Verebona de toute suspicion de compromission.</li>
      </ul>
      <p>Toute connexion et action effectuée à partir du Compte de l'Utilisateur est réputée effectuée par ce dernier, sauf preuve contraire.</p>
      <h3>6.3. Nombre de Comptes</h3>
      <p>Sauf accord préalable et écrit de Verebona, un Utilisateur ne peut pas créer plusieurs Comptes au titre d'une même identité.</p>
      <h2>7. Utilisation du Service</h2>
      <h3>7.1. Usage conforme</h3>
      <p>L'Utilisateur s'engage à utiliser le Service :</p>
      <ul>
      <li>conformément aux lois et règlements en vigueur ;</li>
      <li>conformément aux présentes CGSU ;</li>
      <li>dans le respect des droits de Verebona et des tiers.</li>
      </ul>
      <h3>7.2. Interdictions</h3>
      <p>Il est notamment interdit à l'Utilisateur de :</p>
      <ul>
      <li>utiliser le Service à des fins illicites, frauduleuses ou contraires à l'ordre public ;</li>
      <li>porter atteinte aux droits de propriété intellectuelle de Verebona ou de tiers ;</li>
      <li>tenter d'accéder de manière non autorisée à d'autres Comptes, systèmes ou Données ;</li>
      <li>contourner les dispositifs de sécurité ou de contrôle ;</li>
      <li>saturer, perturber ou dégrader le fonctionnement du Service ;</li>
      <li>extraire, par tout moyen (notamment scraping), tout ou partie des données, contenus ou structures du Service à des fins autres que l'utilisation normale du Service ;</li>
      <li>utiliser le Service en vue de développer un service concurrent ou de procéder à toute forme de rétro-ingénierie du Service, sauf disposition légale impérative contraire.</li>
      </ul>
      <p>Verebona se réserve le droit de suspendre ou résilier tout Compte en cas de violation des présentes.</p>
      <h2>8. Traitement des documents, OCR, documents sensibles et responsabilités</h2>
      <h3>8.1. Dépôt et traitement technique des Documents</h3>
      <p>L'Utilisateur peut déposer dans le Service des Documents liés à la gestion et à l'organisation de ses biens.</p>
      <p>Verebona traite ces Documents exclusivement pour fournir les fonctionnalités du Service, notamment :</p>
      <ul>
      <li>stockage, prévisualisation et classement des Documents ;</li>
      <li>synchronisation technique et sauvegarde ;</li>
      <li>extraction automatisée de certaines informations selon l'Offre souscrite (par exemple via des technologies de reconnaissance optique de caractères – OCR – ou des technologies similaires), afin d'alimenter ou faciliter certaines fonctionnalités du Service.</li>
      </ul>
      <p>Ces traitements peuvent être réalisés par Verebona ou par des sous-traitants dûment autorisés, y compris situés hors de l'Union européenne, dans le respect des exigences du RGPD. Verebona ne garantit pas que ces traitements seront exclusivement opérés dans l'UE, mais met en œuvre les garanties appropriées prévues par le RGPD en cas de transfert.</p>
      <p>Verebona n'accède pas volontairement au contenu des Documents, sauf :</p>
      <ul>
      <li>pour assurer les traitements techniques ci-dessus ;</li>
      <li>en cas de maintenance, support ou incident de sécurité nécessitant une intervention spécifique ;</li>
      <li>en cas d'obligation légale ou judiciaire ;</li>
      <li>en présence d'un signalement ou d'une suspicion sérieuse de contenu illicite.</li>
      </ul>
      <h3>8.2. Présence éventuelle de données sensibles</h3>
      <p>Les Documents déposés peuvent contenir, selon l'usage que fait l'Utilisateur, des données à caractère personnel, y compris potentiellement des catégories particulières de données au sens de l'article 9 du RGPD (« données sensibles »).</p>
      <p>Verebona :</p>
      <ul>
      <li>n'a pas vocation à collecter, traiter ou analyser de telles données sensibles ;</li>
      <li>n'en sollicite en aucun cas le dépôt ;</li>
      <li>ne peut toutefois empêcher qu'elles figurent dans un Document si l'Utilisateur décide de les y inclure.</li>
      </ul>
      <p>L'Utilisateur reconnaît en conséquence :</p>
      <ul>
      <li>que la présence de telles données relève de sa seule initiative et responsabilité ;</li>
      <li>qu'il est seul responsable du caractère licite, adéquat et pertinent du contenu des Documents ;</li>
      <li>qu'il demeure responsable de toute obligation légale ou réglementaire de conservation, de sécurisation ou de confidentialité applicable à certains documents qu'il téléverse.</li>
      </ul>
      <h3>8.3. Documents sensibles au sens contractuel</h3>
      <p>Indépendamment du RGPD, sont considérés comme Documents sensibles au sens des présentes CGSU tous Documents contenant des informations personnelles, financières, patrimoniales ou permettant d'identifier un bien ou un propriétaire (par exemple : factures, contrats, certificats, documents d'assurance, expertises, numéros de série, adresses).</p>
      <p>L'Utilisateur reconnaît expressément que :</p>
      <ul>
      <li>le Service n'est pas un coffre-fort électronique certifié, ni un service d'archivage électronique à valeur probante ;</li>
      <li>aucune solution numérique ne peut garantir une sécurité ou une disponibilité absolue ;</li>
      <li>il lui appartient de vérifier si le Service est adapté à la sensibilité des Documents téléversés ;</li>
      <li>il demeure seul responsable de conserver toute copie, original ou double qu'il juge nécessaire, notamment pour faire valoir ses droits auprès de tiers (assureurs, vendeurs, administrations, etc.).</li>
      </ul>
      <h3>8.4. Contenus interdits</h3>
      <p>L'Utilisateur s'interdit de téléverser, stocker ou partager via le Service des Documents :</p>
      <ul>
      <li>contraires aux lois et règlements (documents illicites, diffamatoires, injurieux, discriminatoires, haineux, violents, etc.) ;</li>
      <li>portant atteinte aux droits de propriété intellectuelle ou à la vie privée de tiers ;</li>
      <li>contenant des données personnelles de tiers sans base légale suffisante ;</li>
      <li>contenant des virus, malwares ou composants susceptibles de nuire au Service ;</li>
      <li>contenant des catégories particulières de données au sens du RGPD (notamment données de santé, opinions politiques, convictions religieuses ou philosophiques, appartenance syndicale, données biométriques aux fins d'identifier une personne, données relatives à la vie sexuelle ou à l'orientation sexuelle), sauf exception expresse prévue par Verebona.</li>
      </ul>
      <p>Verebona pourra supprimer ou rendre inaccessible tout Document manifestement illicite ou notifié comme tel, et prendre toute mesure nécessaire, y compris la suspension du Compte.</p>
      <h3>8.5. Responsabilité et limites</h3>
      <p>L'Utilisateur :</p>
      <ul>
      <li>demeure seul responsable du contenu des Documents qu'il dépose ;</li>
      <li>garantit que les Documents sont licites et ne portent pas atteinte aux droits de tiers ;</li>
      <li>garantit Verebona contre toute réclamation ou recours de tiers relatifs aux Documents (atteinte à la vie privée, propriété intellectuelle, confidentialité, etc.) ;</li>
      <li>reconnaît que Verebona n'est tenue qu'à une obligation de moyens en matière de sécurité et de conservation des Documents, y compris sensibles.</li>
      </ul>
      <p>Verebona n'est pas responsable :</p>
      <ul>
      <li>des pertes de Documents résultant d'une suppression par l'Utilisateur ou d'une absence de sauvegarde externe de sa part ;</li>
      <li>de l'inadéquation du Service aux besoins spécifiques de l'Utilisateur ;</li>
      <li>des obligations de conservation imposées à l'Utilisateur par la loi ou par un tiers (assureur, vendeur, administration, etc.).</li>
      </ul>
      <p>Certaines copies résiduelles peuvent subsister temporairement dans les systèmes de sauvegarde, sans être accessibles en production, pour la durée strictement nécessaire à la gestion de ces sauvegardes.</p>
      <h2>9. Offres, prix, abonnement et rétractation</h2>
      <h3>9.1. Offres</h3>
      <p>Les différentes Offres (Standard, Payantes) et leurs caractéristiques (fonctionnalités, limites, durée, prix) sont décrites sur le Site.</p>
      <p>Verebona peut modifier ou retirer certaines Offres, sous réserve du respect des engagements en cours et des dispositions applicables aux Utilisateurs ayant déjà souscrit.</p>
      <h3>9.2. Prix</h3>
      <p>Les prix des Offres Payantes sont indiqués sur le Site en euros et toutes taxes comprises (TTC), sauf mention contraire.</p>
      <p>Verebona se réserve le droit de modifier ses tarifs à tout moment pour l'avenir étant précisé que le prix applicable à une période d'abonnement déjà payée reste inchangé jusqu'à son terme.</p>
      <p>Toute modification tarifaire sera notifiée à l'Utilisateur concerné dans un délai raisonnable avant son entrée en vigueur.</p>
      <p>En cas de refus des nouveaux tarifs, l'Utilisateur pourra résilier son abonnement avant l'application des nouveaux prix. À défaut, les nouveaux tarifs seront réputés acceptés.</p>
      <h3>9.3. Facturation et paiement</h3>
      <p>Le paiement des Offres Payantes s'effectue par l'intermédiaire d'un prestataire de paiement tiers (Stripe) selon les modalités indiquées sur le Site.</p>
      <p>En communiquant ses informations de paiement, l'Utilisateur autorise le débit du prix de l'abonnement selon la périodicité choisie (mensuelle, annuelle, etc.).</p>
      <p>En cas de défaut de paiement ou d'incident de paiement :</p>
      <ul>
      <li>Verebona pourra suspendre l'accès au Service payant ;</li>
      <li>et/ou résilier l'abonnement, après notification restée sans effet.</li>
      </ul>
      <h3>9.4. Durée et reconduction</h3>
      <p>Sauf mention contraire, les abonnements aux Offres Payantes sont conclus pour une durée déterminée (par exemple un (1) mois ou un (1) an) avec reconduction tacite à l'identique.</p>
      <p>L'Utilisateur peut à tout moment désactiver la reconduction depuis son Compte, avant la date de renouvellement. La désactivation de la reconduction / résiliation prend effet à l'échéance de la période en cours ; aucun remboursement prorata temporis n'est dû sauf dispositions légales impératives.</p>
      <h3>9.5. Droit de rétractation (Utilisateurs Consommateurs)</h3>
      <p>Lorsque l'Utilisateur a la qualité de Consommateur et souscrit une Offre Payante à distance, il dispose en principe d'un droit de rétractation de quatorze (14) jours à compter de la confirmation de la souscription.</p>
      <p>Si l'Utilisateur demande expressément que l'exécution du Service commence avant la fin du délai de rétractation :</p>
      <ul>
      <li>l'Utilisateur conserve son droit de rétractation tant que le Service n'a pas été intégralement exécuté ;</li>
      <li>en cas d'exercice du droit de rétractation avant la fin du délai de quatorze (14) jours, l'Utilisateur devra verser à Verebona un montant proportionnel au Service fourni jusqu'à la communication de sa décision de se rétracter.</li>
      </ul>
      <p>Le droit de rétractation ne s'applique plus si le Service a été pleinement exécuté avant la fin du délai de rétractation, après accord exprès de l'Utilisateur pour commencer l'exécution du Service et reconnaissance expresse de sa part qu'il perdra alors son droit de rétractation.</p>
      <p>Les modalités d'exercice du droit de rétractation, le cas échéant, sont détaillées sur le Site et rappelées dans la confirmation de commande.</p>
      <h3>9.6. Remboursements</h3>
      <p>En dehors des cas prévus par la loi, les sommes versées au titre des Offres Payantes ne sont pas remboursables, sauf décision contraire de Verebona à titre purement commercial.</p>
      <h2>10. Disponibilité, maintenance et évolutions</h2>
      <h3>10.1. Disponibilité</h3>
      <p>Verebona met en œuvre des moyens raisonnables pour assurer l'accessibilité et le bon fonctionnement du Service. Des interruptions temporaires peuvent intervenir, notamment en cas de maintenance, mise à jour, incident ou force majeure.</p>
      <h3>10.2. Maintenance</h3>
      <p>Verebona peut procéder à des opérations de maintenance planifiées ou non, susceptibles de rendre le Service indisponible.</p>
      <p>Dans la mesure du possible, l'Utilisateur sera informé des maintenances planifiées.</p>
      <h3>10.3. Évolutions</h3>
      <p>Verebona peut faire évoluer le Service, ajouter ou supprimer des fonctionnalités, corriger des erreurs, ou adapter l'interface.</p>
      <p>Ces évolutions peuvent modifier la présentation ou le fonctionnement du Service, sans que cela ne donne droit à un quelconque dédommagement, sous réserve du respect des droits des Utilisateurs ayant souscrit une Offre Payante en cours.</p>
      <h3>10.4. Cessation du Service</h3>
      <p>En cas de cessation définitive du Service, Verebona informera les Utilisateurs avec un préavis raisonnable et, en tout état de cause, d'au moins trente (30) jours, afin de leur permettre de récupérer leurs Documents.</p>
      <p>Au-delà de ce délai, Verebona pourra supprimer les Données et Documents, sauf obligation légale de conservation.</p>
      <h2>11. Sécurité</h2>
      <p>Verebona met en œuvre des mesures techniques et organisationnelles raisonnables pour assurer la sécurité du Service et des Données (contrôles d'accès, chiffrement, etc.), dans le cadre d'une obligation de moyens.</p>
      <p>L'Utilisateur reconnaît que :</p>
      <ul>
      <li>aucune solution technique ne peut garantir une sécurité absolue ;</li>
      <li>il lui appartient de mettre en place ses propres mesures de sécurité (notamment protection de ses terminaux, confidentialité de ses identifiants, sauvegardes externes des Documents et originaux).</li>
      </ul>
      <p>Certaines Données peuvent subsister de manière temporaire dans les systèmes de sauvegarde de Verebona, sans être accessibles en production, pour la durée strictement nécessaire à la gestion de ces sauvegardes.</p>
      <h2>12. Responsabilité</h2>
      <h3>12.1. Responsabilité de Verebona</h3>
      <p>Verebona est responsable des dommages directs, prévisibles et prouvés, causés à l'Utilisateur par un manquement à ses obligations contractuelles, dans le cadre d'une obligation de moyens.</p>
      <p>En particulier, Verebona ne garantit pas :</p>
      <ul>
      <li>l'absence totale d'interruption, de bug ou d'erreur ;</li>
      <li>la conservation éternelle des Documents ;</li>
      <li>l'adéquation du Service aux besoins spécifiques de l'Utilisateur.</li>
      </ul>
      <h3>12.2. Limitations de responsabilité</h3>
      <p>Dans les limites permises par la loi :</p>
      <ul>
      <li>Verebona ne pourra en aucun cas être tenue responsable des dommages indirects, immatériels ou consécutifs, tels que perte de chance, perte de profit, perte de données ou préjudice moral, même si elle a été informée de la possibilité de tels dommages ;</li>
      <li>la responsabilité totale cumulée de Verebona, toutes causes confondues, envers un Utilisateur, est limitée, pour tout Utilisateur, au montant des sommes effectivement versées par l'Utilisateur à Verebona au titre du Service au cours des douze (12) derniers mois précédant le fait générateur.</li>
      </ul>
      <p>Ces limitations ne s'appliquent pas dans les cas où la loi interdit leur exclusion ou limitation, notamment en cas de décès, de dommages corporels causés par la faute de Verebona, ou en cas de faute lourde ou dolosive.</p>
      <p>Pour les Utilisateurs ayant la qualité de Consommateur, les limitations de responsabilité prévues au présent article s'appliquent dans la mesure où elles ne contreviennent pas aux dispositions légales impératives qui leur sont applicables.</p>
      <h3>12.3. Responsabilité de l'Utilisateur</h3>
      <p>L'Utilisateur est seul responsable :</p>
      <ul>
      <li>de l'exactitude, de la licéité et de la pertinence des Données et Documents ;</li>
      <li>de l'usage qu'il fait du Service ;</li>
      <li>de la conservation de ses originaux et de ses propres sauvegardes externes ;</li>
      <li>des dommages causés à Verebona ou à des tiers du fait de l'utilisation du Service ou de la présence de Documents illicites ou portant atteinte aux droits de tiers.</li>
      </ul>
      <p>L'Utilisateur garantit Verebona contre toute réclamation ou recours d'un tiers résultant de :</p>
      <ul>
      <li>l'utilisation du Service ;</li>
      <li>la présence de Documents illicites ou portant atteinte aux droits de tiers.</li>
      </ul>
      <h2>13. Suspension et résiliation</h2>
      <h3>13.1. Suspension par Verebona</h3>
      <p>Verebona peut suspendre immédiatement et sans préavis l'accès d'un Utilisateur au Service en cas :</p>
      <ul>
      <li>de suspicion de fraude ou de tentative d'accès non autorisé ;</li>
      <li>de non-respect manifeste des CGSU ;</li>
      <li>de défaut de paiement pour une Offre Payante ;</li>
      <li>de risque avéré pour la sécurité du Service ou des autres utilisateurs ;</li>
      <li>de signalement ou de suspicion sérieuse de contenus illicites.</li>
      </ul>
      <p>Verebona informera l'Utilisateur de la mesure de suspension par tout moyen utile.</p>
      <h3>13.2. Résiliation par l'Utilisateur</h3>
      <p>L'Utilisateur peut résilier son abonnement à une Offre à tout moment depuis son Compte, la résiliation prenant effet à la fin de la période en cours, sauf disposition contraire spécifique.</p>
      <p>En cas de modification tarifaire notifiée conformément à l'article 9.2, l'Utilisateur peut résilier avant le renouvellement, la résiliation prenant effet à la fin de la période en cours.</p>
      <p>L'Utilisateur peut également demander la suppression définitive de son Compte, ce qui entraîne la suppression ou l'anonymisation des Données dans les conditions prévues à l'article 14.</p>
      <h3>13.3. Résiliation par Verebona</h3>
      <p>Verebona peut résilier le Compte de l'Utilisateur, moyennant un préavis raisonnable, en cas :</p>
      <ul>
      <li>de cessation du Service ;</li>
      <li>ou de manquement grave ou répété de l'Utilisateur aux CGSU, après mise en demeure restée sans effet.</li>
      </ul>
      <p>En cas de manquement particulièrement grave (fraude caractérisée, atteinte majeure à la sécurité, etc.), la résiliation pourra intervenir sans préavis.</p>
      <h3>13.4. Effets de la résiliation</h3>
      <p>En cas de résiliation du Compte :</p>
      <ul>
      <li>l'accès au Service est interrompu ;</li>
      <li>dans la mesure du possible, l'Utilisateur est invité à récupérer ses Documents avant la date effective de clôture.</li>
      </ul>
      <p>Sauf obligation légale de conservation, Verebona pourra supprimer l'ensemble des Données et Documents de l'Utilisateur dans un délai maximum de soixante (60) jours suivant la clôture du Compte.</p>
      <p>Certaines traces peuvent subsister de manière temporaire dans les systèmes de sauvegarde, sans être accessibles en production, pour la durée strictement nécessaire à la gestion desdites sauvegardes.</p>
      <h2>14. Données à caractère personnel</h2>
      <p>Verebona traite des données à caractère personnel dans le cadre du Service, en qualité de responsable de traitement au sens du RGPD.</p>
      <p>Les traitements de données à caractère personnel couvrent notamment :</p>
      <ul>
      <li>la gestion des Comptes Utilisateurs et des Offres (Standard et Payantes) ;</li>
      <li>la fourniture du Service, y compris le stockage et le traitement technique des Documents (cf. article 8) ;</li>
      <li>la gestion de la facturation et du paiement ;</li>
      <li>la sécurité et la maintenance du Service ;</li>
      <li>le cas échéant, la communication d'informations relatives au Service et à ses évolutions.</li>
      </ul>
      <p>Les modalités détaillées de ces traitements (catégories de données, finalités, bases légales, durées de conservation, destinataires, transferts hors Union européenne, droits des personnes concernées, etc.) sont décrites dans la Politique de confidentialité de Verebona, accessible sur le Site.</p>
      <p>L'Utilisateur est invité à en prendre connaissance. En utilisant le Service, l'Utilisateur reconnaît avoir pris connaissance de cette Politique de confidentialité.</p>
      <h2>15. Propriété intellectuelle</h2>
      <h3>15.1. Sur le Site et le Service</h3>
      <p>La structure générale du Site et du Service, ainsi que les contenus édités par Verebona (textes, graphiques, logos, marques, interfaces, logiciels, etc.) sont protégés par le droit d'auteur, le droit des marques et autres droits de propriété intellectuelle.</p>
      <p>Sous réserve des droits expressément concédés à l'Utilisateur, aucun droit de propriété intellectuelle n'est transféré à ce dernier.</p>
      <p>Toute reproduction, représentation, modification, adaptation, diffusion ou exploitation non autorisée est interdite.</p>
      <h3>15.2. Sur les Documents de l'Utilisateur</h3>
      <p>L'Utilisateur conserve ses droits sur les Documents qu'il téléverse.</p>
      <p>Pour les seuls besoins techniques du Service, l'Utilisateur concède à Verebona une licence non exclusive, mondiale, gratuite, pour la durée de l'hébergement des Documents, aux seules fins :</p>
      <ul>
      <li>d'héberger, stocker et sauvegarder les Documents ;</li>
      <li>de permettre la consultation, l'organisation et l'export des Documents via le Service ;</li>
      <li>le cas échéant, de permettre l'extraction automatisée d'informations conformément à l'article 8.</li>
      </ul>
      <p>Cette licence prend fin à la suppression définitive des Documents ou du Compte, sous réserve des contraintes techniques de sauvegarde et des obligations légales de conservation.</p>
      <h2>16. Services et liens tiers</h2>
      <p>Le Service peut intégrer ou renvoyer vers des services ou contenus de tiers (hébergeur, prestataire de paiement, outils d'analyse, liens externes, etc.).</p>
      <p>Verebona n'est pas responsable du contenu, du fonctionnement ni de la sécurité de ces services tiers, qui sont soumis à leurs propres conditions d'utilisation et politiques de confidentialité.</p>
      <p>L'Utilisateur est invité à prendre connaissance des conditions d'utilisation et politiques de confidentialité de ces tiers avant de les utiliser.</p>
      <h2>17. Preuve et archivage</h2>
      <p>Les enregistrements informatiques conservés dans les systèmes de Verebona dans des conditions raisonnables de sécurité seront considérés comme preuves des communications, inscriptions, commandes et paiements intervenus entre l'Utilisateur et Verebona.</p>
      <p>Les notifications relatives aux évolutions tarifaires sont réputées effectuées à la date d'envoi de l'email ou de mise à disposition de l'information dans le Compte.</p>
      <p>Verebona procède à l'archivage des contrats conclus avec les Utilisateurs dans les conditions légales applicables et fournit, sur demande, les éléments nécessaires au Consommateur pour exercer ses droits dans les limites prévues par la loi.</p>
      <h2>18. Droit applicable – Litiges – Médiation</h2>
      <h3>18.1. Droit applicable</h3>
      <p>Les présentes CGSU sont régies par le droit français.</p>
      <h3>18.2. Litiges</h3>
      <p>En cas de litige relatif à l'interprétation ou à l'exécution des CGSU, Verebona et l'Utilisateur s'efforceront de trouver une solution amiable.</p>
      <p>À défaut d'accord amiable dans un délai raisonnable, le litige sera soumis aux tribunaux français compétents, sans préjudice des droits impératifs reconnus au Consommateur par la loi applicable.</p>
      <h3>18.3. Médiation de la consommation (Utilisateurs Consommateurs)</h3>
      <p>Lorsque l'Utilisateur a la qualité de Consommateur, il est informé qu'il peut recourir gratuitement à un médiateur de la consommation en vue de la résolution amiable de tout litige l'opposant à Verebona.</p>
      <p>Verebona a désigné le médiateur suivant :</p>
      <ul>
      <li>[Nom du médiateur de la consommation]</li>
      <li>[Adresse postale]</li>
      <li>[Site / formulaire de saisine]</li>
      </ul>
      <p>Les modalités pratiques de saisine du médiateur sont précisées sur le Site.</p>
      <p>L'Utilisateur peut également recourir à la plateforme européenne de règlement en ligne des litiges, accessible via le site de la Commission européenne.</p>
      <h2>19. Force majeure</h2>
      <p>Aucune des parties ne pourra être tenue responsable d'un manquement à l'une quelconque de ses obligations qui résulterait d'un cas de force majeure au sens du Code civil et de la jurisprudence française, comprenant notamment, sans que cette liste soit exhaustive : pannes générales de réseau, attaques informatiques de grande ampleur, pannes majeures chez les prestataires d'hébergement ou de télécommunications, catastrophes naturelles, actes de guerre, émeutes, grèves généralisées.</p>
      <p>Les obligations de la partie empêchée sont suspendues pendant la durée du cas de force majeure. Si la situation de force majeure se prolonge au-delà de soixante (60) jours, chacune des parties pourra résilier le contrat de plein droit, sans indemnité de part et d'autre, par notification écrite.</p>
      <h2>20. Dispositions diverses et contact</h2>
      <p>Verebona peut céder tout ou partie de ses droits et obligations au titre des présentes CGSU à tout tiers de son choix, notamment dans le cadre d'une opération de restructuration, fusion, acquisition ou cession d'activité, sous réserve d'en informer l'Utilisateur par tout moyen utile.</p>
      <p>Si une clause des CGSU devait être déclarée nulle ou inapplicable, elle serait réputée non écrite, sans affecter la validité des autres dispositions.</p>
      <p>Le fait pour Verebona de ne pas se prévaloir d'un manquement de l'Utilisateur à l'une quelconque de ses obligations ne saurait être interprété comme une renonciation à l'obligation en cause.</p>
      <p>En cas de traduction des présentes CGSU, la version française prévaudra en cas de contradiction.</p>
      <p>Pour toute question relative au Service ou aux CGSU, l'Utilisateur peut contacter Verebona :</p>
      <ul>
      <li>par email : contact@verebona.com</li>
      </ul>
`.trim();
