import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { stripeWebhookLogs } from '@/db/schema';
import { desc } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

/**
 * GET /api/admin/stripe-webhooks
 * Récupère la liste des webhooks Stripe pour l'interface admin
 */
export async function GET(request: NextRequest) {
  try {
    // Vérifier que l'utilisateur est admin
    await requireAdmin(request);

    // Récupérer les webhooks (limité aux 200 derniers)
    const webhooks = await db
      .select()
      .from(stripeWebhookLogs)
      .orderBy(desc(stripeWebhookLogs.createdAt))
      .limit(200);

    return NextResponse.json({
      webhooks,
      count: webhooks.length,
    });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }

    console.error('[Admin Stripe Webhooks] Error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch webhooks' },
      { status: 500 }
    );
  }
}
