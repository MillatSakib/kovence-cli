"use strict";
"use client";

import { useState } from "react";
import { Terminal, Shield, Play, RotateCcw, Sliders, CheckCircle2 } from "lucide-react";

export default function TerminalPreview() {
  const [activeTab, setActiveTab] = useState<"turn" | "auto" | "undo" | "settings">("turn");

  return (
    <section className="relative py-12 md:py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        {/* Section title */}
        <div className="text-center mb-8">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
            Experience the Terminal Interface
          </h2>
          <p className="mt-2 text-sm sm:text-base text-zinc-400">
            Interactive, responsive, full-screen TUI with collapsible tool cards and live status.
          </p>
        </div>

        {/* Tab switcher */}
        <div className="flex flex-wrap items-center justify-center gap-2 mb-6">
          <button
            onClick={() => setActiveTab("turn")}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-mono font-medium transition-all ${
              activeTab === "turn"
                ? "bg-amber-500 text-black shadow-md shadow-amber-500/20"
                : "bg-zinc-900 text-zinc-400 hover:text-white hover:bg-zinc-800 border border-white/5"
            }`}
          >
            <Terminal className="h-3.5 w-3.5" />
            1. Coding Turn & Tools
          </button>
          <button
            onClick={() => setActiveTab("auto")}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-mono font-medium transition-all ${
              activeTab === "auto"
                ? "bg-amber-500 text-black shadow-md shadow-amber-500/20"
                : "bg-zinc-900 text-zinc-400 hover:text-white hover:bg-zinc-800 border border-white/5"
            }`}
          >
            <Play className="h-3.5 w-3.5" />
            2. Autonomous Mode
          </button>
          <button
            onClick={() => setActiveTab("undo")}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-mono font-medium transition-all ${
              activeTab === "undo"
                ? "bg-amber-500 text-black shadow-md shadow-amber-500/20"
                : "bg-zinc-900 text-zinc-400 hover:text-white hover:bg-zinc-800 border border-white/5"
            }`}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            3. Instant /undo
          </button>
          <button
            onClick={() => setActiveTab("settings")}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-mono font-medium transition-all ${
              activeTab === "settings"
                ? "bg-amber-500 text-black shadow-md shadow-amber-500/20"
                : "bg-zinc-900 text-zinc-400 hover:text-white hover:bg-zinc-800 border border-white/5"
            }`}
          >
            <Sliders className="h-3.5 w-3.5" />
            4. TUI /settings (Ctrl+,)
          </button>
        </div>

        {/* Terminal Window Box */}
        <div className="relative mx-auto rounded-2xl border border-white/10 bg-[#0d0d12] shadow-2xl shadow-black/90 overflow-hidden font-mono text-xs sm:text-sm">
          {/* Mac/Linux Header Bar */}
          <div className="flex items-center justify-between border-b border-white/10 bg-[#14141b] px-4 py-3 select-none">
            <div className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-full bg-red-500/80 inline-block" />
              <span className="h-3 w-3 rounded-full bg-yellow-500/80 inline-block" />
              <span className="h-3 w-3 rounded-full bg-green-500/80 inline-block" />
              <span className="ml-3 text-xs text-zinc-400 font-mono hidden sm:inline-block">
                kovence — 80x24 (xterm-256color)
              </span>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-zinc-400">
              <span className="rounded bg-amber-500/20 px-2 py-0.5 text-amber-300 font-bold border border-amber-500/30">
                KOVENEC.CLI
              </span>
              <span className="hidden md:inline text-zinc-500">https://kovence-cli.kovence.com</span>
            </div>
          </div>

          {/* Terminal Screen Body */}
          <div className="p-4 sm:p-6 min-h-[380px] text-zinc-200 overflow-x-auto leading-relaxed">
            {activeTab === "turn" && (
              <div className="space-y-4">
                {/* Banner */}
                <div className="text-amber-500 font-bold select-none leading-tight hidden sm:block">
                  {`█▄▀ █▀█ █ █ █▀▀ █▄ █ █▀▀ █▀▀\n█ █ █▄█ ▀▄▀ ██▄ █ ▀█ █▄▄ ██▄`}
                </div>
                <div className="text-xs text-zinc-400 border-b border-white/5 pb-2">
                  API: <span className="text-zinc-200">openai-prod</span> · Model: <span className="text-amber-400">gpt-4o / claude-3-7-sonnet</span> · Mode: <span className="text-emerald-400">accept-edits</span>
                </div>

                {/* User Prompt */}
                <div className="pt-1">
                  <span className="text-cyan-400 font-bold">YOU &gt; </span>
                  <span className="text-white">
                    Inspect <span className="text-amber-300 font-semibold">@src/auth.ts:L15-40</span> and patch the token refresh race condition.
                  </span>
                </div>

                {/* Agent Plan */}
                <div className="rounded-lg bg-zinc-900/70 border border-white/5 p-3 space-y-2">
                  <div className="flex items-center gap-2 text-amber-400 font-semibold">
                    <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                    KOVENCE CLI · Multi-turn execution
                  </div>
                  <div className="text-zinc-300 pl-4 border-l border-amber-500/30 text-xs sm:text-sm">
                    1. Read <code className="text-amber-300">src/auth.ts</code> lines 15-40 to inspect existing mutex logic.<br/>
                    2. Create file checkpoint snapshot #1.<br/>
                    3. Apply atomic semaphore lock on refresh queue.<br/>
                    4. Run test suite to verify regression.
                  </div>
                </div>

                {/* Tool call result */}
                <div className="rounded bg-black/50 border border-emerald-500/30 p-2.5 text-xs text-emerald-300 flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    <span>✓ Tool <code className="text-white bg-white/10 px-1 py-0.5 rounded">edit_file</code> applied patch to <span className="text-emerald-200">src/auth.ts</span> (checkpoint #1 saved)</span>
                  </span>
                  <span className="text-[11px] text-zinc-500 hidden sm:inline">259.3 tok/s · TTFT 180ms</span>
                </div>
              </div>
            )}

            {activeTab === "auto" && (
              <div className="space-y-4">
                <div className="flex items-center gap-2 rounded bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-amber-300 text-xs">
                  <Shield className="h-4 w-4" />
                  <span><strong>Auto Mode Active:</strong> Truly autonomous execution. No tool confirmation prompts.</span>
                </div>

                <div>
                  <span className="text-cyan-400 font-bold">YOU &gt; </span>
                  <span className="text-white">Refactor memory classifier and run the test suite in the background.</span>
                </div>

                <div className="space-y-2 text-xs">
                  <div className="text-zinc-400">⚡ Auto-approved: <span className="text-zinc-200">read_file(src/config/memory.js)</span></div>
                  <div className="text-zinc-400">⚡ Auto-approved: <span className="text-zinc-200">edit_file(src/config/memory.js)</span> (checkpoint #4 created)</div>
                  <div className="text-zinc-400">⚡ Auto-approved: <span className="text-zinc-200">run_command("npm test", background: true)</span> → task #104</div>
                </div>

                <div className="rounded-lg bg-zinc-950 border border-white/10 p-3 font-mono text-xs">
                  <div className="text-zinc-400 mb-1">Status bar updates:</div>
                  <div className="flex items-center justify-between bg-zinc-900 px-3 py-1.5 rounded text-zinc-300">
                    <span>Kovence CLI · Mode: auto · 1 background task active</span>
                    <span className="text-emerald-400">Tasks: /tasks log 104</span>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "undo" && (
              <div className="space-y-4">
                <div className="text-zinc-400 text-xs">
                  Accidental edit or unwanted refactor? The checkpoint engine tracks every mutation.
                </div>

                <div>
                  <span className="text-cyan-400 font-bold">YOU &gt; </span>
                  <span className="text-amber-300 font-bold">/undo</span>
                </div>

                <div className="rounded-lg bg-zinc-900 border border-white/10 p-4 space-y-2 text-xs">
                  <div className="text-amber-400 font-bold flex items-center gap-2">
                    <RotateCcw className="h-4 w-4" />
                    Checkpoint Rollback Executed
                  </div>
                  <p className="text-zinc-300">
                    Restored <code className="text-amber-300">src/config/memory.js</code> to checkpoint #4 state before edit.
                  </p>
                  <div className="text-zinc-500 font-mono text-[11px]">
                    Hash match confirmed · File content restored cleanly without git stash mess.
                  </div>
                </div>

                <div className="text-xs text-emerald-400 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4" />
                  Your working tree is restored to the exact prior snapshot.
                </div>
              </div>
            )}

            {activeTab === "settings" && (
              <div className="space-y-3">
                <div className="flex items-center justify-between border-b border-white/10 pb-2 text-xs">
                  <span className="text-amber-400 font-bold">SETTINGS (Ctrl+,)</span>
                  <span className="text-zinc-400 text-[11px]">↑/↓ navigate · ←/→ cycle · Enter select · Esc exit</span>
                </div>

                <div className="space-y-1.5 text-xs">
                  <div className="flex items-center justify-between bg-amber-500/10 border border-amber-500/40 px-3 py-1.5 rounded text-white">
                    <span>▸ Agent Mode</span>
                    <span className="text-amber-400 font-bold">&lt; auto &gt;</span>
                  </div>
                  <div className="flex items-center justify-between bg-zinc-900/60 px-3 py-1.5 rounded text-zinc-300">
                    <span>  Active Provider</span>
                    <span className="text-zinc-200">openai-prod</span>
                  </div>
                  <div className="flex items-center justify-between bg-zinc-900/60 px-3 py-1.5 rounded text-zinc-300">
                    <span>  Model</span>
                    <span className="text-cyan-300">gpt-4o</span>
                  </div>
                  <div className="flex items-center justify-between bg-zinc-900/60 px-3 py-1.5 rounded text-zinc-300">
                    <span>  Color Palette</span>
                    <span className="text-amber-400">&lt; amber &gt;</span>
                  </div>
                  <div className="flex items-center justify-between bg-zinc-900/60 px-3 py-1.5 rounded text-zinc-300">
                    <span>  Tool Output Verbosity</span>
                    <span className="text-zinc-200">normal</span>
                  </div>
                  <div className="flex items-center justify-between bg-zinc-900/60 px-3 py-1.5 rounded text-zinc-300">
                    <span>  Auto Summarize Context</span>
                    <span className="text-emerald-400">true</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Terminal Footer Prompt Bar */}
          <div className="border-t border-white/10 bg-[#121218] px-4 py-2.5 flex items-center justify-between text-xs text-zinc-400">
            <div className="flex items-center gap-2">
              <span className="text-amber-400 font-bold">&gt;</span>
              <span className="text-zinc-300">Type message · Shift+Enter newline · / commands · @ file</span>
              <span className="inline-block h-3.5 w-1.5 bg-amber-400 animate-pulse" />
            </div>
            <div className="hidden sm:flex items-center gap-3 text-[11px] text-zinc-500">
              <span>Shift+Tab: cycle mode</span>
              <span>Ctrl+S: sessions</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
