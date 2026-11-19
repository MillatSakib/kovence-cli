"use strict";

const globalShortcuts = [
  { keys: ["Ctrl", ","], action: "Open Settings panel modal" },
  { keys: ["Ctrl", "S"], action: "Open interactive Session picker" },
  { keys: ["Ctrl", "N"], action: "Start a fresh isolated session" },
  { keys: ["Ctrl", "Y"], action: "Copy last AI response to clipboard" },
  { keys: ["Ctrl", "L"], action: "Clear screen and redraw full TUI" },
  { keys: ["Ctrl", "O"], action: "Toggle last collapsible tool block" },
  { keys: ["Shift", "Tab"], action: "Cycle agent mode (default → accept-edits → plan → auto)" },
  { keys: ["F2"], action: "Toggle terminal native mouse select mode" },
];

const composerShortcuts = [
  { keys: ["Enter"], action: "Send message / execute command" },
  { keys: ["Shift", "Enter"], action: "Insert newline without sending" },
  { keys: ["Tab"], action: "Accept slash command or @file auto-complete" },
  { keys: ["↑", "↓"], action: "Navigate input history or suggestions" },
  { keys: ["Ctrl", "← / →"], action: "Jump word-by-word (also Alt+B / Alt+F)" },
  { keys: ["Ctrl", "W"], action: "Delete word backward (also Alt+Backspace)" },
  { keys: ["Ctrl", "C"], action: "Cancel turn if busy / Exit if idle" },
  { keys: ["Esc"], action: "Clear current input / Close open modal" },
];

export default function Shortcuts() {
  return (
    <section id="shortcuts" className="relative py-16 md:py-24 border-t border-white/[0.08] bg-zinc-950/40">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center mb-16">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1 text-xs font-mono font-medium text-amber-400 mb-4">
            Productivity &amp; Ergonomics
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
            Keyboard-First Architecture
          </h2>
          <p className="mt-3 text-base text-zinc-400">
            Never reach for your mouse unless you want to. Every action has a dedicated keybinding.
          </p>
        </div>

        <div className="mx-auto max-w-5xl grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* TUI Global Shortcuts */}
          <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-6">
            <h3 className="text-base font-bold text-white mb-4 flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-amber-400" />
              TUI Global Keybindings
            </h3>
            <div className="space-y-3 font-mono text-xs">
              {globalShortcuts.map((s, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0"
                >
                  <span className="text-zinc-300 font-sans text-xs">{s.action}</span>
                  <div className="flex items-center gap-1">
                    {s.keys.map((k, ki) => (
                      <kbd
                        key={ki}
                        className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-semibold text-amber-300 border border-white/10 shadow-sm"
                      >
                        {k}
                      </kbd>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Composer Shortcuts */}
          <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-6">
            <h3 className="text-base font-bold text-white mb-4 flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-cyan-400" />
              Composer &amp; Navigation Keybindings
            </h3>
            <div className="space-y-3 font-mono text-xs">
              {composerShortcuts.map((s, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0"
                >
                  <span className="text-zinc-300 font-sans text-xs">{s.action}</span>
                  <div className="flex items-center gap-1">
                    {s.keys.map((k, ki) => (
                      <kbd
                        key={ki}
                        className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-semibold text-cyan-300 border border-white/10 shadow-sm"
                      >
                        {k}
                      </kbd>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
