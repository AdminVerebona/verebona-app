import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";

export async function POST(request: NextRequest) {
  try {
    const { accountId } = await request.json();

    if (!accountId || typeof accountId !== 'number') {
      return NextResponse.json(
        { error: "Valid accountId required" },
        { status: 400 }
      );
    }

    // Reset account + sync subscriptionTier + reset users.planType for all members
    await db.execute(sql`
      UPDATE accounts
      SET
        plan_type = 'STANDARD',
        subscription_tier = 'free',
        stripe_customer_id = NULL,
        stripe_subscription_id = NULL,
        subscription_status = 'NONE',
        premium_until = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${accountId}
    `);

    // Also reset planType on all active members of this account
    await db.execute(sql`
      UPDATE users
      SET plan_type = 'STANDARD', updated_at = CURRENT_TIMESTAMP
      WHERE id IN (
        SELECT user_id FROM account_memberships
        WHERE account_id = ${accountId}
          AND status IN ('active', 'ACTIVE')
          AND user_id IS NOT NULL
      )
    `);

    const result = await db.execute(sql`SELECT * FROM accounts WHERE id = ${accountId}`);

    if (!result || result.length === 0) {
      return NextResponse.json(
        { error: "Account not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Account reset to STANDARD",
      account: result[0]
    });
  } catch (error) {
    console.error("Reset account error:", error);
    return NextResponse.json(
      {
        error: "Failed to reset account",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
