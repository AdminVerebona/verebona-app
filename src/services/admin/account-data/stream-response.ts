/**
 * Lot 81C — flux de réponse HTTP alimenté par un producteur asynchrone, AVEC
 * contre-pression (le producteur attend que le client lise) et détection du
 * départ du client (écriture refusée → `SinkError`, la génération s'arrête
 * et est journalisée FAILED). Serveur uniquement.
 */
import { PassThrough, Readable } from 'node:stream';
import { SinkError, type TextSink } from './export';

interface ResponseStream {
  /** Corps de réponse (web). */
  body: ReadableStream<Uint8Array>;
  /** Flux Node (archive, tests). */
  node: PassThrough;
  sink: TextSink & { bytes(): number };
  /** Fin normale du flux. */
  end(): void;
  /** Interruption : le client reçoit une réponse tronquée signalée comme erreur réseau (jamais un fichier « complet »). */
  abort(e: unknown): void;
}

/** Attente de la vidange, ou refus si le flux est fermé. */
export async function writeWithBackpressure(pt: PassThrough, chunk: string | Uint8Array): Promise<void> {
  if (pt.destroyed || pt.writableEnded) throw new SinkError(new Error('flux fermé (client parti ?)'));
  if (pt.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { pt.off('drain', onDrain); pt.off('close', onClose); pt.off('error', onClose); };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new SinkError(new Error('flux fermé (client parti ?)'))); };
    pt.once('drain', onDrain);
    pt.once('close', onClose);
    pt.once('error', onClose);
  });
}

export function responseStream(highWaterMark = 256 * 1024): ResponseStream {
  const node = new PassThrough({ highWaterMark });
  // Une erreur (abandon) sans écouteur ferait tomber le processus.
  node.on('error', () => undefined);
  let bytes = 0;
  return {
    body: Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>,
    node,
    sink: {
      async write(c: string) {
        const b = Buffer.from(c, 'utf8');
        bytes += b.length;
        await writeWithBackpressure(node, b);
      },
      bytes: () => bytes,
    },
    end: () => { if (!node.destroyed) node.end(); },
    abort: (e: unknown) => { if (!node.destroyed) node.destroy(e instanceof Error ? e : new Error(String(e))); },
  };
}
