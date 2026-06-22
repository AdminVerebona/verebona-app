import { db } from '@/db';
import { users } from '@/db/schema';
import bcrypt from 'bcrypt';

async function main() {
    const saltRounds = 10;
    
    // Hash passwords
    const adminPasswordHash = await bcrypt.hash('AdminPass123!', saltRounds);
    const johnPasswordHash = await bcrypt.hash('John123!', saltRounds);
    const janePasswordHash = await bcrypt.hash('Jane123!', saltRounds);
    const mikePasswordHash = await bcrypt.hash('Mike123!', saltRounds);
    const sarahPasswordHash = await bcrypt.hash('Sarah123!', saltRounds);
    const davidPasswordHash = await bcrypt.hash('David123!', saltRounds);

    const sampleUsers = [
        {
            email: 'admin@verebona.com',
            passwordHash: adminPasswordHash,
            firstName: 'Admin',
            lastName: 'Verebona',
            username: 'admin',
            company: 'Verebona',
            planType: 'PREMIUM',
            planRenewalDate: new Date('2025-12-31'),
            isActive: true,
            locale: 'fr-FR',
            role: 'ADMIN',
            status: 'ACTIVE',
            lastLoginAt: new Date('2024-01-15'),
            createdAt: new Date('2024-01-01'),
            updatedAt: new Date('2024-01-15'),
        },
        {
            email: 'john.doe@example.com',
            passwordHash: johnPasswordHash,
            firstName: 'John',
            lastName: 'Doe',
            username: 'johndoe',
            company: 'Tech Solutions',
            planType: 'STANDARD',
            isActive: true,
            locale: 'fr-FR',
            role: 'USER',
            status: 'ACTIVE',
            lastLoginAt: new Date('2024-01-20'),
            createdAt: new Date('2024-01-15'),
            updatedAt: new Date('2024-01-20'),
        },
        {
            email: 'jane.smith@example.com',
            passwordHash: janePasswordHash,
            firstName: 'Jane',
            lastName: 'Smith',
            username: 'janesmith',
            company: 'Business Corp',
            planType: 'STARTER',
            planRenewalDate: new Date('2024-06-15'),
            stripeCustomerId: 'cus_abc123',
            stripeSubscriptionId: 'sub_xyz789',
            isActive: true,
            locale: 'fr-FR',
            role: 'USER',
            status: 'ACTIVE',
            lastLoginAt: new Date('2024-01-22'),
            createdAt: new Date('2024-01-18'),
            updatedAt: new Date('2024-01-22'),
        },
        {
            email: 'mike.johnson@example.com',
            passwordHash: mikePasswordHash,
            firstName: 'Mike',
            lastName: 'Johnson',
            username: 'mikejohnson',
            company: 'Freelance',
            planType: 'PREMIUM',
            planRenewalDate: new Date('2024-08-30'),
            stripeCustomerId: 'cus_def456',
            stripeSubscriptionId: 'sub_uvw123',
            isActive: true,
            locale: 'en-US',
            role: 'USER',
            status: 'ACTIVE',
            lastLoginAt: new Date('2024-01-25'),
            createdAt: new Date('2024-01-20'),
            updatedAt: new Date('2024-01-25'),
        },
        {
            email: 'sarah.williams@example.com',
            passwordHash: sarahPasswordHash,
            firstName: 'Sarah',
            lastName: 'Williams',
            username: 'sarahwilliams',
            company: 'Design Studio',
            planType: 'STANDARD',
            isActive: true,
            locale: 'fr-FR',
            role: 'USER',
            status: 'ACTIVE',
            lastLoginAt: new Date('2024-01-23'),
            createdAt: new Date('2024-01-22'),
            updatedAt: new Date('2024-01-23'),
        },
        {
            email: 'david.brown@example.com',
            passwordHash: davidPasswordHash,
            firstName: 'David',
            lastName: 'Brown',
            username: 'davidbrown',
            company: 'Consulting Group',
            planType: 'STARTER',
            planRenewalDate: new Date('2024-07-10'),
            stripeCustomerId: 'cus_ghi789',
            stripeSubscriptionId: 'sub_rst456',
            isActive: true,
            locale: 'en-GB',
            role: 'USER',
            status: 'ACTIVE',
            lastLoginAt: new Date('2024-01-24'),
            createdAt: new Date('2024-01-21'),
            updatedAt: new Date('2024-01-24'),
        },
    ];

    await db.insert(users).values(sampleUsers);
    
}

main().catch((error) => {
    console.error('❌ Seeder failed:', error);
});