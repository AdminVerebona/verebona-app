import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { AccountService } from "@/services/account-service";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
    }

    const { newOwnerId } = await req.json();

    if (!newOwnerId) {
      return NextResponse.json(
        { error: "ID du nouveau propriétaire requis" },
        { status: 400 }
      );
    }

    const { accountId: rawAccountId } = await params;
    const accountId = parseInt(rawAccountId);
    const result = await AccountService.transferOwnership(
      accountId,
      newOwnerId,
      user.id
    );

    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (error) {
    console.error("Error transferring ownership:", error);
    return NextResponse.json(
      { error: "Erreur lors du transfert de propriété" },
      { status: 500 }
    );
  }
}
