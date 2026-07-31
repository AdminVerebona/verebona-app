import { db } from '@/db';
import { emailSettings } from '@/db/schema';

export async function seedEmailSettings() {
    const singletonSettings = {
        id: 1,
        emailsEnabled: true,
        senderName: 'Verebona',
        senderEmail: 'noreply@verebona.com',
        replyToEmail: 'support@verebona.com',
        primaryColor: '#3B82F6',
        footerText: null,
        updatedAt: new Date(),
        updatedBy: null,
    };

    await db.insert(emailSettings).values(singletonSettings);
    
}

// ⚠️ Exécution CONDITIONNELLE.
//
// Ce module est désormais importable par `/api/cron/seed`, qui l'appelle
// explicitement. Sans cette garde, le seul fait d'importer le fichier
// déclencherait l'amorçage — donc à chaque démarrage du serveur, effaçant
// et réécrivant les gabarits en boucle.
if (process.argv[1]?.includes('email_settings')) {
  seedEmailSettings()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('[seed] échec :', error.message);
      process.exit(1);
    });
}
