/**
 * Consentement aux actualités (CDC §7.8 / §19.5).
 *
 * Jamais activé par défaut, distinct de l'autorisation push et des préférences
 * de catégorie. Le retrait est immédiat ; la preuve (date, source, version) est
 * conservée.
 */

import { db } from '@/db';
import { newsConsents } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const NEWS_CONSENT_VERSION = '2026-07';

export interface NewsConsentState {
  consented: boolean;
  consentedAt: string | null;
  source: string | null;
  version: string | null;
}

export async function getNewsConsent(userId: number): Promise<NewsConsentState> {
  const [row] = await db
    .select({
      consented: newsConsents.consented,
      consentedAt: newsConsents.consentedAt,
      source: newsConsents.source,
      version: newsConsents.version,
    })
    .from(newsConsents)
    .where(eq(newsConsents.userId, userId))
    .limit(1);

  if (!row) return { consented: false, consentedAt: null, source: null, version: null };
  return {
    consented: row.consented,
    consentedAt: row.consentedAt ? new Date(row.consentedAt).toISOString() : null,
    source: row.source,
    version: row.version,
  };
}

/** Vrai si l'utilisateur a un consentement actualités actif (gating d'envoi). */
export async function hasActiveNewsConsent(userId: number): Promise<boolean> {
  const [row] = await db
    .select({ consented: newsConsents.consented })
    .from(newsConsents)
    .where(eq(newsConsents.userId, userId))
    .limit(1);
  return !!row?.consented;
}

export async function setNewsConsent(userId: number, consented: boolean, source: string): Promise<NewsConsentState> {
  const now = new Date();
  await db.insert(newsConsents).values({
    userId,
    consented,
    source: source.slice(0, 60),
    version: NEWS_CONSENT_VERSION,
    consentedAt: consented ? now : null,
    revokedAt: consented ? null : now,
  }).onConflictDoUpdate({
    target: newsConsents.userId,
    set: {
      consented,
      source: source.slice(0, 60),
      version: NEWS_CONSENT_VERSION,
      // Conserver la première date de consentement comme preuve ; ne l'écrase pas
      // lors d'un retrait. Enregistrer le retrait immédiatement.
      ...(consented ? { consentedAt: now, revokedAt: null } : { revokedAt: now }),
      updatedAt: now,
    },
  });
  return getNewsConsent(userId);
}
