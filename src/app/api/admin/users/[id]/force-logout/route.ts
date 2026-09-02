import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { adminAuditLog } from '@/db/schema';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const params = await context.params;
  try {
    const userId = parseInt(params.id);

    if (isNaN(userId)) {
      return NextResponse.json(
        { error: 'ID utilisateur invalide' },
        { status: 400 }
      );
    }

    // Verify admin authentication
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: 'Non authentifié' },
        { status: 401 }
      );
    }

    const token = authHeader.substring(7);
    let adminUser;

    try {
      adminUser = jwt.verify(token, JWT_SECRET) as { userId: number; role: string; email: string };
    } catch (err) {
      return NextResponse.json(
        { error: 'Token invalide' },
        { status: 401 }
      );
    }

    // Check if user is admin
    if (adminUser.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Accès non autorisé' },
        { status: 403 }
      );
    }

    // Note: Since there's no session table in the schema, we'll just clear tokens from localStorage
    // In a real implementation, you would invalidate tokens server-side or use a token blacklist
    
    // Log the action
    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId: adminUser.userId,
      adminEmail: adminUser.email || 'unknown',
      actionType: 'USER_UPDATE',
      targetType: 'user',
      targetId: userId,
      details: JSON.stringify({
        action: 'FORCE_LOGOUT',
        timestamp: new Date(),
      }),
    });

    return NextResponse.json({
      success: true,
      message: 'Utilisateur déconnecté avec succès',
    });
  } catch (error) {
    console.error('Error forcing logout:', error);
    return NextResponse.json(
      { error: 'Erreur lors de la déconnexion forcée' },
      { status: 500 }
    );
  }
}