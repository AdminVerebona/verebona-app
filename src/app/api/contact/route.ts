import { NextRequest, NextResponse } from "next/server";
import { emailService } from "@/lib/email/email-service";

/** En-tete CORS pour la vitrine, seule origine externe autorisee. */
function corsHeaders(request: Request): Record<string, string> {
  const publicSite = (process.env.NEXT_PUBLIC_PUBLIC_SITE_URL || '').replace(/\/+$/, '');
  const origin = request.headers.get('origin');
  return publicSite && origin === publicSite
    ? { 'Access-Control-Allow-Origin': publicSite, 'Vary': 'Origin' }
    : {};
}

/**
 * POST /api/contact — formulaire de contact du site vitrine (visiteur non
 * connecté, route publique du middleware ; CORS limité à la vitrine).
 *
 * Lot 74A (point 1) : les valeurs saisies (nom, adresse, objet, message) sont
 * neutralisées dans l'e-mail envoyé à l'équipe — HTML, texte et objet
 * (`buildContactEmail`, variable-safety du lot 73A) ; le message garde ses
 * retours à la ligne. « Répondre à » = l'adresse saisie seulement si elle est
 * valide. L'ancien envoi du gabarit WELCOME à contact@ (loginUrl « # »), reste
 * d'un essai de mise en page jamais utilisé (résultat ignoré), est supprimé.
 */
const CONTACT_TO = 'contact@verebona.com';
const CONTACT_FROM = 'Verebona <noreply@verebona.com>';

const filled = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Record<string, unknown> | null;
    const { name, email, subject, message } = body ?? {};

    // Validation (inchangée, plus : des chaînes uniquement)
    if (!filled(name) || !filled(email) || !filled(subject) || !filled(message)) {
      return NextResponse.json(
        { error: "Tous les champs sont requis" },
        { headers: corsHeaders(request), status: 400 }
      );
    }

    const { error } = await emailService.sendContactMessage(
      { name, email, subject, message },
      { to: CONTACT_TO, from: CONTACT_FROM },
    );

    if (error) {
      console.error("❌ Failed to send contact email:", error);
      return NextResponse.json(
        { error: "Échec de l'envoi du message" },
        { headers: corsHeaders(request), status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Message envoyé avec succès",
    }, { headers: corsHeaders(request) });
  } catch (error) {
    console.error("❌ Contact API error:", error);
    return NextResponse.json(
      { error: "Une erreur est survenue" },
      { headers: corsHeaders(request), status: 500 }
    );
  }
}
