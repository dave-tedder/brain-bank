"use client";

import { useRef, useEffect } from "react";
import { useOpenBrainChat } from "@/lib/useOpenBrainChat";
import { APP } from "@/config/app";

interface ChatPanelProps {
  open: boolean;
  onClose: () => void;
}

export default function ChatPanel({ open, onClose }: ChatPanelProps) {
  const { messages, input, setInput, handleSubmit, isLoading, cancel } =
    useOpenBrainChat();
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [open]);

  function handleClose() {
    cancel();
    onClose();
  }

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 bg-black/60 z-[60] md:hidden"
          onClick={handleClose}
        />
      )}

      <div
        className={`
          fixed z-[70] flex flex-col
          bg-[var(--bg-primary)] border-l border-[var(--border)]
          transition-transform duration-300 ease-out
          inset-0 h-[100dvh] md:inset-auto md:h-auto
          md:top-0 md:right-0 md:bottom-0 md:w-[420px]
          ${open ? "translate-x-0" : "translate-x-full"}
        `}
        style={{
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        <div
          className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]"
          style={{ background: "var(--bg-surface)" }}
        >
          <div className="flex items-center gap-2">
            <span className="font-terminal text-lg text-[var(--text-primary)]">
              {APP.chatHeader.toUpperCase()}
            </span>
            <span
              className="inline-block w-2 h-2 rounded-full bg-[var(--accent)]"
              style={{ animation: "glowPulse 2s ease-in-out infinite" }}
            />
          </div>
          <button
            onClick={handleClose}
            className="font-terminal text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors text-xl px-2"
          >
            [X]
          </button>
        </div>

        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto p-4 space-y-4"
        >
          {messages.length === 0 && (
            <div className="text-center py-12">
              <div className="font-terminal text-2xl text-[var(--text-primary)] text-glow mb-3">
                {">_"}
              </div>
              <p className="text-sm text-[var(--text-muted)] font-mono">
                Query the neural network.
              </p>
              <p className="text-xs text-[var(--text-muted)] font-mono mt-1 opacity-60">
                Ask about thoughts, clients, projects, or anything in memory.
              </p>
            </div>
          )}

          {messages.map((m) => (
            <div key={m.id} className="animate-in">
              {m.role === "user" ? (
                <div className="flex gap-2">
                  <span className="font-terminal text-[var(--text-muted)] shrink-0 pt-0.5">
                    {">"}
                  </span>
                  <p className="text-sm font-mono text-[var(--text-secondary)] whitespace-pre-wrap">
                    {m.content}
                  </p>
                </div>
              ) : (
                <div className="pl-4 border-l border-[var(--border)]">
                  <div className="text-sm font-mono text-[var(--text-body)] whitespace-pre-wrap leading-relaxed">
                    {m.content}
                  </div>
                </div>
              )}
            </div>
          ))}

          {isLoading &&
            messages.length > 0 &&
            messages[messages.length - 1]?.content === "" && (
              <div className="pl-4 border-l border-[var(--border)]">
                <span
                  className="font-terminal text-[var(--text-primary)]"
                  style={{ animation: "terminalBlink steps(1) 0.8s infinite" }}
                >
                  _
                </span>
              </div>
            )}
        </div>

        <form
          onSubmit={handleSubmit}
          className="border-t border-[var(--border)] p-3 flex gap-2"
          style={{ background: "var(--bg-surface)" }}
        >
          <span className="font-terminal text-[var(--text-primary)] pt-2 shrink-0">
            {">"}
          </span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="query..."
            disabled={isLoading}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="send"
            className="flex-1 bg-transparent border-none outline-none text-base md:text-sm font-mono text-[var(--text-secondary)] placeholder:text-[var(--text-muted)] disabled:opacity-50"
          />
          <button
            type="submit"
            tabIndex={-1}
            disabled={isLoading || !input.trim()}
            className="font-terminal text-sm px-3 py-1.5 rounded-md border border-[var(--border)] text-[var(--text-primary)] hover:border-[var(--accent)] hover:text-glow disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          >
            SEND
          </button>
        </form>
      </div>
    </>
  );
}
