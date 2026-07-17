import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { events, assets } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth-guards";

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request);

    // Étape 1 : Trouver tous les événements avec assetId
    const allEvents = await db
      .select({
        eventId: events.id,
        eventUserId: events.userId,
        assetId: events.assetId,
      })
      .from(events)
      .where(sql`${events.assetId} IS NOT NULL`);

    let corrected = 0;
    let orphaned = 0;
    let alreadyCorrect = 0;
    const details: any[] = [];

    // Étape 2 : Pour chaque événement, vérifier le userId
    for (const event of allEvents) {
      // Récupérer le bien associé
      const [asset] = await db
        .select({ userId: assets.userId })
        .from(assets)
        .where(eq(assets.id, event.assetId!))
        .limit(1);

      if (!asset) {
        // Le bien n'existe pas - événement orphelin
        orphaned++;
        details.push({
          eventId: event.eventId,
          assetId: event.assetId,
          status: "orphaned",
          message: "Le bien associé n'existe pas"
        });
        continue;
      }

      // Vérifier si le userId de l'événement correspond au propriétaire du bien
      if (event.eventUserId === asset.userId) {
        alreadyCorrect++;
        continue;
      }

      // Corriger le userId
      await db
        .update(events)
        .set({ userId: asset.userId })
        .where(eq(events.id, event.eventId));

      corrected++;
      details.push({
        eventId: event.eventId,
        assetId: event.assetId,
        status: "corrected",
        oldUserId: event.eventUserId,
        newUserId: asset.userId
      });
    }

    return NextResponse.json({
      success: true,
      summary: {
        total: allEvents.length,
        corrected,
        alreadyCorrect,
        orphaned
      },
      details
    });

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    
    console.error("Erreur lors de la correction des userId:", error);
    return NextResponse.json(
      { 
        error: "Erreur lors de la correction des userId",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}