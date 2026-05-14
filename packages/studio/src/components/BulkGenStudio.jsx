"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  submitGptImage2Batch,
  pollBatch,
  cancelBatch,
  downloadBatchResults,
  hasOpenAIKey,
} from "../providers/openai.js";

const STORAGE_KEY = "openai_batches";

function loadBatches() {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveBatches(rows) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
}

function isTerminal(status) {
  return ["completed", "failed", "cancelled", "expired"].includes(status);
}

function fmtAge(ts) {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

export default function BulkGenStudio() {
  const [prompts, setPrompts] = useState("");
  const [quality, setQuality] = useState("standard");
  const [size, setSize] = useState("1024x1024");
  const [batches, setBatches] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [results, setResults] = useState({}); // batchId → [{ b64_png, custom_id }]
  const pollTimerRef = useRef(null);

  // Hydrate from localStorage on mount.
  useEffect(() => {
    setBatches(loadBatches());
  }, []);

  // Auto-poll non-terminal batches every 2 min — only if a key is set.
  useEffect(() => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    if (!hasOpenAIKey()) return;
    const anyActive = batches.some((b) => !isTerminal(b.status));
    if (!anyActive) return;
    pollTimerRef.current = setInterval(() => {
      refreshAll();
    }, 120000);
    return () => clearInterval(pollTimerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batches.length]);

  const refreshBatch = useCallback(async (batchId) => {
    if (!hasOpenAIKey()) return; // silent no-op; UI surfaces the missing-key banner.
    try {
      const fresh = await pollBatch(batchId);
      setBatches((prev) => {
        const next = prev.map((b) =>
          b.id === batchId
            ? {
                ...b,
                status: fresh.status,
                output_file_id: fresh.output_file_id || b.output_file_id,
                request_counts: fresh.request_counts || b.request_counts,
              }
            : b
        );
        saveBatches(next);
        return next;
      });
      if (fresh.status === "completed" && fresh.output_file_id) {
        try {
          const rows = await downloadBatchResults(fresh.output_file_id);
          setResults((prev) => ({ ...prev, [batchId]: rows }));
        } catch (e) {
          console.error("Download results failed:", e);
        }
      }
    } catch (e) {
      console.error("Poll failed:", e);
    }
  }, []);

  const refreshAll = useCallback(() => {
    batches.forEach((b) => {
      if (!isTerminal(b.status)) refreshBatch(b.id);
    });
  }, [batches, refreshBatch]);

  const handleSubmit = async () => {
    setError(null);
    const list = prompts
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length === 0) {
      setError("Add at least one prompt (one per line).");
      return;
    }
    if (list.length > 500) {
      setError("Max 500 prompts per batch.");
      return;
    }
    setSubmitting(true);
    try {
      const resp = await submitGptImage2Batch(list, { quality, size });
      const row = {
        id: resp.id,
        created_at: Date.now(),
        status: resp.status || "validating",
        prompt_count: list.length,
        size,
        quality,
        input_file_id: resp.input_file_id,
        output_file_id: resp.output_file_id || null,
      };
      setBatches((prev) => {
        const next = [row, ...prev];
        saveBatches(next);
        return next;
      });
      setPrompts("");
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (batchId) => {
    try {
      const fresh = await cancelBatch(batchId);
      setBatches((prev) => {
        const next = prev.map((b) =>
          b.id === batchId ? { ...b, status: fresh.status || "cancelled" } : b
        );
        saveBatches(next);
        return next;
      });
    } catch (e) {
      setError(e.message || String(e));
    }
  };

  const handleClear = (batchId) => {
    setBatches((prev) => {
      const next = prev.filter((b) => b.id !== batchId);
      saveBatches(next);
      return next;
    });
    setResults((prev) => {
      const next = { ...prev };
      delete next[batchId];
      return next;
    });
  };

  return (
    <div className="h-full overflow-y-auto p-6 text-white" data-testid="bulk-gen-studio">
      <div className="max-w-3xl mx-auto flex flex-col gap-6">
        <header>
          <h1 className="text-xl font-bold tracking-tight">Bulk Gen — OpenAI Batch</h1>
          <p className="text-white/40 text-sm mt-1">
            Submit asynchronous batch jobs to OpenAI's <code className="text-[#d9ff00]">gpt-image-2</code> endpoint
            (50% cheaper than synchronous calls; SLA 24h, usually 1–6h).
          </p>
        </header>

        {!hasOpenAIKey() && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-md p-3 text-yellow-200 text-sm" data-testid="no-key-banner">
            No OpenAI key set. Open Settings → OpenAI API Key to enable submission and polling.
          </div>
        )}

        <section className="bg-white/[0.03] border border-white/5 rounded-lg p-5 flex flex-col gap-4">
          <div>
            <label className="text-xs font-bold text-white/50 uppercase tracking-wide">
              Prompts <span className="text-white/30 normal-case">(one per line, max 500)</span>
            </label>
            <textarea
              value={prompts}
              onChange={(e) => setPrompts(e.target.value)}
              rows={8}
              data-testid="bulk-prompts"
              placeholder={"A cyberpunk cat in neon Tokyo\nA snow leopard astronaut on Mars"}
              className="mt-2 w-full bg-black/40 border border-white/10 rounded-md p-3 text-sm font-mono text-white placeholder:text-white/20 focus:outline-none focus:ring-1 focus:ring-[#d9ff00]/30 resize-y"
            />
            <div className="text-[11px] text-white/40 mt-1">
              {prompts.split("\n").filter((s) => s.trim()).length} prompt(s)
            </div>
          </div>

          <div className="flex gap-4 flex-wrap">
            <label className="flex flex-col text-xs gap-1">
              <span className="font-bold text-white/50 uppercase tracking-wide">Quality</span>
              <select
                value={quality}
                onChange={(e) => setQuality(e.target.value)}
                data-testid="bulk-quality"
                className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-white"
              >
                <option value="standard">standard</option>
                <option value="hd">hd</option>
              </select>
            </label>
            <label className="flex flex-col text-xs gap-1">
              <span className="font-bold text-white/50 uppercase tracking-wide">Size</span>
              <select
                value={size}
                onChange={(e) => setSize(e.target.value)}
                data-testid="bulk-size"
                className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-white"
              >
                <option value="1024x1024">1024×1024</option>
                <option value="1792x1024">1792×1024</option>
                <option value="2048x2048">2048×2048</option>
              </select>
            </label>
          </div>

          <div>
            <button
              onClick={handleSubmit}
              disabled={submitting}
              data-testid="bulk-submit"
              className="px-5 py-2.5 rounded-md bg-[#d9ff00] text-black font-bold text-sm hover:bg-[#e5ff33] disabled:opacity-40 transition-all"
            >
              {submitting ? "Submitting…" : "Submit Batch"}
            </button>
          </div>

          {error && (
            <div className="text-red-300 text-sm bg-red-500/10 border border-red-500/20 rounded-md p-3" data-testid="bulk-error">
              {error}
            </div>
          )}
        </section>

        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold uppercase tracking-wide text-white/60">
              Active Batches
            </h2>
            <button
              onClick={refreshAll}
              className="text-xs text-white/50 hover:text-white px-2 py-1 rounded border border-white/10"
            >
              Refresh all
            </button>
          </div>

          {batches.length === 0 && (
            <div className="text-white/30 text-sm border border-dashed border-white/10 rounded-md p-6 text-center">
              No batches yet. Submit one above.
            </div>
          )}

          <div className="flex flex-col gap-2">
            {batches.map((b) => (
              <div
                key={b.id}
                data-testid={`batch-row-${b.id}`}
                className="bg-white/[0.03] border border-white/5 rounded-md p-4 flex items-center gap-4 flex-wrap"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-[11px] text-white/40 truncate" title={b.id}>
                    {b.id}
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    <span
                      className={`text-xs font-bold px-2 py-0.5 rounded uppercase tracking-wide ${
                        b.status === "completed"
                          ? "bg-emerald-500/15 text-emerald-300"
                          : b.status === "failed" || b.status === "cancelled" || b.status === "expired"
                          ? "bg-red-500/15 text-red-300"
                          : "bg-yellow-500/15 text-yellow-300"
                      }`}
                      data-testid={`batch-status-${b.id}`}
                    >
                      {b.status}
                    </span>
                    <span className="text-[11px] text-white/40">
                      {b.prompt_count} prompts · {b.size} · {b.quality} · age {fmtAge(b.created_at)}
                    </span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => refreshBatch(b.id)}
                    className="text-xs px-3 py-1.5 rounded bg-white/5 hover:bg-white/10 text-white/80"
                  >
                    Refresh
                  </button>
                  {!isTerminal(b.status) && (
                    <button
                      onClick={() => handleCancel(b.id)}
                      className="text-xs px-3 py-1.5 rounded bg-red-500/10 hover:bg-red-500/20 text-red-300"
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    onClick={() => handleClear(b.id)}
                    className="text-xs px-3 py-1.5 rounded bg-white/5 hover:bg-white/10 text-white/50"
                  >
                    Clear
                  </button>
                </div>

                {b.status === "completed" && results[b.id] && (
                  <div className="w-full grid grid-cols-3 gap-2 mt-2">
                    {results[b.id].map((r, i) => (
                      <img
                        key={i}
                        src={r.b64_png ? `data:image/png;base64,${r.b64_png}` : r.url}
                        alt={r.custom_id}
                        className="w-full aspect-square object-cover rounded bg-black/30"
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
