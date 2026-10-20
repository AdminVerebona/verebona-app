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

    const { email } = await req.json();

    if (!email) {
      return NextResponse.json(
        { error: "Email requis" },
        { status: 400 }
      );
    }

    const { accountId: rawAccountId } = await params;
    const accountId = parseInt(rawAccountId);
    // Lot 72D : l'identifiant de compte de l'URL n'accorde aucun droit —
    // `inviteMember` exige que l'appelant en soit le titulaire actif.
    const result = await AccountService.inviteMember(accountId, email, user.id);

    const status = result.success ? 200 : result.code === 'NOT_ACCOUNT_OWNER' ? 403 : 400;
    return NextResponse.json(result, { status });
  } catch (error) {
    console.error("Error inviting member:", error);
    return NextResponse.json(
      { error: "Erreur lors de l'invitation" },
      { status: 500 }
    );
  }
}
