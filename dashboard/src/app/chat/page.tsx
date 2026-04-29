"use client";

import { useRef, useEffect } from "react";
import { useBrainBankChat } from "@/lib/useBrainBankChat";
import { APP } from "@/config/app";

export default function ChatPage() {
  const { messages, input, setInput, handleSubmit, isLoading } =
    useBrainBankChat();
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div
      className="flex flex-col"
      style={{ height: "calc(100dvh - 120px)" }}
    >
      {/* Header */}
      <div className="animate-in mb-4">
        <h1 className="font-terminal text-2xl text-[var(--text-primary)] text-glow">
          {APP.chatHeader.toUpperCase()}
        </h1>
        <p className="text-xs font-mono text-[var(--text-muted)] mt-1">
          {APP.chatSubtitle}
        </p>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-4 mb-4">
        {messages.length === 0 && (
          <div className="text-center py-16">
            <div
              className="font-terminal text-4xl text-[var(--text-primary)] text-glow mb-4"
              style={{ animation: "terminalBlink steps(1) 1.2s infinite" }}
            >
              {">_"}
            </div>
            <p className="text-sm text-[var(--text-muted)] font-mono">
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

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="flex gap-2 p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)]"
      >
        <span className="font-terminal text-[var(--text-primary)] pt-1.5 shrink-0">
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
  );
}
