import { NextResponse } from 'next/server';
import { db } from '@/db';
import { systemLogos } from '@/db/schema';
import { eq } from 'drizzle-orm';

const VEREBONA_EMAIL_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="180" viewBox="0 0 720 180">

  <!-- ===== Symbole ===== -->
  <!-- Symbole entre Y ≈ 20 et Y ≈ 104 -->
  <g transform="translate(0,20)">
    <g fill="#2F3941">
      <!-- Rangée 1 -->
      <rect x="0"  y="0"  width="24" height="24" rx="4"/>
      <rect x="30" y="0"  width="24" height="24" rx="4"/>

      <!-- Rangée 2 -->
      <rect x="0"  y="30" width="24" height="24" rx="4"/>
      <rect x="30" y="30" width="24" height="24" rx="4"/>
      <rect x="60" y="30" width="24" height="24" rx="4"/>

      <!-- Rangée 3 -->
      <rect x="0"  y="60" width="24" height="24" rx="4"/>
      <rect x="30" y="60" width="24" height="24" rx="4"/>
      <rect x="60" y="60" width="24" height="24" rx="4"/>
    </g>

    <!-- Carré bleu (case manquante, légèrement relevé, rotation +18°) -->
    <rect x="60" y="-4" width="24" height="24" rx="4"
          fill="#3B82F6" transform="rotate(18 72 8)" />
  </g>

  <!-- ===== Texte ===== -->
  <!-- Haut symbole ≈ 20 ; bas symbole ≈ 104 -->

  <!-- "Verebona" placé au-dessus de la baseline -->
  <!-- baseline à 60 → cap height ≈ 20–22 → haut ≈ haut du symbole -->
  <text x="95" y="60"
        font-family="Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        font-size="54"
        font-weight="700"
        fill="#2F3941">
    Verebona
  </text>

  <!-- Baseline à 96 → descente ≈ 8 → bas ≈ 104 → aligné avec bas du symbole -->
  <text x="98" y="96"
        font-family="Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        font-size="24"
        fill="#2F3941"
        opacity="0.9">
    One place. More value.
  </text>

</svg>`;

/**
 * POST /api/admin/system-logos/insert-verebona-email-logo
 * Insert or update the Verebona email logo in system_logos table
 */
export async function POST() {
  try {
    // Check if logo already exists
    const existing = await db
      .select()
      .from(systemLogos)
      .where(eq(systemLogos.code, 'EMAIL_HEADER_LOGO'))
      .limit(1);

    if (existing.length > 0) {
      // Update existing
      await db
        .update(systemLogos)
        .set({
          label: 'Logo Verebona pour en-têtes emails',
          description: 'Logo statique Verebona utilisé dans tous les emails HTML transactionnels',
          logoType: 'EMAIL_STATIC',
          contentType: 'image/svg+xml',
          logoContent: VEREBONA_EMAIL_LOGO_SVG,
          width: 720,
          height: 180,
          isActive: true,
          version: existing[0].version + 1,
          updatedAt: new Date(),
        })
        .where(eq(systemLogos.code, 'EMAIL_HEADER_LOGO'));

      return NextResponse.json({
        success: true,
        message: 'Logo Verebona email mis à jour avec succès',
        action: 'updated',
        version: existing[0].version + 1,
      });
    } else {
      // Insert new
      await db.insert(systemLogos).values({
        code: 'EMAIL_HEADER_LOGO',
        label: 'Logo Verebona pour en-têtes emails',
        description: 'Logo statique Verebona utilisé dans tous les emails HTML transactionnels',
        logoType: 'EMAIL_STATIC',
        contentType: 'image/svg+xml',
        logoContent: VEREBONA_EMAIL_LOGO_SVG,
        width: 720,
        height: 180,
        isActive: true,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      return NextResponse.json({
        success: true,
        message: 'Logo Verebona email inséré avec succès',
        action: 'inserted',
        version: 1,
      });
    }
  } catch (error) {
    console.error('Error inserting Verebona email logo:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to insert Verebona email logo',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
