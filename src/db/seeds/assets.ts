import { db } from '@/db';
import { assets } from '@/db/schema';

async function main() {
    const sampleAssets = [
        {
            userId: 1,
            category: 'IMMOBILIER',
            subtype: 'Appartement',
            name: 'Appartement T3 Lyon 3ème',
            purchaseDate: '2018-05-15',
            purchasePrice: '220000',
            status: 'EN_SERVICE',
            notes: '75m², 2 chambres, balcon',
            createdAt: new Date('2024-12-01'),
            updatedAt: new Date('2024-12-01'),
        },
        {
            userId: 1,
            category: 'VEHICULE',
            subtype: 'Citadine',
            name: 'Peugeot 208',
            purchaseDate: '2020-03-10',
            purchasePrice: '18500',
            status: 'EN_SERVICE',
            notes: '45000 km',
            createdAt: new Date('2024-12-05'),
            updatedAt: new Date('2024-12-05'),
        },
        {
            userId: 3,
            category: 'MATERIEL_PRO',
            subtype: 'Ordinateur portable',
            name: 'MacBook Pro 14"',
            purchaseDate: '2023-01-20',
            purchasePrice: '2499',
            status: 'EN_SERVICE',
            notes: 'Pour devis et facturation',
            createdAt: new Date('2024-12-08'),
            updatedAt: new Date('2024-12-08'),
        },
        {
            userId: 2,
            category: 'IMMOBILIER',
            subtype: 'Maison',
            name: 'Maison individuelle Bordeaux',
            purchaseDate: '2015-09-01',
            purchasePrice: '385000',
            status: 'EN_SERVICE',
            notes: '120m², jardin 300m²',
            createdAt: new Date('2024-12-10'),
            updatedAt: new Date('2024-12-10'),
        },
        {
            userId: 3,
            category: 'VEHICULE',
            subtype: 'Utilitaire',
            name: 'Renault Master',
            purchaseDate: '2021-06-15',
            purchasePrice: '28000',
            status: 'EN_SERVICE',
            notes: 'Aménagé pour plomberie',
            createdAt: new Date('2024-12-12'),
            updatedAt: new Date('2024-12-12'),
        },
        {
            userId: 3,
            category: 'MATERIEL_PRO',
            subtype: 'Outillage',
            name: 'Kit outillage professionnel',
            purchaseDate: '2021-07-01',
            purchasePrice: '5500',
            status: 'EN_SERVICE',
            notes: 'Complet avec poste à souder',
            createdAt: new Date('2024-12-15'),
            updatedAt: new Date('2024-12-15'),
        },
        {
            userId: 5,
            category: 'VEHICULE',
            subtype: 'Berline',
            name: 'Renault Mégane',
            purchaseDate: '2019-11-20',
            purchasePrice: '22000',
            status: 'A_REVENDRE',
            notes: '78000 km, vente prévue',
            createdAt: new Date('2024-12-18'),
            updatedAt: new Date('2024-12-18'),
        },
        {
            userId: 4,
            category: 'IMMOBILIER',
            subtype: 'Studio',
            name: 'Studio Paris 15ème',
            purchaseDate: '2022-03-01',
            purchasePrice: '185000',
            status: 'EN_SERVICE',
            notes: '28m², proche métro',
            createdAt: new Date('2024-12-20'),
            updatedAt: new Date('2024-12-20'),
        },
    ];

    await db.insert(assets).values(sampleAssets);
    
}

main().catch((error) => {
    console.error('❌ Seeder failed:', error);
});