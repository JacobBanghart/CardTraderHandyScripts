import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { Blueprint } from './types';
import { buildSetIndex, createScanStream } from 'tcgcard-scanner';
import type { ScannerCard, SetIndex, ScanStream } from 'tcgcard-scanner';

// Offscreen capture canvas, sized to an MTG card's aspect ratio (~63×88mm).
const CAPTURE_W = 600;
const CAPTURE_H = 840;

// How many recent matches to keep in the in-scanner activity log.
const LOG_LIMIT = 20;

interface ScannerProps {
  /** Blueprints of the currently-loaded set — the candidate pool to match against. */
  blueprints: Blueprint[];
  /** Stable cache key for this set's pHash index (so re-opening is instant). */
  setId: string;
  /** Called once per confident, de-duplicated scan. */
  onMatch: (blueprintId: number, info: { isFoil: boolean }) => void;
  /** Reverse a scanned count (undo a stream misread). */
  onUndo: (blueprintId: number, info: { isFoil: boolean }) => void;
  /** Close the scanner panel. */
  onClose: () => void;
}

/** One entry in the activity log — a single counted scan, newest-first. */
interface LogEntry {
  key: number;
  blueprintId: number;
  name: string;
  isFoil: boolean;
  confidence: number;
}

/** Map the consumer's Blueprint onto the engine's minimal card descriptor. */
function toScannerCard(bp: Blueprint): ScannerCard {
  return {
    id: bp.id,
    name: bp.name,
    scryfallId: bp.scryfall_id,
    imageUrl: bp.image_url,
  };
}

export default function Scanner({ blueprints, setId, onMatch, onUndo, onClose }: ScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<ScanStream | null>(null);
  const mediaRef = useRef<MediaStream | null>(null);
  const logKeyRef = useRef(0);

  // Keep the latest callbacks without making them build-effect dependencies (so
  // the expensive index build doesn't re-run when the parent re-renders).
  const onMatchRef = useRef(onMatch);
  const onUndoRef = useRef(onUndo);
  useEffect(() => {
    onMatchRef.current = onMatch;
    onUndoRef.current = onUndo;
  }, [onMatch, onUndo]);

  const [index, setIndex] = useState<SetIndex | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [scanCount, setScanCount] = useState(0);

  // Tunable thresholds (adjustable live — they recreate only the cheap stream).
  const [matchThreshold, setMatchThreshold] = useState(0.7);
  const [cooldownMs, setCooldownMs] = useState(600);

  const ready = index !== null;

  // Build the per-set match index (expensive: fetch + hash every card image).
  // Keyed only on the set, so tweaking thresholds never re-triggers it.
  useEffect(() => {
    let cancelled = false;
    setIndex(null);
    setError(null);
    setProgress({ done: 0, total: blueprints.length });

    buildSetIndex(blueprints.map(toScannerCard), {
      setId,
      onProgress: (done, total) => {
        if (!cancelled) setProgress({ done, total });
      },
    })
      .then((built) => {
        if (!cancelled) setIndex(built);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to build set index');
      });

    return () => {
      cancelled = true;
    };
  }, [blueprints, setId]);

  // Wire the de-duplicating scan stream over the built index. Recreated when a
  // threshold changes — cheap, since it just closes over the existing index.
  useEffect(() => {
    if (!index) return;
    streamRef.current = createScanStream(index, {
      matchThreshold,
      cooldownMs,
      onMatch: (cardId, info) => {
        const name = index.byId.get(cardId)?.card.name ?? String(cardId);
        const blueprintId = Number(cardId);
        setLog((prev) =>
          [
            { key: logKeyRef.current++, blueprintId, name, isFoil: info.isFoil, confidence: info.confidence },
            ...prev,
          ].slice(0, LOG_LIMIT)
        );
        setScanCount((c) => c + 1);
        onMatchRef.current(blueprintId, { isFoil: info.isFoil });
      },
    });
    return () => {
      streamRef.current = null;
    };
  }, [index, matchThreshold, cooldownMs]);

  // Start the webcam once on mount; tear it down on unmount.
  useEffect(() => {
    let cancelled = false;
    async function start() {
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (cancelled) {
          media.getTracks().forEach((t) => t.stop());
          return;
        }
        mediaRef.current = media;
        const video = videoRef.current;
        if (video) {
          video.srcObject = media;
          await video.play();
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Camera unavailable');
      }
    }
    start();
    return () => {
      cancelled = true;
      mediaRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Grab the centered card-shaped region of the current video frame.
  const captureFrame = useCallback((): ImageData | null => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    // Centered crop matching the card aspect and the on-screen guide rectangle.
    const cropH = vh * 0.85;
    const cropW = Math.min(vw, cropH * (CAPTURE_W / CAPTURE_H));
    const sx = (vw - cropW) / 2;
    const sy = (vh - cropH) / 2;
    ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, CAPTURE_W, CAPTURE_H);
    return ctx.getImageData(0, 0, CAPTURE_W, CAPTURE_H);
  }, []);

  // Continuous scan loop: feed frames to the stream, one at a time.
  useEffect(() => {
    if (!ready) return;
    let active = true;
    let busy = false;
    let rafId = 0;
    const tick = async () => {
      if (!active) return;
      const stream = streamRef.current;
      if (stream && !busy) {
        const frame = captureFrame();
        if (frame) {
          busy = true;
          try {
            await stream.pushFrame(frame);
          } catch {
            // A single bad frame shouldn't kill the loop.
          }
          busy = false;
        }
      }
      rafId = requestAnimationFrame(() => {
        void tick();
      });
    };
    rafId = requestAnimationFrame(() => {
      void tick();
    });
    return () => {
      active = false;
      cancelAnimationFrame(rafId);
    };
  }, [ready, captureFrame]);

  // Undo the most recent scan: reverse its count in the working list, drop it
  // from the log, and re-arm the stream so the card can be re-scanned cleanly.
  const handleUndoLast = useCallback(() => {
    setLog((prev) => {
      const [head, ...rest] = prev;
      if (!head) return prev;
      onUndoRef.current(head.blueprintId, { isFoil: head.isFoil });
      setScanCount((c) => Math.max(0, c - 1));
      streamRef.current?.reset();
      return rest;
    });
  }, []);

  // Debug input: run the full pipeline on a static image, no webcam needed.
  const handleFile = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const stream = streamRef.current;
    e.target.value = '';
    if (!file) return;
    if (!stream) {
      setError('Index still building — try again in a moment.');
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas context unavailable');
      ctx.drawImage(bitmap, 0, 0);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      stream.reset(); // a fresh static image should always count once
      await stream.pushFrame(frame);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load image');
    }
  }, []);

  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="fixed top-0 right-0 bottom-0 z-50 w-[380px] bg-[#1a1a2e] text-white shadow-2xl flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <h2 className="text-lg font-bold tracking-wide">Scan</h2>
        <button className="text-white/60 hover:text-white text-2xl leading-none" title="Close" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="relative bg-black aspect-[3/4] m-4 rounded overflow-hidden">
        <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
        {/* Card-alignment guide */}
        <div className="absolute inset-6 border-2 border-yellow-400/80 rounded pointer-events-none" />
      </div>

      {/* Offscreen capture surface. */}
      <canvas ref={canvasRef} width={CAPTURE_W} height={CAPTURE_H} className="hidden" />

      <div className="px-4 space-y-3 flex-1 overflow-y-auto">
        {!ready && !error && (
          <div>
            <div className="text-sm text-white/70 mb-1">
              Building set index… {progress.done}/{progress.total}
            </div>
            <div className="h-2 bg-white/10 rounded overflow-hidden">
              <div className="h-full bg-green-500 transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-500/20 border border-red-400/40 text-red-200 px-3 py-2 rounded text-sm">
            {error}
          </div>
        )}

        {ready && (
          <div className="text-sm text-green-300">Ready — hold a card to the camera.</div>
        )}

        {/* Tunable thresholds */}
        <div className="space-y-2 bg-white/5 rounded px-3 py-2">
          <div>
            <label className="flex items-center justify-between text-xs text-white/60">
              <span>Match confidence</span>
              <span className="tabular-nums">{Math.round(matchThreshold * 100)}%</span>
            </label>
            <input
              type="range"
              min={0.5}
              max={0.95}
              step={0.05}
              value={matchThreshold}
              onChange={(e) => setMatchThreshold(Number(e.target.value))}
              className="w-full accent-green-500"
            />
          </div>
          <div>
            <label className="flex items-center justify-between text-xs text-white/60">
              <span>Re-count cooldown</span>
              <span className="tabular-nums">{cooldownMs} ms</span>
            </label>
            <input
              type="range"
              min={0}
              max={2000}
              step={100}
              value={cooldownMs}
              onChange={(e) => setCooldownMs(Number(e.target.value))}
              className="w-full accent-green-500"
            />
          </div>
        </div>

        <div className="flex items-center justify-between text-sm">
          <span>
            <span className="font-medium">{scanCount}</span> scanned this session
          </span>
          <button
            onClick={handleUndoLast}
            disabled={log.length === 0}
            className="px-2 py-1 rounded text-xs bg-white/10 hover:bg-white/20 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Reverse the most recent scan"
          >
            ↩ Undo last
          </button>
        </div>

        {/* Activity log — most recent matches, newest first. */}
        {log.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs uppercase tracking-wide text-white/40">Recent</div>
            {log.map((entry, i) => (
              <div
                key={entry.key}
                className={`flex items-center justify-between rounded px-3 py-1.5 text-sm ${
                  i === 0 ? 'bg-white/10' : 'bg-white/5'
                }`}
              >
                <span className="truncate mr-2">{entry.name}</span>
                <span className="text-white/50 whitespace-nowrap text-xs">
                  {entry.isFoil ? 'foil · ' : ''}
                  {Math.round(entry.confidence * 100)}%
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="px-4 py-3 border-t border-white/10">
        <label className="block text-xs text-white/50 mb-1">Debug: scan an image file</label>
        <input
          type="file"
          accept="image/*"
          onChange={handleFile}
          className="block w-full text-sm text-white/80 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-green-600 file:text-white hover:file:bg-green-500"
        />
      </div>
    </div>
  );
}
