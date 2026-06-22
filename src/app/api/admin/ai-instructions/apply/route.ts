/**
 * POST /api/admin/ai-instructions/apply
 * Sends an admin instruction to Gemini which interprets it and returns
 * precise patches for the AI prompts. The patches are applied to the .txt files.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { aiInstructions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getSession } from '@/lib/auth-guards';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const PROMPTS_DIR = join(process.cwd(), 'src', 'services', 'document-ai', 'prompts');

const PROMPT_FILES = [
  'extract_v1.txt',
  'extract_meta_v1.txt',
  'extract_detail_v1.txt',
  'extract_agenda_v1.txt',
  'agenda_detect_v1.txt',
  'asset_suggest_v1.txt',
  'search_v1.txt',
];

function loadPrompt(name: string): string {
  try { return readFileSync(join(PROMPTS_DIR, name), 'utf8'); } catch { return ''; }
}

const META_PROMPT = `Tu es un expert en prompt engineering pour Gemini, spécialisé dans l'analyse documentaire et la recherche plein texte.

L'administrateur d'une application de gestion de patrimoine (Verebona) t'a laissé une instruction décrivant un comportement attendu ou un problème observé.

Ton rôle : analyser l'instruction et proposer des modifications précises aux prompts d'analyse IA pour que le comportement demandé soit respecté.

## Contexte technique

- Les documents sont analysés par Gemini via des prompts texte
- Le champ \`rawPageText\` contient la transcription intégrale du document (texte + description visuelle pour les images)
- Ce champ est indexé et utilisé pour la recherche plein texte : si un mot est présent dans rawPageText, la recherche le trouvera
- Pour les PHOTOS, le champ rawPageText doit contenir une description visuelle EXHAUSTIVE de tout ce qui est visible
- Les prompts à modifier sont listés ci-dessous avec leur contenu actuel

## Instruction de l'administrateur

{{ADMIN_INSTRUCTION}}

## Prompts actuels

{{CURRENT_PROMPTS}}

## Format de réponse JSON attendu

{
  "analysis": "string — explication en français de ce que tu as compris de l'instruction et des changements à apporter",
  "patches": [
    {
      "promptFile": "nom_du_fichier.txt",
      "oldText": "texte exact à remplacer (doit être présent dans le prompt)",
      "newText": "nouveau texte de remplacement",
      "reason": "raison courte du changement"
    }
  ]
}

## Règles importantes

1. Ne modifier que ce qui est strictement nécessaire pour satisfaire l'instruction
2. Les oldText doivent être des extraits EXACTS du prompt (copié-collé), pas une paraphrase
3. Si l'instruction concerne la visibilité dans la recherche (champ recherche, résultats de recherche, requêtes qui ne trouvent pas un document) → modifier search_v1.txt pour affiner les règles de correspondance sémantique, et/ou extract_v1.txt/extract_meta_v1.txt pour améliorer l'extraction du texte brut des documents
4. Si l'instruction concerne la classification de type de document → modifier la taxonomie dans extract_v1.txt ou extract_meta_v1.txt
5. Le fichier search_v1.txt contrôle le moteur de recherche IA : il contient les règles que Gemini applique pour trouver des documents, biens et événements agenda à partir d'une requête utilisateur. Les données sont injectées via {{QUERY}} et {{CONTEXT}} — ne pas supprimer ces placeholders.
5. Si aucun changement de prompt n'est nécessaire (l'instruction est déjà satisfaite), retourner patches: []
6. Ne pas inventer de oldText inexistant — vérifier que le texte est présent dans le prompt avant de le proposer
`;

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (session.role !== 'ADMIN' && session.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
    }

    const { instructionId } = await request.json();
    if (!instructionId) {
      return NextResponse.json({ error: 'MISSING_INSTRUCTION_ID' }, { status: 400 });
    }

    const [instructionRow] = await db
      .select()
      .from(aiInstructions)
      .where(eq(aiInstructions.id, instructionId))
      .limit(1);

    if (!instructionRow) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }

    // Build prompts context
    const promptsContext = PROMPT_FILES
      .map(f => `### ${f}\n\`\`\`\n${loadPrompt(f)}\n\`\`\``)
      .join('\n\n');

    const metaPrompt = META_PROMPT
      .replace('{{ADMIN_INSTRUCTION}}', instructionRow.instruction)
      .replace('{{CURRENT_PROMPTS}}', promptsContext);

    // Call Gemini
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: 'GEMINI_NOT_CONFIGURED' }, { status: 500 });

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent([{ text: metaPrompt }]);
    const rawText = result.response.text();

    // Parse JSON response
    let parsed: { analysis: string; patches: Array<{ promptFile: string; oldText: string; newText: string; reason: string }> };
    try {
      const match = rawText.match(/```(?:json)?\s*([\s\S]+?)```/) ?? [null, rawText];
      parsed = JSON.parse(match[1].trim());
    } catch {
      return NextResponse.json({ error: 'GEMINI_PARSE_ERROR', raw: rawText }, { status: 500 });
    }

    // Apply patches
    const patchedFiles: string[] = [];
    const patchResults: Array<{ file: string; applied: boolean; reason: string; error?: string }> = [];

    for (const patch of parsed.patches ?? []) {
      const { promptFile, oldText, newText, reason } = patch;
      if (!PROMPT_FILES.includes(promptFile)) {
        patchResults.push({ file: promptFile, applied: false, reason, error: 'File not in allowed list' });
        continue;
      }
      const current = loadPrompt(promptFile);
      if (!current.includes(oldText)) {
        patchResults.push({ file: promptFile, applied: false, reason, error: `oldText not found in ${promptFile}` });
        continue;
      }
      const updated = current.replace(oldText, newText);
      writeFileSync(join(PROMPTS_DIR, promptFile), updated, 'utf8');
      patchedFiles.push(promptFile);
      patchResults.push({ file: promptFile, applied: true, reason });
    }

    // Save analysis and status to DB
    await db
      .update(aiInstructions)
      .set({
        status: patchedFiles.length > 0 ? 'applied' : 'dismissed',
        geminiAnalysis: parsed.analysis,
        promptsPatched: JSON.stringify(patchedFiles),
        appliedAt: new Date(),
      })
      .where(eq(aiInstructions.id, instructionId));

    return NextResponse.json({
      analysis: parsed.analysis,
      patchResults,
      patchedFiles,
    });
  } catch (e) {
    console.error('[ai-instructions/apply]', e);
    return NextResponse.json({ error: 'INTERNAL_ERROR', message: (e as Error).message }, { status: 500 });
  }
}
