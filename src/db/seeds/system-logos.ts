import { db } from '..';
import { systemLogos } from '../schema';
import { eq } from 'drizzle-orm';

/**
 * Seed system logos - Web, Email, and PDF versions of Verebona logo
 */

// Logo Web Animé - 3D cube qui tourne
const LOGO_WEB_HTML = `
<div style="display: flex; align-items: center; gap: 12px; font-family: Inter, sans-serif;">
  <div style="position: relative; width: 40px; height: 40px;">
    <div style="display: flex; flex-direction: column; gap: 2px;">
      <div style="display: flex; gap: 2px;">
        <div style="width: 11px; height: 11px; background: #2F3941; border-radius: 1px;"></div>
        <div style="width: 11px; height: 11px; background: #2F3941; border-radius: 1px;"></div>
        <div style="width: 11px; height: 11px;"></div>
      </div>
      <div style="display: flex; gap: 2px;">
        <div style="width: 11px; height: 11px; background: #2F3941; border-radius: 1px;"></div>
        <div style="width: 11px; height: 11px; background: #2F3941; border-radius: 1px;"></div>
        <div style="width: 11px; height: 11px; background: #2F3941; border-radius: 1px;"></div>
      </div>
      <div style="display: flex; gap: 2px;">
        <div style="width: 11px; height: 11px; background: #2F3941; border-radius: 1px;"></div>
        <div style="width: 11px; height: 11px; background: #2F3941; border-radius: 1px;"></div>
        <div style="width: 11px; height: 11px; background: #2F3941; border-radius: 1px;"></div>
      </div>
    </div>
    <div style="position: absolute; top: -2px; right: -2px; width: 11px; height: 11px; perspective: 1000px; transform-style: preserve-3d;">
      <div style="width: 100%; height: 100%; transform-style: preserve-3d; animation: cube-3d 12s linear infinite;">
        <div style="position: absolute; width: 100%; height: 100%; background: #4A7FE5; border-radius: 1px; transform: translateZ(5.5px); box-shadow: 0 0 10px rgba(74, 127, 229, 0.4);"></div>
        <div style="position: absolute; width: 100%; height: 100%; background: #3563d4; border-radius: 1px; transform: translateZ(-5.5px) rotateY(180deg);"></div>
        <div style="position: absolute; width: 100%; height: 100%; background: #5a8ff0; border-radius: 1px; transform: rotateY(90deg) translateZ(5.5px);"></div>
        <div style="position: absolute; width: 100%; height: 100%; background: #2e5bc0; border-radius: 1px; transform: rotateY(-90deg) translateZ(5.5px);"></div>
        <div style="position: absolute; width: 100%; height: 100%; background: #6ba3ff; border-radius: 1px; transform: rotateX(90deg) translateZ(5.5px);"></div>
        <div style="position: absolute; width: 100%; height: 100%; background: #2447a8; border-radius: 1px; transform: rotateX(-90deg) translateZ(5.5px);"></div>
      </div>
    </div>
  </div>
  <span style="font-size: 36px; font-weight: 700; color: #2F3941; line-height: 1;">Verebona</span>
</div>
<style>
@keyframes cube-3d {
  0% { transform: rotateX(0deg) rotateY(0deg) rotateZ(0deg); }
  33% { transform: rotateX(360deg) rotateY(180deg) rotateZ(0deg); }
  66% { transform: rotateX(360deg) rotateY(360deg) rotateZ(180deg); }
  100% { transform: rotateX(360deg) rotateY(360deg) rotateZ(360deg); }
}
</style>
`;

// Logo Email/PDF Statique - Carré bleu fixe
const LOGO_STATIC_HTML = `
<div style="display: flex; align-items: center; gap: 12px; font-family: Inter, sans-serif;">
  <div style="position: relative; width: 40px; height: 40px;">
    <div style="display: flex; flex-direction: column; gap: 2px;">
      <div style="display: flex; gap: 2px;">
        <div style="width: 11px; height: 11px; background: #2F3941; border-radius: 1px;"></div>
        <div style="width: 11px; height: 11px; background: #2F3941; border-radius: 1px;"></div>
        <div style="width: 11px; height: 11px; background: #4A7FE5; border-radius: 1px;"></div>
      </div>
      <div style="display: flex; gap: 2px;">
        <div style="width: 11px; height: 11px; background: #2F3941; border-radius: 1px;"></div>
        <div style="width: 11px; height: 11px; background: #2F3941; border-radius: 1px;"></div>
        <div style="width: 11px; height: 11px; background: #2F3941; border-radius: 1px;"></div>
      </div>
      <div style="display: flex; gap: 2px;">
        <div style="width: 11px; height: 11px; background: #2F3941; border-radius: 1px;"></div>
        <div style="width: 11px; height: 11px; background: #2F3941; border-radius: 1px;"></div>
        <div style="width: 11px; height: 11px; background: #2F3941; border-radius: 1px;"></div>
      </div>
    </div>
  </div>
  <span style="font-size: 36px; font-weight: 700; color: #2F3941; line-height: 1;">Verebona</span>
</div>
`;

const logos = [
  {
    code: 'VEREBONA_WEB',
    label: 'Logo Verebona Web Animé',
    description: 'Version web avec cube 3D animé - pour les interfaces web uniquement',
    logoType: 'WEB_ANIMATED' as const,
    contentType: 'text/html',
    logoContent: LOGO_WEB_HTML,
    width: 200,
    height: 40,
    isActive: true,
  },
  {
    code: 'VEREBONA_EMAIL',
    label: 'Logo Verebona Email',
    description: 'Version statique pour les templates email - carré bleu fixe',
    logoType: 'EMAIL_STATIC' as const,
    contentType: 'text/html',
    logoContent: LOGO_STATIC_HTML,
    width: 200,
    height: 40,
    isActive: true,
  },
  {
    code: 'VEREBONA_PDF',
    label: 'Logo Verebona PDF',
    description: 'Version statique pour les exports PDF - carré bleu fixe',
    logoType: 'PDF_STATIC' as const,
    contentType: 'text/html',
    logoContent: LOGO_STATIC_HTML,
    width: 200,
    height: 40,
    isActive: true,
  },
];

export async function seedSystemLogos() {

  for (const logo of logos) {
    try {
      // Check if logo already exists
      const existing = await db.select()
        .from(systemLogos)
        .where(eq(systemLogos.code, logo.code))
        .limit(1);

      if (existing.length > 0) {
        continue;
      }

      // Insert new logo
      await db.insert(systemLogos).values({
        ...logo,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    } catch (error) {
      console.error(`  ✗ Error creating logo ${logo.code}:`, error);
    }
  }

}

// Run if called directly
if (require.main === module) {
  seedSystemLogos()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error('Seeding failed:', error);
      process.exit(1);
    });
}
