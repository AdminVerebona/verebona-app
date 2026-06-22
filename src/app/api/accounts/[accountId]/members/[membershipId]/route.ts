import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { AccountService } from "@/services/account-service";

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

    const result = await AccountService.removeMember(
      accountId,
      membershipId,
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
