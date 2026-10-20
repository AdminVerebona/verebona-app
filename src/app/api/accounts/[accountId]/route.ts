import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { AccountService } from "@/services/account-service";
import { db } from "@/db";
import { accountMemberships } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
    }

    const resolvedParams = await params;
    const accountId = parseInt(resolvedParams.accountId);
    
    if (isNaN(accountId)) {
      return NextResponse.json({ error: "ID de compte invalide" }, { status: 400 });
    }

    const account = await AccountService.getAccountById(accountId);

    if (!account) {
      return NextResponse.json({ error: "Compte non trouvé" }, { status: 404 });
    }

    const membership = account.memberships.find(m => m.userId === user.id && m.status === 'active');

    if (!membership) {
      return NextResponse.json({ error: "Vous n'avez pas accès à ce compte" }, { status: 403 });
    }

    return NextResponse.json({ account });
  } catch (error) {
    console.error("Error fetching account:", error);
    return NextResponse.json(
      { error: "Erreur lors de la récupération du compte" },
      { status: 500 }
    );
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
    }

    const resolvedParams = await params;
    const accountId = parseInt(resolvedParams.accountId);

    if (isNaN(accountId)) {
      return NextResponse.json({ error: "ID de compte invalide" }, { status: 400 });
    }

    const [membership] = await db
      .select()
      .from(accountMemberships)
      .where(
        and(
          eq(accountMemberships.accountId, accountId),
          eq(accountMemberships.userId, user.id),
          eq(accountMemberships.status, 'active')
        )
      )
      .limit(1);

    if (!membership) {
      return NextResponse.json(
        { error: "Vous n'avez pas accès à ce compte" },
        { status: 403 }
      );
    }

    if (membership.role !== 'owner') {
      return NextResponse.json(
        { error: "Seul le propriétaire peut renommer le compte" },
        { status: 403 }
      );
    }

    // Lot 72D (décision PO Q6) : le nom de l'espace n'est pas modifiable
    // (« Compte de Prénom Nom ») — aucun écran ne l'appelait ; refus explicite.
    return NextResponse.json(
      { error: "Le nom de l'espace n'est pas modifiable.", code: 'ACCOUNT_NAME_NOT_EDITABLE' },
      { status: 403 }
    );
  } catch (error) {
    console.error("Error updating account:", error);
    return NextResponse.json(
      { error: "Erreur lors de la mise à jour du compte" },
      { status: 500 }
    );
  }
}
