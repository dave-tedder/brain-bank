"use client";

import { useState } from "react";
import ChatPanel from "./ChatPanel";

export default function ChatFAB() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed z-50 bottom-20 right-4 md:bottom-6 md:right-6 w-12 h-12 rounded-full bg-[var(--bg-surface)] border border-[var(--border)] flex items-center justify-center hover:border-[var(--accent)] hover:shadow-[0_0_16px_rgba(0,255,65,0.2)] transition-all duration-300 group"
          aria-label="Open chat"
        >
          <span className="font-terminal text-lg text-[var(--text-primary)] group-hover:text-glow">
            {">_"}
          </span>
        </button>
      )}

      <ChatPanel open={open} onClose={() => setOpen(false)} />
    </>
  );
}
