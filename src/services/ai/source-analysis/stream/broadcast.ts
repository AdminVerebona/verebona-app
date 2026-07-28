/**
 * Diffusion SSE de l'état d'analyse — extrait de l'ancien
 * `unified-analysis-pipeline.ts` pour que le pipeline ne porte que la logique
 * d'orchestration.
 */
export type SSEWriter = (data: Record<string, unknown>) => void;

const streamWriters = new Map<number, Set<SSEWriter>>();

export function registerStreamWriter(assetFileId: number, writer: SSEWriter): () => void {
  if (!streamWriters.has(assetFileId)) streamWriters.set(assetFileId, new Set());
  streamWriters.get(assetFileId)!.add(writer);

  return () => {
    const set = streamWriters.get(assetFileId);
    if (!set) return;
    set.delete(writer);
    if (set.size === 0) streamWriters.delete(assetFileId);
  };
}

export function broadcast(assetFileId: number, data: Record<string, unknown>): void {
  const writers = streamWriters.get(assetFileId);
  if (!writers) return;
  for (const write of writers) {
    try { write(data); } catch { /* connexion fermée */ }
  }
}
