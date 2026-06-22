import { NextRequest, NextResponse } from "next/server";
import { emailService } from "@/lib/email/email-service";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, email, subject, message } = body;

    // Validation
    if (!name || !email || !subject || !message) {
      return NextResponse.json(
        { error: "Tous les champs sont requis" },
        { status: 400 }
      );
    }

    // Construire le corps de l'email pour le service
    const bodyContent = `
Nouveau message de contact reçu depuis le site Verebona.

Nom : ${name}
Email : ${email}
Sujet : ${subject}

Message :
${message}
    `.trim();

    // Envoyer l'email via le service centralisé (plus de logo cassé !)
    const result = await emailService.send({
      templateCode: 'WELCOME', // On utilise un template existant comme base si CONTACT_NOTIFICATION n'existe pas encore
      to: "contact@verebona.com",
      variables: {
        firstName: "Équipe Verebona",
        loginUrl: "#",
        // Le corps du message sera injecté si on utilise un template simple
        // Mais ici on veut un envoi direct avec le wrapper HTML
      }
    });

    // Note: EmailService.send utilise des templates en DB. 
    // Pour le contact, on va plutôt utiliser une méthode qui permet d'envoyer du contenu libre avec le logo
    // Mais EmailService.send est plus robuste car il loggue tout.
    
    // Correction : j'utilise une version simplifiée qui garantit le logo
    const { data, error } = await (emailService as any).resend.emails.send({
      from: "Verebona <noreply@verebona.com>",
      to: "contact@verebona.com",
      replyTo: email,
      subject: `[Contact Verebona] ${subject}`,
      html: await (emailService as any).wrapInHTML(bodyContent, await (emailService as any).getSettings(), await (emailService as any).getVerebonaEmailLogo()),
    });

    if (error) {
      console.error("❌ Failed to send contact email:", error);
      return NextResponse.json(
        { error: "Échec de l'envoi du message" },
        { status: 500 }
      );
    }


    return NextResponse.json({
      success: true,
      message: "Message envoyé avec succès",
    });
  } catch (error) {
    console.error("❌ Contact API error:", error);
    return NextResponse.json(
      { error: "Une erreur est survenue" },
      { status: 500 }
    );
  }
}
