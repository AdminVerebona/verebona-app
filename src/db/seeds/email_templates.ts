import { db } from '@/db';
import { emailTemplates } from '@/db/schema';

export async function seedBaseEmailTemplates() {
    const sampleEmailTemplates = [
        {
            type: 'WELCOME',
            subject: 'Bienvenue sur Verebona',
            body: 'Bonjour {{firstName}}, bienvenue sur Verebona ! Nous sommes ravis de vous compter parmi nous.',
            placeholders: JSON.stringify(['firstName']),
            updatedAt: new Date(),
            updatedBy: null,
        },
        {
            type: 'PASSWORD_RESET',
            subject: 'Réinitialisation de votre mot de passe',
            body: 'Bonjour, vous avez demandé à réinitialiser votre mot de passe. Cliquez sur le lien suivant : {{resetUrl}}',
            placeholders: JSON.stringify(['resetUrl']),
            updatedAt: new Date(),
            updatedBy: null,
        },
        {
            type: 'SUBSCRIPTION_EXPIRING',
            subject: 'Votre abonnement expire bientôt',
            body: 'Bonjour {{firstName}}, votre abonnement Verebona expire le {{expiryDate}}. Pensez à le renouveler pour continuer à profiter de nos services.',
            placeholders: JSON.stringify(['firstName', 'expiryDate']),
            updatedAt: new Date(),
            updatedBy: null,
        }
    ];

    // Rejouable : ce seed est appelé par `/api/cron/seed`, donc à chaque
    // amorçage. `type` porte un index unique — sans cette clause, un
    // second passage échouerait en 23505.
    //
    // `DO UPDATE` et non `DO NOTHING` : un gabarit corrigé dans le code doit
    // se propager. Les modifications faites en back-office sont, elles,
    // écrasées — c'est le comportement attendu d'un gabarit de référence.
    for (const gabarit of sampleEmailTemplates) {
      await db
        .insert(emailTemplates)
        .values(gabarit)
        .onConflictDoUpdate({ target: emailTemplates.type, set: gabarit });
    }
    
}

// ⚠️ Exécution CONDITIONNELLE.
//
// Ce module est désormais importable par `/api/cron/seed`, qui l'appelle
// explicitement. Sans cette garde, le seul fait d'importer le fichier
// déclencherait l'amorçage — donc à chaque démarrage du serveur, effaçant
// et réécrivant les gabarits en boucle.
if (process.argv[1]?.includes('email_templates')) {
  seedBaseEmailTemplates()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('[seed] échec :', error.message);
      process.exit(1);
    });
}
