import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { AccountService } from "@/services/account-service";
import { db } from "@/db";
import { accountMemberships } from "@/db/schema";
import { and, eq } from "drizzle-orm";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ accountId: string; membershipId: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
    }

    const { accountId: rawAccountId, membershipId: rawMembershipId } = await params;
    const accountId = parseInt(rawAccountId);
    const membershipId = parseInt(rawMembershipId);

    if (isNaN(accountId) || isNaN(membershipId)) {
      return NextResponse.json({ success: false, error: "Paramètres invalides" }, { status: 400 });
    }

    // Le segment d'URL est l'identifiant du MEMBERSHIP ; le service attend
    // l'utilisateur membre. Il était transmis tel quel, ce qui visait un
    // autre utilisateur.
    const [membership] = await db
      .select({ userId: accountMemberships.userId })
      .from(accountMemberships)
      .where(and(eq(accountMemberships.id, membershipId), eq(accountMemberships.accountId, accountId)))
      .limit(1);
    if (!membership?.userId) {
      return NextResponse.json({ success: false, error: "Membre introuvable" }, { status: 404 });
    }

    const result = await AccountService.removeMember(
      accountId,
      membership.userId,
      user.id
    );

    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (error) {
    console.error("Error removing member:", error);
    return NextResponse.json(
      { error: "Erreur lors de la suppression du membre" },
      { status: 500 }
    );
  }
}
