"use strict";
"use client";

import { useState } from "react";
import { Search, Copy, Check, Terminal, Command, Sliders } from "lucide-react";

interface SlashCommand {
  cmd: string;
  category: "session" | "tools" | "config" | "ui";
  desc: string;
  example?: string;
}

const slashCommands: SlashCommand[] = [
  { cmd: "/mode", category: "config", desc: "Switch agent mode (default, accept-edits, plan, auto)", example: "/mode auto" },
  { cmd: "/settings", category: "config", desc: "Open interactive settings panel (or press Ctrl+,)" },
  { cmd: "/set", category: "config", desc: "Update a persisted setting directly", example: "/set colorScheme dark" },
  { cmd: "/api", category: "config", desc: "Interactive wizard to add, switch, or remove AI providers", example: "/api add" },
  { cmd: "/model", category: "config", desc: "Pick or switch active model for current provider", example: "/model claude-3-7-sonnet" },
  { cmd: "/undo", category: "tools", desc: "Roll back the last file edit, write, or delete checkpoint" },
  { cmd: "/tasks", category: "tools", desc: "Manage background shell tasks (list, log, kill)", example: "/tasks log 101" },
  { cmd: "/init", category: "tools", desc: "Scan project and generate customized KOVENCE.md instructions" },
  { cmd: "/sessions", category: "session", desc: "Open session picker to switch, create, or delete sessions (Ctrl+S)" },
  { cmd: "/new", category: "session", desc: "Open a fresh isolated session immediately (Ctrl+N)" },
  { cmd: "/rename", category: "session", desc: "Rename the current session", example: "/rename auth-refactor" },
  { cmd: "/fork", category: "session", desc: "Fork the current session into a new branch with full history", example: "/fork experiment-1" },
  { cmd: "/export", category: "session", desc: "Export session transcript as Markdown or JSON", example: "/export md notes.md" },
  { cmd: "/edit-last", category: "session", desc: "Pop last turn and restore prompt into composer for editing" },
  { cmd: "/retry", category: "session", desc: "Retry the last failed or aborted user turn" },
  { cmd: "/history", category: "session", desc: "Display complete session chat history" },
  { cmd: "/compact", category: "session", desc: "Compact long conversation history into session summary" },
  { cmd: "/clear", category: "session", desc: "Clear current session history and working memory" },
  { cmd: "/cost", category: "ui", desc: "Show estimated session token cost in USD" },
  { cmd: "/stats", category: "ui", desc: "Display full context size, speed, and token statistics" },
  { cmd: "/copy", category: "ui", desc: "Copy last AI response cleanly to system clipboard (Ctrl+Y)" },
  { cmd: "/select", category: "ui", desc: "Toggle native terminal mouse selection mode (F2)" },
  { cmd: "/help", category: "ui", desc: "Show all slash commands and keyboard shortcuts" },
  { cmd: "/exit", category: "ui", desc: "Gracefully exit Kovence CLI" },
];

const cliFlags = [
  { flag: "--provider <name>", desc: "Use a configured OpenAI/Anthropic provider" },
  { flag: "-m, --model <name>", desc: "Override active model for this execution" },
  { flag: "-p, --prompt <text>", desc: "Non-interactive headless prompt (prints to stdout)" },
  { flag: "--mode <mode>", desc: "Agent mode: default | accept-edits | plan | auto" },
  { flag: "-a, --auto", desc: "Alias for --mode auto" },
  { flag: "--plain", desc: "Use plain scrollback REPL instead of full-screen TUI" },
  { flag: "--json", desc: "Emit structured JSON result in headless mode" },
  { flag: "--no-session", desc: "Run without persisting session history to disk" },
  { flag: "--debug", desc: "Enable verbose debug tracing" },
  { flag: "doctor", desc: "Subcommand: verify Node, tools, configs & ping providers" },
];

export default function CommandExplorer() {
  const [view, setView] = useState<"slash" | "flags">("slash");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<"all" | "session" | "tools" | "config" | "ui">("all");
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  const copyCommand = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCmd(text);
    setTimeout(() => setCopiedCmd(null), 1800);
  };

  const filteredSlash = slashCommands.filter((c) => {
    const matchCat = category === "all" || c.category === category;
    const matchSearch =
      c.cmd.toLowerCase().includes(search.toLowerCase()) ||
      c.desc.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  });

  const filteredFlags = cliFlags.filter(
    (f) =>
      f.flag.toLowerCase().includes(search.toLowerCase()) ||
      f.desc.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <section id="commands" className="relative py-16 md:py-24 border-t border-white/[0.08]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center mb-12">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1 text-xs font-mono font-medium text-amber-400 mb-4">
            Interactive Reference
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
            Commands &amp; CLI Options
          </h2>
          <p className="mt-3 text-base text-zinc-400">
            Type <code className="text-amber-400 bg-white/5 px-1.5 py-0.5 rounded font-mono text-sm">/</code> in the composer to access auto-complete for all commands.
          </p>
        </div>

        {/* View toggle & search bar */}
        <div className="mx-auto max-w-4xl mb-8 space-y-4">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            {/* View Selector */}
            <div className="inline-flex rounded-xl bg-zinc-900 p-1 border border-white/10">
              <button
                onClick={() => setView("slash")}
                className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-mono font-medium transition-colors ${
                  view === "slash"
                    ? "bg-amber-500 text-black font-bold"
                    : "text-zinc-400 hover:text-white"
                }`}
              >
                <Command className="h-3.5 w-3.5" />
                Slash Commands ({slashCommands.length})
              </button>
              <button
                onClick={() => setView("flags")}
                className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-mono font-medium transition-colors ${
                  view === "flags"
                    ? "bg-amber-500 text-black font-bold"
                    : "text-zinc-400 hover:text-white"
                }`}
              >
                <Terminal className="h-3.5 w-3.5" />
                CLI Flags ({cliFlags.length})
              </button>
            </div>

            {/* Search Input */}
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
              <input
                type="text"
                placeholder="Search commands..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-zinc-900/90 pl-9 pr-4 py-2 text-xs text-white placeholder-zinc-500 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 font-mono"
              />
            </div>
          </div>

          {/* Categories (only for slash commands) */}
          {view === "slash" && (
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <span className="text-xs text-zinc-500 font-mono">Category:</span>
              {(["all", "session", "tools", "config", "ui"] as const).map((cat) => (
                <button
                  key={cat}
                  onClick={() => setCategory(cat)}
                  className={`rounded-lg px-3 py-1 text-xs font-mono capitalize transition-colors ${
                    category === cat
                      ? "bg-white/15 text-white border border-white/20 font-semibold"
                      : "text-zinc-400 hover:text-white bg-zinc-900/50"
                  }`}
                >
                  {cat === "all" ? "All Commands" : cat}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Command list cards */}
        <div className="mx-auto max-w-4xl grid grid-cols-1 sm:grid-cols-2 gap-3 font-mono">
          {view === "slash" ? (
            filteredSlash.length > 0 ? (
              filteredSlash.map((c, i) => (
                <div
                  key={i}
                  className="group flex flex-col justify-between rounded-xl border border-white/10 bg-zinc-950/70 p-3.5 hover:border-amber-500/40 hover:bg-zinc-900/80 transition-all"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <span className="text-sm font-bold text-amber-400 group-hover:text-amber-300">
                        {c.cmd}
                      </span>
                      {c.example && (
                        <span className="ml-2 text-[11px] text-zinc-500">
                          {c.example}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => copyCommand(c.cmd)}
                      className="text-zinc-500 hover:text-white p-1 rounded transition-colors"
                      title="Copy command"
                    >
                      {copiedCmd === c.cmd ? (
                        <Check className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-zinc-400 font-sans leading-normal">
                    {c.desc}
                  </p>
                </div>
              ))
            ) : (
              <div className="col-span-2 py-12 text-center text-zinc-500 text-sm">
                No commands match your filter query.
              </div>
            )
          ) : filteredFlags.length > 0 ? (
            filteredFlags.map((f, i) => (
              <div
                key={i}
                className="group flex flex-col justify-between rounded-xl border border-white/10 bg-zinc-950/70 p-3.5 hover:border-amber-500/40 hover:bg-zinc-900/80 transition-all"
              >
                <div className="flex items-start justify-between">
                  <span className="text-sm font-bold text-amber-400 group-hover:text-amber-300">
                    {f.flag}
                  </span>
                  <button
                    onClick={() => copyCommand(f.flag.split(" ")[0])}
                    className="text-zinc-500 hover:text-white p-1 rounded transition-colors"
                    title="Copy flag"
                  >
                    {copiedCmd === f.flag.split(" ")[0] ? (
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
                <p className="mt-2 text-xs text-zinc-400 font-sans leading-normal">
                  {f.desc}
                </p>
              </div>
            ))
          ) : (
            <div className="col-span-2 py-12 text-center text-zinc-500 text-sm">
              No flags match your filter query.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
