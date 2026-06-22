/**
 * Migration script to normalize existing data
 * 
 * This script:
 * 1. Converts purchasePrice (text) → purchasePriceCents (integer)
 * 2. Converts cost (text) → costCents (integer)
 * 3. Normalizes all dates to ISO format (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss.sssZ)
 * 
 * Usage: bun run src/db/migrations/normalize-data.ts
 */

import { db } from '@/db';
import { assets, events } from '@/db/schema';
import { sql } from 'drizzle-orm';
import { eurosToCents } from '@/lib/currency-utils';
import { normalizeDate, normalizeDateOnly } from '@/lib/date-utils';

async function migrateAssets() {
  
  try {
    // Get all assets with old purchasePrice field
    const allAssets = await db.execute(sql`
      SELECT id, purchase_price, purchase_date, created_at, updated_at
      FROM assets
    `);
    
    let migrated = 0;
    let skipped = 0;
    
    for (const row of allAssets) {
      const assetId = row.id as number;
      const oldPrice = row.purchase_price as string | null;
      const oldPurchaseDate = row.purchase_date as string | null;
      const oldCreatedAt = row.created_at as string | null;
      const oldUpdatedAt = row.updated_at as string | null;
      
      // Convert price to cents
      const priceCents = oldPrice ? eurosToCents(oldPrice) : null;
      
      // Normalize dates
      const normalizedPurchaseDate = oldPurchaseDate ? normalizeDateOnly(oldPurchaseDate) : null;
      const normalizedCreatedAt = oldCreatedAt ? normalizeDate(oldCreatedAt) : new Date();
      const normalizedUpdatedAt = oldUpdatedAt ? normalizeDate(oldUpdatedAt) : new Date();
      
      // Update the asset
      await db.execute(sql`
        UPDATE assets 
        SET 
          purchase_price_cents = ${priceCents},
          purchase_date = ${normalizedPurchaseDate},
          created_at = ${normalizedCreatedAt},
          updated_at = ${normalizedUpdatedAt}
        WHERE id = ${assetId}
      `);
      
      migrated++;
    }
    
  } catch (error) {
    console.error('❌ Assets migration failed:', error);
    throw error;
  }
}

async function migrateEvents() {
  
  try {
    // Get all events with old cost field
    const allEvents = await db.execute(sql`
      SELECT id, cost, date, created_at
      FROM events
    `);
    
    let migrated = 0;
    
    for (const row of allEvents) {
      const eventId = row.id as number;
      const oldCost = row.cost as string | null;
      const oldDate = row.date as string | null;
      const oldCreatedAt = row.created_at as string | null;
      
      // Convert cost to cents
      const costCents = oldCost ? eurosToCents(oldCost) : null;
      
      // Normalize dates
      const normalizedDate = oldDate ? normalizeDateOnly(oldDate) : null;
      const normalizedCreatedAt = oldCreatedAt ? normalizeDate(oldCreatedAt) : new Date();
      
      // Update the event
      await db.execute(sql`
        UPDATE events 
        SET 
          cost_cents = ${costCents},
          date = ${normalizedDate},
          created_at = ${normalizedCreatedAt}
        WHERE id = ${eventId}
      `);
      
      migrated++;
    }
    
  } catch (error) {
    console.error('❌ Events migration failed:', error);
    throw error;
  }
}

async function migrateDeadlines() {
  
  try {
    const allDeadlines = await db.execute(sql`
      SELECT id, deadline_date, done_date, created_at
      FROM deadlines
    `);
    
    let migrated = 0;
    
    for (const row of allDeadlines) {
      const deadlineId = row.id as number;
      const oldDeadlineDate = row.deadline_date as string | null;
      const oldDoneDate = row.done_date as string | null;
      const oldCreatedAt = row.created_at as string | null;
      
      // Normalize dates
      const normalizedDeadlineDate = oldDeadlineDate ? normalizeDateOnly(oldDeadlineDate) : null;
      const normalizedDoneDate = oldDoneDate ? normalizeDateOnly(oldDoneDate) : null;
      const normalizedCreatedAt = oldCreatedAt ? normalizeDate(oldCreatedAt) : new Date();
      
      await db.execute(sql`
        UPDATE deadlines 
        SET 
          deadline_date = ${normalizedDeadlineDate},
          done_date = ${normalizedDoneDate},
          created_at = ${normalizedCreatedAt}
        WHERE id = ${deadlineId}
      `);
      
      migrated++;
    }
    
  } catch (error) {
    console.error('❌ Deadlines migration failed:', error);
    throw error;
  }
}

async function migrateDocuments() {
  
  try {
    const allDocuments = await db.execute(sql`
      SELECT id, document_date, created_at
      FROM documents
    `);
    
    let migrated = 0;
    
    for (const row of allDocuments) {
      const docId = row.id as number;
      const oldDocumentDate = row.document_date as string | null;
      const oldCreatedAt = row.created_at as string | null;
      
      // Normalize dates
      const normalizedDocumentDate = oldDocumentDate ? normalizeDateOnly(oldDocumentDate) : null;
      const normalizedCreatedAt = oldCreatedAt ? normalizeDate(oldCreatedAt) : new Date();
      
      await db.execute(sql`
        UPDATE documents 
        SET 
          document_date = ${normalizedDocumentDate},
          created_at = ${normalizedCreatedAt}
        WHERE id = ${docId}
      `);
      
      migrated++;
    }
    
  } catch (error) {
    console.error('❌ Documents migration failed:', error);
    throw error;
  }
}

async function migrateUsers() {
  
  try {
    const allUsers = await db.execute(sql`
      SELECT id, plan_renewal_date, last_login_at, created_at, updated_at
      FROM users
    `);
    
    let migrated = 0;
    
    for (const row of allUsers) {
      const userId = row.id as number;
      const oldPlanRenewalDate = row.plan_renewal_date as string | null;
      const oldLastLoginAt = row.last_login_at as string | null;
      const oldCreatedAt = row.created_at as string | null;
      const oldUpdatedAt = row.updated_at as string | null;
      
      // Normalize timestamps
      const normalizedPlanRenewalDate = oldPlanRenewalDate ? normalizeDate(oldPlanRenewalDate) : null;
      const normalizedLastLoginAt = oldLastLoginAt ? normalizeDate(oldLastLoginAt) : null;
      const normalizedCreatedAt = oldCreatedAt ? normalizeDate(oldCreatedAt) : new Date();
      const normalizedUpdatedAt = oldUpdatedAt ? normalizeDate(oldUpdatedAt) : new Date();
      
      await db.execute(sql`
        UPDATE users 
        SET 
          plan_renewal_date = ${normalizedPlanRenewalDate},
          last_login_at = ${normalizedLastLoginAt},
          created_at = ${normalizedCreatedAt},
          updated_at = ${normalizedUpdatedAt}
        WHERE id = ${userId}
      `);
      
      migrated++;
    }
    
  } catch (error) {
    console.error('❌ Users migration failed:', error);
    throw error;
  }
}

async function main() {
  
  try {
    await migrateUsers();
    await migrateAssets();
    await migrateEvents();
    await migrateDeadlines();
    await migrateDocuments();
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  }
}

main();
