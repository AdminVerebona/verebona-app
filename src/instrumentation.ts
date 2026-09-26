/**
 * Amorçage applicatif — convention Next.js 15.
 *
 * Tout le travail est dans `instrumentation-node.ts`. La condition doit rester
 * écrite EN LIGNE autour de l'import : c'est ce que Next.js élimine du bundle
 * Edge. Un `return` anticipé laissait les imports dynamiques dans ce bundle, et
 * la chaîne planificateur → notifications → web-push cassait le build
 * (`Can't resolve 'http'`).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNode } = await import('./instrumentation-node');
    await registerNode();
  }
}
