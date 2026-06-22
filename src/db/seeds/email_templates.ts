import { db } from '@/db';
import { emailTemplates } from '@/db/schema';

async function main() {
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

    await db.insert(emailTemplates).values(sampleEmailTemplates);
    
}

main().catch((error) => {
    console.error('❌ Seeder failed:', error);
});