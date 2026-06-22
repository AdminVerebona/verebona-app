/**
 * AgendaClassificationService — classifie un item agenda en 'action' ou 'information'
 * via Gemini Flash pour alimenter la home page.
 *
 * 'action'      → affiché dans "Prochaines dates" (peut être en retard)
 *                 ex : contrôle technique, réparation, renouvellement, rendez-vous
 * 'information' → affiché dans "À savoir" (fait passif, jamais en retard)
 *                 ex : fin de garantie, date d'achat, date de fabrication, échéance DPE
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || '';
const MODEL = 'gemini-2.0-flash';

export type HomeCategory = 'action' | 'information';

/**
 * Règles déterministes appliquées AVANT l'appel IA.
 * Retourne null si on ne peut pas décider de façon certaine.
 */
function classifyByRules(
  title: string,
  originType: string,
  originFieldKey?: string | null,
): HomeCategory | null {
  // Tout item créé automatiquement depuis un champ de bien est informatif
  if (originType === 'asset_field') return 'information';

  const t = title.toLowerCase();

  // Mots-clés actions prioritaires (vérifiés AVANT les patterns informatifs)
  const actionPatterns = [
    /contrôle technique/i, /revision/i, /révision/i,
    /réparation/i, /reparation/i,
    /renouvellement/i,
    /rendez-vous/i, /rdv/i,
    /entretien/i,
    /intervention/i,
    /installation/i,
    /inspection/i,
    /visite/i,
    /nettoyage/i,
    /remplacement/i,
    /paiement/i, /facture/i,
    // Stockage / gardiennage / dépôt → reprise physique requise
    /reprise/i, /restitution/i, /récupération/i, /recuperation/i,
    /gardiennage/i, /stockage/i, /dépôt.*pneu/i, /pneu.*dépôt/i,
    /pneu.*hiver/i, /pneu.*été/i, /pneu.*saison/i,
    // Fin d'un contrat de gardiennage/stockage = il faut aller récupérer l'objet
    /fin.*contrat.*(gardiennage|stockage|dépôt|depot|pneu)/i,
    /(gardiennage|stockage|dépôt|depot|pneu).*fin.*contrat/i,
  ];
  for (const p of actionPatterns) {
    if (p.test(t)) return 'action';
  }

  // Mots-clés informatifs (faits passifs, échéances automatiques)
  const infoPatterns = [
    /fin de garantie/i, /garantie.*expir/i, /expir.*garantie/i,
    /fin.*(p[eé]riode|contrat).*assurance/i,
    /assurance.*fin/i, /assurance.*expir/i, /expiration.*assurance/i,
    /reconduction/i, /renouvellement.*auto/i,
    /date d['']achat/i, /^achat\b/i,   // "Achat — Vélo" mais PAS "Achat Pneus Discount → Reprise"
    /fabrication/i,
    /dpe/i, /diagnostic/i,
    /décennale/i,
    /échéance.*contrat/i, /fin.*contrat/i,
  ];
  for (const p of infoPatterns) {
    if (p.test(t)) return 'information';
  }

  return null; // indécis → appel IA
}

/**
 * Classifie un item agenda via Gemini Flash.
 * Retourne 'action' en cas d'erreur (fallback sûr : mieux vaut afficher
 * une date d'information dans "Prochaines dates" que la masquer).
 */
export async function classifyAgendaItem(
  title: string,
  description: string | null | undefined,
  originType: string,
  originFieldKey?: string | null,
): Promise<HomeCategory> {
  // 1. Règles déterministes d'abord
  const ruleResult = classifyByRules(title, originType, originFieldKey);
  if (ruleResult !== null) return ruleResult;

  // 2. Appel IA si pas de clé configurée → fallback 'action'
  if (!GEMINI_API_KEY) return 'action';

  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: MODEL });

    const prompt = `Tu es un assistant qui classe des événements agenda en deux catégories :
- "action" : une tâche qui nécessite une intervention physique ou une décision de l'utilisateur (contrôle technique, réparation, rendez-vous, entretien, récupération d'un objet stocké, reprise de pneus, restitution d'un dépôt, etc.)
- "information" : un fait passif qui ne nécessite aucune action de la part de l'utilisateur (fin de garantie, date d'achat, fin de période d'assurance avec reconduction automatique, date d'expiration d'un diagnostic, etc.)

Important :
- Une fin de contrat ou période d'assurance avec reconduction tacite est une "information" — l'assurance se renouvelle automatiquement.
- Une reprise de pneus, récupération d'un véhicule en dépôt, ou tout événement où l'utilisateur doit se déplacer physiquement est une "action".
- En cas de doute sur un contrat de stockage ou gardiennage, préférer "action".

Événement à classer :
Titre : ${title}${description ? `\nDescription : ${description}` : ''}

Réponds UNIQUEMENT avec le mot "action" ou "information", sans ponctuation ni explication.`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim().toLowerCase();

    if (text === 'information') return 'information';
    return 'action'; // par défaut
  } catch {
    // En cas d'erreur IA, fallback 'action' (safe default)
    return 'action';
  }
}
