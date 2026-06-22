import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get("email");

    if (!email) {
      return NextResponse.json(
        { error: "Email parameter required" },
        { status: 400 }
      );
    }

    const userResult = await db.execute(
      sql`SELECT id, email, first_name, last_name, plan_type, created_at, updated_at FROM users WHERE email = ${email} LIMIT 1`
    );

    if (!userResult || userResult.length === 0) {
      return NextResponse.json(
        { error: "User not found", email },
        { status: 404 }
      );
    }

    const user = userResult[0] as Record<string, unknown>;
    const userId = user.id as number;

    const accountsResult = await db.execute(sql`
      SELECT
        a.id as account_id,
        a.name as account_name,
        a.owner_user_id,
        a.plan_type as account_plan_type,
        a.subscription_tier,
        am.id as membership_id,
        am.role as membership_role,
        am.status as membership_status
      FROM accounts a
      LEFT JOIN account_memberships am ON a.id = am.account_id AND am.user_id = ${userId}
      WHERE a.owner_user_id = ${userId} OR am.user_id = ${userId}
    `);

    const countsResult = await db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM assets WHERE user_id = ${userId}) as total_assets,
        (SELECT COUNT(*) FROM documents WHERE user_id = ${userId}) as total_documents,
        (SELECT COUNT(*) FROM asset_files WHERE user_id = ${userId} AND deleted_at IS NULL) as active_files,
        (SELECT COUNT(*) FROM asset_files WHERE user_id = ${userId} AND deleted_at IS NOT NULL) as deleted_files,
        (SELECT COUNT(*) FROM events WHERE user_id = ${userId}) as total_events
    `);

    const counts = countsResult[0] as Record<string, unknown>;

    const assetsResult = await db.execute(sql`
      SELECT id, name, status, category, created_at, updated_at FROM assets WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 10
    `);

    const documentsResult = await db.execute(sql`
      SELECT id, file_name, document_type, created_at FROM documents WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 10
    `);

    const eventsResult = await db.execute(sql`
      SELECT id, titre, date_evenement, categorie, statut FROM events WHERE user_id = ${userId} ORDER BY date_evenement DESC LIMIT 5
    `);

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        fullName: `${user.first_name} ${user.last_name}`,
        planType: user.plan_type,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
      },
      accounts: Array.from(accountsResult) || [],
      summary: {
        totalAssets: Number(counts.total_assets) || 0,
        totalDocuments: Number(counts.total_documents) || 0,
        activeFiles: Number(counts.active_files) || 0,
        deletedFiles: Number(counts.deleted_files) || 0,
        totalEvents: Number(counts.total_events) || 0,
      },
      recentAssets: Array.from(assetsResult) || [],
      recentDocuments: Array.from(documentsResult) || [],
      recentEvents: Array.from(eventsResult) || [],
    });
  } catch (error) {
    console.error("Investigation error:", error);
    return NextResponse.json(
      {
        error: "Failed to investigate user",
        details: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    );
  }
}
