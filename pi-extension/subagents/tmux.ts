/**
 * tmux surface layer — the only terminal multiplexer this extension supports.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type a command into it, read its screen, close
 * it, and poll for exit. Keeping the tmux calls isolated here means index.ts
 * stays testable without a multiplexer running.
 *
 * Panes are identified by tmux pane ids (e.g. `%12`). Splits always target
 * the parent pi's pane (`$TMUX_PANE`) so they follow the agent rather than
 * the user's focus.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * True when running inside tmux with the tmux binary on PATH.
 * `TMUX` is set by tmux in every process it spawns (shell or pane).
 */
export function isTmuxAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

export function isMuxAvailable(): boolean {
  return isTmuxAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
}

function requireTmux(): void {
  if (!isTmuxAvailable()) {
    throw new Error(`tmux is required for subagents. ${muxSetupHint()}`);
  }
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Pane layout ──

/**
 * tmux layout applied to the subagent window to keep panes evenly sized.
 * Switchable: "even-horizontal" (equal columns, matches Ctrl+b Alt+1),
 * "main-vertical" (big main pane + tiled column), "tiled" (grid).
 */
const SUBAGENT_TMUX_LAYOUT = "even-horizontal";

let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-balance subagent panes so repeated splits don't leave them lopsided.
 * tmux halves the target pane on every split and dumps freed space onto a
 * neighbor on close, so without this panes drift to wildly uneven widths.
 * Applies SUBAGENT_TMUX_LAYOUT to the parent pi window. Debounced so a burst
 * of parallel spawns or staggered exits collapses into a single layout call,
 * and non-fatal: a cosmetic resize must never break spawning or watching.
 */
function rebalanceSurfaces(hintPane?: string): void {
  // Prefer the parent pi pane (stable; survives a closing subagent pane).
  const target = process.env.TMUX_PANE ?? hintPane;
  if (!target) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    try {
      // -t <pane> resolves to that pane's window; does not change focus.
      execFileSync("tmux", ["select-layout", "-t", target, SUBAGENT_TMUX_LAYOUT], {
        encoding: "utf8",
      });
    } catch {
      // Pane/window may be gone; balancing is best-effort.
    }
  }, 120);
}

// ── Surface primitives ──

/**
 * Create a new pane for a subagent: a right split off the parent pi's pane,
 * so new panes follow the agent rather than the user's focus.
 * See https://github.com/HazAT/pi-interactive-subagents/issues/12
 *
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurface(name: string): string {
  void name; // tmux panes are not named; the pi process inside shows its own title.
  return createSurfaceSplit(name, "right", process.env.TMUX_PANE);
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
  opts?: { command?: string; cwd?: string },
): string {
  void name;
  requireTmux();

  const args = ["split-window", "-d", "-e"];
  if (direction === "left" || direction === "right") {
    args.push("-h");
  } else {
    args.push("-v");
  }
  if (direction === "left" || direction === "up") {
    args.push("-b");
  }
  if (fromSurface) {
    args.push("-t", fromSurface);
  }
  if (opts?.cwd) {
    args.push("-c", opts.cwd);
  }
  args.push("-P", "-F", "#{pane_id}");
  if (opts?.command) {
    args.push(opts.command);
  }

  const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  }

  rebalanceSurfaces(pane);
  return pane;
}

/**
 * Launch a subagent pane in command form: the pane program is
 * `bash <script>` run directly by tmux via /bin/sh — no typed keystrokes, no
 * interactive-shell init, no direnv/devenv readiness race. The script itself
 * ends with `exec ${SHELL:-bash}` (see writeLaunchScript), handing the pane
 * back to the user's interactive shell once the subagent exits.
 *
 * Returns the new pane id (e.g. `%12`).
 */
export function launchSurface(name: string, scriptPath: string, cwd?: string): string {
  return createSurfaceSplit(name, "right", process.env.TMUX_PANE, {
    cwd,
    command: `bash ${shellEscape(scriptPath)}`,
  });
}

// ── Shell readiness ──

/**
 * Interactive shells this extension treats as "safe to type into at a prompt".
 * A pane whose current command is one of these and which has no children is
 * considered idle: its shell is reading input, so typed commands will not be
 * eaten by shell init (direnv/devenv `eval "$(direnv export bash)"`, builds).
 *
 * Deliberately excludes node/pi/tmux: flushing input into a live pi session
 * during steer or resume would interrupt it.
 */
const INTERACTIVE_SHELLS = new Set(["bash", "zsh", "nu", "fish", "sh"]);

/**
 * True when the pane's shell is idle at an interactive prompt: the current
 * command is an interactive shell, the pane is alive, and the shell has no
 * child processes. During direnv/devenv activation the shell runs children
 * (`eval "$(direnv export bash)"`, builds), so this stays false until init has
 * actually finished — which is exactly the readiness signal launch waits for.
 */
async function paneIsIdleShell(surface: string): Promise<boolean> {
  let cmd = "";
  let pid = "";
  let dead = "1";
  try {
    const { stdout } = await execFileAsync(
      "tmux",
      ["display-message", "-p", "-t", surface, "#{pane_current_command} #{pane_pid} #{pane_dead}"],
      { encoding: "utf8" },
    );
    [cmd, pid, dead] = stdout.trim().split(/\s+/);
  } catch {
    return false; // pane unreachable — not an idle shell
  }
  if (!INTERACTIVE_SHELLS.has(cmd) || dead !== "0") return false;
  if (!pid || pid === "0") return true; // no pid to inspect — assume idle
  try {
    await execFileAsync("pgrep", ["-P", pid]);
    return false; // shell has children → busy (direnv/devenv eval, running job)
  } catch {
    return true; // no children → idle at prompt
  }
}

/**
 * True when the pane's current command is an interactive shell. This is the
 * safety gate for input flushing: it allows C-c/C-u only into a shell, never
 * into a pane currently running node/pi/tmux (which would interrupt a live
 * subagent session). Sync — sendCommand flushes inline.
 */
function paneIsShellSync(surface: string): boolean {
  try {
    const cmd = execFileSync(
      "tmux",
      ["display-message", "-p", "-t", surface, "#{pane_current_command}"],
      { encoding: "utf8" },
    ).trim();
    return INTERACTIVE_SHELLS.has(cmd);
  } catch {
    return false;
  }
}

const SHELL_READY_POLL_MS = 100;

/**
 * Wait until a freshly created pane's shell is genuinely ready to accept
 * typed input, instead of sleeping a fixed delay.
 *
 * Replaces the historical fixed `PI_SUBAGENT_SHELL_READY_DELAY_MS` sleep:
 * a pane whose shell is still running direnv/devenv activation has children,
 * so commands typed during that window get eaten. Polls pane_current_command /
 * pane_pid / pane_dead until the shell is idle at a prompt.
 *
 * Best-effort: resolves immediately when the shell is ready, and resolves
 * anyway once `timeoutMs` passes (the flush guard and eaten-launch detection
 * in sendCommand/pollForExit cover the overflow case). Never throws on timeout.
 */
export async function waitForShellReady(surface: string, timeoutMs: number): Promise<void> {
  requireTmux();
  const start = Date.now();
  for (;;) {
    if (await paneIsIdleShell(surface)) return;
    if (Date.now() - start >= timeoutMs) return; // best-effort
    await new Promise<void>((resolve) => setTimeout(resolve, SHELL_READY_POLL_MS));
  }
}

/**
 * Send a command string to a pane and execute it.
 * Typed literally (`-l`) so special characters are not interpreted as keys,
 * then submitted with Enter.
 *
 * `flush` clears any stale typed input (C-c to cancel, C-u to clear the
 * line) before typing the command. SAFETY: the clears are only sent when the
 * pane's current command is an interactive shell — never into a pane running
 * node/pi/tmux, which would interrupt a live pi session during steer/resume.
 */
export function sendCommand(surface: string, command: string, flush = false): void {
  requireTmux();
  if (flush && paneIsShellSync(surface)) {
    execFileSync("tmux", ["send-keys", "-t", surface, "C-c"], { encoding: "utf8" });
    execFileSync("tmux", ["send-keys", "-t", surface, "C-u"], { encoding: "utf8" });
  }
  execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
  execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
/**
 * Write a launch/resume script to disk and return its path.
 *
 * The script prints a proven-launch sentinel first: pollForExit scrapes for it
 * to distinguish "launch ran and printed" from "launch was eaten before the
 * script even started". The script ends with `exec ${SHELL:-bash}` so a pane
 * started in command form (`bash <script>` as the pane program) returns to the
 * user's interactive shell after the subagent exits — $SHELL expands inside
 * bash (the script), defaulting to plain bash when tmux's env lacks it.
 */
export function writeLaunchScript(
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash", "echo '__SUBAGENT_START__'"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);
  scriptParts.push("exec ${SHELL:-bash}");

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  return scriptPath;
}

/**
 * Send a long command to a pane by writing it to a script file first, then
 * typing `bash <script>` into the surface. Used for pre-created surfaces
 * (parallel mode) where the pane already exists and must be driven by typing.
 * New surfaces use command form via launchSurface + writeLaunchScript instead.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string; flush?: boolean },
): string {
  const scriptPath = writeLaunchScript(command, options);
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`, options?.flush ?? false);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  requireTmux();
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    {
      encoding: "utf8",
    },
  );
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireTmux();
  const { stdout } = await execFileAsync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  requireTmux();
  execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
  rebalanceSurfaces();
}

// ── Exit polling ──

/** Sentinel printed after the subagent command finishes: `__SUBAGENT_DONE_<code>__`. */
const DONE_SENTINEL_RE = /__SUBAGENT_DONE_(\d+)__/;
/** Proven-launch sentinel printed as the first line of the launch script. */
const START_SENTINEL_RE = /__SUBAGENT_START__/;
/**
 * Window in which an eaten launch is detected: the start sentinel must appear
 * within this many ms of polling, or — if the pane is just sitting at an idle
 * shell prompt — the launch is declared eaten and the pane is killed.
 */
const EATEN_LAUNCH_DETECTION_MS = 30_000;
/**
 * Grace period before eaten-launch detection kicks in, so the type→exec race
 * (command just typed, shell not yet running it) is never misread as eaten.
 */
const EATEN_LAUNCH_GRACE_MS = 2_500;

/**
 * Overall bound on pollForExit. Override with PI_SUBAGENT_EXIT_TIMEOUT_MS
 * (default 30 minutes). Read in tmux.ts so the whole poll loop — including
 * the eaten-launch detection — is bounded in one place.
 */
function getExitTimeoutMs(): number {
  const raw = process.env.PI_SUBAGENT_EXIT_TIMEOUT_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60 * 1000;
}

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error" | "timeout" | "eaten";
  /**
   * Shell exit code (from sentinel). 0 for file-based exits. 1 for
   * timed-out / eaten-launch failures (see errorMessage).
   */
  exitCode: number;
  /**
   * Error message for failure reasons: "error" (auto-retry exhausted,
   * provider overload, …), "timeout" (PI_SUBAGENT_EXIT_TIMEOUT_MS reached),
   * "eaten" (launch swallowed by shell init — pane killed).
   */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();
  const exitTimeoutMs = getExitTimeoutMs();
  let seenStart = false;

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    const elapsed = Date.now() - start;

    // Bound the whole loop: never poll forever. Default 30 min
    // (PI_SUBAGENT_EXIT_TIMEOUT_MS). Prior behavior hung indefinitely when the
    // DONE sentinel was eaten by shell init — that case is now caught by the
    // eaten-launch detection below, and this is the last-resort bound. The pane
    // is deliberately NOT killed here: it may hold a still-running pi session
    // the user can inspect or resume (watchSubagent skips closing on timeout).
    if (elapsed >= exitTimeoutMs) {
      console.error(
        `[pi-subagents] subagent on surface ${surface} did not exit within ` +
          `${Math.round(exitTimeoutMs / 1000)}s (PI_SUBAGENT_EXIT_TIMEOUT_MS); abandoning watch.`,
      );
      return {
        reason: "timeout",
        exitCode: 1,
        errorMessage:
          `Subagent did not exit within ${Math.round(exitTimeoutMs / 1000)}s ` +
          `(PI_SUBAGENT_EXIT_TIMEOUT_MS). Its pane was left open — inspect it directly; ` +
          `if the process is stuck, kill the pane, then resume with subagent_message ` +
          `or spawn a fresh subagent.`,
      };
    }

    // Slow path: read terminal screen for sentinels (crash detection +
    // proven-launch detection). DONE marks a finished subagent; START marks
    // that the launch script actually ran.
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(DONE_SENTINEL_RE);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
      if (START_SENTINEL_RE.test(screen)) {
        seenStart = true;
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    // Eaten-launch detection: within the first ~30s, if the start sentinel
    // never appeared and the pane is just sitting at an idle interactive shell
    // prompt (no children), the typed launch line was swallowed by shell init
    // (direnv/devenv eval running when the command was typed) and never ran.
    // Kill the pane and report a visible error instead of hanging forever
    // waiting for a DONE sentinel that will never print.
    if (!seenStart && elapsed >= EATEN_LAUNCH_GRACE_MS && elapsed < EATEN_LAUNCH_DETECTION_MS) {
      if (await paneIsIdleShell(surface)) {
        console.error(
          `[pi-subagents] launch of subagent on surface ${surface} was eaten by shell ` +
            `init (no __SUBAGENT_START__ seen and pane idle at shell prompt); killing pane.`,
        );
        try {
          execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
        } catch {
          // Pane may already be gone; ignore.
        }
        return {
          reason: "eaten",
          exitCode: 1,
          errorMessage:
            `Subagent launch was eaten by shell initialization (direnv/devenv still starting ` +
            `when the command was typed), so it never ran. The pane was killed; ` +
            `spawn a fresh subagent.`,
        };
      }
    }

    options.onTick?.(Math.floor(elapsed / 1000));

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
