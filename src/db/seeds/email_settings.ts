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

    // ⚠️ IDEMPOTENCE INDISPENSABLE.
    //
    // Ce seed était conçu pour une exécution unique en ligne de commande. Le
    // rendre appelable par `/api/cron/seed` le fait rejouer à chaque
    // amorçage : un `INSERT` nu échouerait alors sur la clé primaire.
    //
    // `DO UPDATE` sur les seules colonnes techniques : `emailsEnabled` et
    // l'identité d'expédition sont modifiables depuis le back-office, et un
    // amorçage n'a pas à écraser un réglage voulu.
    await db
      .insert(emailSettings)
      .values(singletonSettings)
      .onConflictDoUpdate({
        target: emailSettings.id,
        set: { updatedAt: new Date() },
      });
    
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
