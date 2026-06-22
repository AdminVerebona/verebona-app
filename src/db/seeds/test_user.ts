import { db } from '@/db';
import { users } from '@/db/schema';
import bcrypt from 'bcrypt';

async function main() {
    const hashedPassword = await bcrypt.hash('Test123!', 10);
    
    const testUser = {
        email: 'test@owntrack.fr',
        passwordHash: hashedPassword,
        firstName: 'Test',
        lastName: 'User',
        username: null,
        company: null,
        planType: 'STANDARD' as const,
        planRenewalDate: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        isActive: true,
        locale: 'fr-FR',
        role: 'USER' as const,
        status: 'ACTIVE' as const,
        lastLoginAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    await db.insert(users).values(testUser);
    
}

main().catch((error) => {
    console.error('❌ Seeder failed:', error);
});