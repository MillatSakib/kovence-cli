"use strict";

import { ShieldCheck, Edit3, Compass, Zap } from "lucide-react";

const modes = [
  {
    id: "default",
    name: "Default Mode",
    icon: ShieldCheck,
    tag: "Careful",
    color: "emerald",
    borderColor: "border-emerald-500/30",
    badgeBg: "bg-emerald-500/10 text-emerald-400",
    description:
      "Safe, interactive exploration. Asks for confirmation before modifying workspace files, running shell commands, or initiating network downloads.",
    edits: "Confirms each edit",
    commands: "Confirms each command",
    downloads: "Confirms URL & size",
    bestFor: "First-time users & critical production repos",
  },
  {
    id: "accept-edits",
    name: "Accept Edits",
    icon: Edit3,
    tag: "Balanced",
    color: "cyan",
    borderColor: "border-cyan-500/30",
    badgeBg: "bg-cyan-500/10 text-cyan-400",
    description:
      "Automates file changes while retaining control of shell execution. Great when you trust the agent's code edits but want to supervise terminal commands.",
    edits: "Auto-approved in workspace",
    commands: "Confirms each command",
    downloads: "Confirms URL & size",
    bestFor: "Day-to-day feature development & refactoring",
  },
  {
    id: "plan",
    name: "Plan Mode",
    icon: Compass,
    tag: "Read-Only",
    color: "blue",
    borderColor: "border-blue-500/30",
    badgeBg: "bg-blue-500/10 text-blue-400",
    description:
      "Pure research and architecture planning. All mutating tools (write_file, edit_file, delete_file) and executing commands are hard-blocked by the engine.",
    edits: "Blocked (Read-only)",
    commands: "Blocked (Read-only)",
    downloads: "Blocked",
    bestFor: "Auditing unfamiliar codebases & designing plans",
  },
  {
    id: "auto",
    name: "Auto Mode",
    icon: Zap,
    tag: "Autonomous",
    color: "amber",
    borderColor: "border-amber-500/50",
    badgeBg: "bg-amber-500/20 text-amber-400 font-bold",
    description:
      "Unattended autonomous execution. Never prompts for tool approval. Safety is guaranteed through workspace boundaries, audit logs, checkpoints, and instant /undo.",
    edits: "Auto-approved",
    commands: "Auto-approved (sandboxed)",
    downloads: "Auto-approved",
    bestFor: "Autonomous overnight tasks & trusted CI pipelines",
  },
];

export default function AgentModes() {
  return (
    <section id="modes" className="relative py-16 md:py-24 border-t border-white/[0.08] bg-zinc-950/40">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center mb-16">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1 text-xs font-mono font-medium text-amber-400 mb-4">
            Security &amp; Autonomy Matrix
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
            Four Granular Agent Modes
          </h2>
          <p className="mt-4 text-base sm:text-lg text-zinc-400">
            Switch anytime using <code className="text-amber-400 bg-white/5 px-2 py-0.5 rounded font-mono text-sm">Shift+Tab</code> or the <code className="text-amber-400 bg-white/5 px-2 py-0.5 rounded font-mono text-sm">/mode</code> slash command.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {modes.map((mode) => {
            const Icon = mode.icon;
            return (
              <div
                key={mode.id}
                className={`relative rounded-2xl border ${mode.borderColor} bg-zinc-900/60 p-6 flex flex-col justify-between hover:bg-zinc-900/90 transition-all`}
              >
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/5 border border-white/10 text-white">
                      <Icon className="h-5 w-5" />
                    </div>
                    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-mono ${mode.badgeBg}`}>
                      {mode.tag}
                    </span>
                  </div>

                  <h3 className="text-lg font-bold text-white mb-2">{mode.name}</h3>
                  <p className="text-xs sm:text-sm text-zinc-400 leading-relaxed mb-6">
                    {mode.description}
                  </p>
                </div>

                <div className="space-y-2 border-t border-white/10 pt-4 font-mono text-xs">
                  <div className="flex items-center justify-between text-zinc-400">
                    <span>File edits:</span>
                    <span className="text-zinc-200">{mode.edits}</span>
                  </div>
                  <div className="flex items-center justify-between text-zinc-400">
                    <span>Shell commands:</span>
                    <span className="text-zinc-200">{mode.commands}</span>
                  </div>
                  <div className="flex items-center justify-between text-zinc-400">
                    <span>Downloads:</span>
                    <span className="text-zinc-200">{mode.downloads}</span>
                  </div>
                  <div className="mt-3 pt-2 border-t border-white/5 text-[11px] text-amber-400/80">
                    Best for: {mode.bestFor}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
