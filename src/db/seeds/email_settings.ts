import { db } from '@/db';
import { emailSettings } from '@/db/schema';

async function main() {
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

main().catch((error) => {
    console.error('❌ Seeder failed:', error);
});