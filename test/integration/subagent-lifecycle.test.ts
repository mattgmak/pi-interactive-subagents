/**
 * Integration tests for the full subagent lifecycle.
 *
 * These tests spawn REAL pi sessions with REAL LLM calls.
 * Each test creates a tmux pane, runs pi with a task that uses the subagent
 * tool, and verifies the outcome via marker files and screen output.
 *
 * Duration: ~30-90s per test.
 *
 * Run inside tmux:
 *   tmux new 'npm run test:integration'
 *
 * Configuration:
 *   PI_TEST_MODEL     — model for all pi sessions. Falls back to `defaultModel`
 *                       in the host pi settings file. When neither resolves,
 *                       this suite skips.
 *   PI_TEST_TIMEOUT   — per-test timeout in ms (default 120000)
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  untrackSurface,
  startPi,
  waitForScreen,
  waitForFile,
  sleep,
  uniqueId,
  trackTempFile,
  readScreen,
  PI_TIMEOUT,
  TEST_MODEL,
  NO_MODEL_SKIP_REASON,
  type TestEnv,
} from "./harness.ts";
import { isSurfaceAlive } from "../../pi-extension/subagents/tmux.ts";
import * as subagentsModule from "../../pi-extension/subagents/index.ts";

const backends = getAvailableBackends();

if (backends.length === 0) {
  console.log("⚠️  tmux is not available — skipping subagent lifecycle integration tests");
  console.log("   Run inside tmux to enable these tests.");
}

if (TEST_MODEL === null) {
  console.log("⚠️  no model resolved — skipping subagent lifecycle integration tests");
  console.log(`   ${NO_MODEL_SKIP_REASON}.`);
}

const modelSkip: false | string = TEST_MODEL === null ? NO_MODEL_SKIP_REASON : false;

for (const backend of backends) {
  describe(`subagent-lifecycle [${backend}]`, { timeout: PI_TIMEOUT * 3, skip: modelSkip }, () => {
    let env: TestEnv;

    before(() => {
      env = createTestEnv();
    });

    after(() => {
      cleanupTestEnv(env);
    });

    // ── Basic spawn + completion ──

    it("spawns a subagent that writes a file and verifies the session", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-echo-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `echo-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Echo-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run this bash command: echo 'PASS_${id}' > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say INTEGRATION_COMPLETE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Verify: subagent created the marker file
      const content = await waitForFile(markerFile, PI_TIMEOUT, /PASS/);
      assert.ok(
        content.includes(`PASS_${id}`),
        `Marker file should contain PASS_${id}. Got: ${content.trim()}`,
      );

      // Verify: outer pi received the subagent result
      const screen = await waitForScreen(
        surface,
        /INTEGRATION_COMPLETE|completed|Sub-agent.*"Echo/i,
        PI_TIMEOUT,
      );

      // Verify: session file was created (shown in steer result)
      const sessionMatch = screen.match(/Session:\s*(\S+\.jsonl)/);
      if (sessionMatch) {
        const sessionFile = sessionMatch[1];
        assert.ok(existsSync(sessionFile), `Subagent session file should exist: ${sessionFile}`);

        const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
        assert.ok(lines.length >= 2, `Session should have ≥2 entries, got ${lines.length}`);

        const header = JSON.parse(lines[0]);
        assert.equal(header.type, "session", "First entry should be session header");
        assert.ok(header.id, "Session header should have an id");
      }
    });

    // ── In-progress activity snapshots ──

    it("keeps a long active tool call from surfacing false stalled status", async () => {
      const id = uniqueId();
      const startFile = `/tmp/pi-integ-status-start-${id}.txt`;
      const markerFile = `/tmp/pi-integ-status-${id}.txt`;
      trackTempFile(env, startFile);
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `status-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Status-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run this bash command: echo 'START_${id}' > '${startFile}'; sleep 90; echo 'STATUS_${id}' > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say STATUS_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const activeScreen = await waitForScreen(surface, /active[\s\S]*bash|bash[\s\S]*active/i, PI_TIMEOUT, 300);
      assert.doesNotMatch(activeScreen, /Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i);

      await waitForFile(startFile, PI_TIMEOUT, /START_/);
      assert.equal(existsSync(markerFile), false, "Completion marker should not exist before the long sleep");
      await sleep(65_000);
      assert.equal(existsSync(markerFile), false, "Completion marker should not exist before the watchdog assertion");
      const watchdogScreen = readScreen(surface, 300);
      assert.doesNotMatch(watchdogScreen, /Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i);

      const content = await waitForFile(markerFile, PI_TIMEOUT, /STATUS_/);
      assert.ok(content.includes(`STATUS_${id}`), `Marker file should contain STATUS_${id}`);

      const completionScreen = await waitForScreen(
        surface,
        /STATUS_TEST_DONE|completed|Sub-agent.*"Status-/i,
        PI_TIMEOUT,
        300,
      );
      assert.ok(/STATUS_TEST_DONE|completed/i.test(completionScreen));
    });

    // ── Parallel subagent spawn ──

    it("spawns two subagents in parallel and both complete", async () => {
      const id = uniqueId();
      const fileA = `/tmp/pi-integ-para-${id}-a.txt`;
      const fileB = `/tmp/pi-integ-para-${id}-b.txt`;
      trackTempFile(env, fileA);
      trackTempFile(env, fileB);

      const surface = createTrackedSurface(env, `parallel-${id}`);
      await sleep(1000);

      const task = [
        `You must call the subagent tool TWICE. Make both calls before waiting for results.`,
        ``,
        `First call:`,
        `  name: "ParaA-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: echo 'DONE_A_${id}' > '${fileA}'"`,
        ``,
        `Second call:`,
        `  name: "ParaB-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: echo 'DONE_B_${id}' > '${fileB}'"`,
        ``,
        `Call both subagent tools NOW, do not wait between them.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Both marker files should appear
      const [contentA, contentB] = await Promise.all([
        waitForFile(fileA, PI_TIMEOUT, /DONE_A/),
        waitForFile(fileB, PI_TIMEOUT, /DONE_B/),
      ]);

      assert.ok(contentA.includes(`DONE_A_${id}`), `File A should contain marker`);
      assert.ok(contentB.includes(`DONE_B_${id}`), `File B should contain marker`);
    });

    // ── Fork mode ──

    it("fork mode creates a child session linked to the parent", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-fork-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `fork-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Fork-${id}"`,
        `  fork: true`,
        `  task: "Run this bash command: echo 'FORK_OK_${id}' > '${markerFile}'"`,
        `Do not set the agent parameter. Just set name, fork, and task.`,
        `After you receive the result, say FORK_COMPLETE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Verify: forked subagent created the file
      const content = await waitForFile(markerFile, PI_TIMEOUT, /FORK_OK/);
      assert.ok(content.includes(`FORK_OK_${id}`), `Fork marker file should exist with content`);

      // Wait for the outer pi to show the result
      const screen = await waitForScreen(
        surface,
        /FORK_COMPLETE|completed|Sub-agent.*"Fork/i,
        PI_TIMEOUT,
      );

      // Verify: the forked session has a parent link
      const sessionMatch = screen.match(/Session:\s*(\S+\.jsonl)/);
      if (sessionMatch) {
        const sessionFile = sessionMatch[1];
        assert.ok(existsSync(sessionFile), `Fork session file should exist: ${sessionFile}`);

        const entries = readFileSync(sessionFile, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
        const header = entries[0];
        assert.equal(header.type, "session", "First entry should be session header");
        assert.ok(header.parentSession, "Fork session should have parentSession field");
        // Fork sessions include parent context (model_change entries etc.)
        assert.ok(entries.length >= 2, "Fork session should have context entries beyond header");
      }
    });

    // ── caller_ping ──

    it("subagent caller_ping sends notification back to the parent", async () => {
      const id = uniqueId();

      const surface = createTrackedSurface(env, `ping-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Ping-${id}"`,
        `  agent: "test-ping"`,
        `  task: "PING_TEST_${id}"`,
        `Just call the subagent tool once. Do not do anything else before calling it.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The test-ping agent calls caller_ping, which steers a "needs help" message
      // back to the outer pi. Look for it on screen.
      const screen = await waitForScreen(
        surface,
        /needs help|PING|caller_ping|ping/i,
        PI_TIMEOUT,
      );

      assert.ok(
        /needs help|PING/i.test(screen),
        `Screen should show ping notification. Got:\n${screen.slice(-800)}`,
      );
    });

    // ── Agent discovery ──

    it("subagent discovers project-local test agents", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-discovery-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `discovery-${id}`);
      await sleep(1000);

      // Use subagents_list to verify test agents are discoverable,
      // then spawn one to prove it works end-to-end.
      const task = [
        `First, call the subagents_list tool to see available agents.`,
        `Then call the subagent tool:`,
        `  name: "Disco-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: echo 'DISCO_${id}' > '${markerFile}'"`,
        `After you receive the subagent result, say DISCOVERY_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The test-echo agent (discovered from project .pi/agents/) should work
      const content = await waitForFile(markerFile, PI_TIMEOUT, /DISCO/);
      assert.ok(content.includes(`DISCO_${id}`), `Discovery test marker should exist`);
    });

    // ── Subagent with custom system prompt ──

    it("passes systemPrompt to subagent", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-sysprompt-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `sysprompt-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these parameters:`,
        `  name: "SysP-${id}"`,
        `  agent: "test-echo"`,
        `  systemPrompt: "Always start your response with CUSTOM_PROMPT_ACTIVE."`,
        `  task: "Write 'SYSPROMPT_${id}' to ${markerFile} using bash: echo 'SYSPROMPT_${id}' > '${markerFile}'"`,
        `After the subagent completes, say SYSPROMPT_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const content = await waitForFile(markerFile, PI_TIMEOUT, /SYSPROMPT/);
      assert.ok(content.includes(`SYSPROMPT_${id}`), `System prompt test marker should exist`);
    });
  });
}

// ── Liveness reaper and stop control ──
//
// These cases need real panes but no model, so they run in seconds and stay out
// of the LLM cost of the suite above. Rows are added to the extension registry
// directly, and the pane probe is the shipped one.

const muxSkip: false | string =
  backends.length === 0 ? "tmux is not available — run inside tmux" : false;

describe("subagent lifecycle control [tmux]", { timeout: PI_TIMEOUT, skip: muxSkip }, () => {
  const testApi = (subagentsModule as any).__test__;
  const running = testApi.runningSubagents as Map<string, any>;
  const { REAP_GRACE_MS, REAP_INTERVAL_MS, shouldReapSubagent, reapDeadSubagents } = testApi;
  const { handleSubagentStop, replaceRunningByName } = testApi;

  let env: TestEnv;

  before(() => {
    env = createTestEnv();
  });

  after(() => {
    running.clear();
    cleanupTestEnv(env);
  });

  beforeEach(() => {
    running.clear();
  });

  function makeRow(overrides: Record<string, unknown> = {}): any {
    return {
      id: "row-1",
      name: "Worker",
      task: "",
      surface: "%missing",
      startTime: Date.now(),
      sessionFile: "/tmp/pi-integ-absent.jsonl",
      interactive: false,
      statusState: {},
      ...overrides,
    };
  }

  it("reaps a pane with no live pi process after the grace window", async () => {
    const surface = createTrackedSurface(env, `reap-dead-${uniqueId()}`);
    await sleep(600);
    assert.equal(isSurfaceAlive(surface), false, "a bare shell pane holds no pi process");

    const row = makeRow({ id: "dead-1", surface, startSentinelAt: Date.now() - REAP_GRACE_MS - 1000 });
    running.set(row.id, row);

    const reaped = reapDeadSubagents(Date.now(), { showsDone: () => false });
    assert.equal(reaped.length, 1, "the dead row should be reaped");
    assert.equal(running.has("dead-1"), false, "the reaped row should leave the registry");

    untrackSurface(env, surface);
    assert.throws(() => readScreen(surface, 5), "the reaper should kill the pane");
  });

  it("spares a pane that still hosts a live child process", async () => {
    const surface = createTrackedSurface(env, `reap-live-${uniqueId()}`);
    await sleep(600);
    // Command form beats typed input here: no shell-init race in the fixture.
    execFileSync("tmux", ["respawn-pane", "-k", "-t", surface, "bash -c 'sleep 45'"], {
      encoding: "utf8",
    });
    await sleep(800);

    // `sleep` stands in for pi: the probe only needs one live descendant.
    const alive = (target: string) =>
      isSurfaceAlive(target, { isPiCommand: (command) => command.startsWith("sleep") });
    assert.equal(alive(surface), true, "the pane should report a live child");

    running.set("live-1", makeRow({ id: "live-1", surface, startSentinelAt: Date.now() - REAP_GRACE_MS - 1000 }));
    const reaped = reapDeadSubagents(Date.now(), { alive, showsDone: () => false });

    assert.equal(reaped.length, 0, "a live pane must never be reaped");
    assert.equal(running.has("live-1"), true, "the live row should stay registered");
    assert.equal(readScreen(surface, 5) !== undefined, true, "the pane should still be open");
  });

  it("spares a pane that has not printed the start sentinel", async () => {
    const surface = createTrackedSurface(env, `reap-pre-${uniqueId()}`);
    await sleep(600);

    // No startSentinelAt: the launch may still be starting pi in this pane.
    running.set("pre-1", makeRow({ id: "pre-1", surface }));
    const reaped = reapDeadSubagents(Date.now(), { showsDone: () => false });

    assert.equal(reaped.length, 0, "a pre-launch pane must never be reaped");
    assert.equal(running.has("pre-1"), true);
    assert.equal(isSurfaceAlive(surface), false, "the fixture pane holds no pi process");
    assert.equal(readScreen(surface, 5) !== undefined, true, "but the pane stays open");
  });

  it("never reaps inside the 25s grace window", () => {
    const dead = () => false;
    const now = Date.now();

    assert.equal(REAP_GRACE_MS, 25_000, "the grace window is fixed at 25s");
    assert.equal(REAP_INTERVAL_MS, 10_000, "the module tick is fixed at 10s");
    assert.equal(shouldReapSubagent(makeRow({ surface: "%gone" }), now, dead), false);

    const start = now - REAP_GRACE_MS + 1;
    assert.equal(shouldReapSubagent(makeRow({ surface: "%gone", startSentinelAt: start }), now, dead), false);

    const past = now - REAP_GRACE_MS - 1;
    assert.equal(shouldReapSubagent(makeRow({ surface: "%gone", startSentinelAt: past }), now, dead), true);

    // A live probe always wins, however old the row is.
    assert.equal(shouldReapSubagent(makeRow({ surface: "%gone", startSentinelAt: past }), now, () => true), false);
  });

  it("replaces an old row when an explicit name is reused", () => {
    const killed: string[] = [];
    running.set("old-1", makeRow({ id: "old-1", name: "Scout", surface: "%old" }));
    running.set("other-1", makeRow({ id: "other-1", name: "Worker", surface: "%other" }));

    const replaced = replaceRunningByName("Scout", (surface: string) => killed.push(surface));
    assert.equal(replaced.length, 1);
    assert.deepEqual(killed, ["%old"]);
    assert.equal(running.has("old-1"), false, "the old row must be gone");
    assert.equal(running.has("other-1"), true, "other names stay untouched");

    // The fresh spawn then registers under the same name: one row per name.
    running.set("new-1", makeRow({ id: "new-1", name: "Scout", surface: "%new" }));
    const scouts = [...running.values()].filter((row) => row.name === "Scout");
    assert.equal(scouts.length, 1, "exactly one row may hold the name");
    assert.equal(scouts[0].id, "new-1");
  });

  it("stops a running subagent by id and kills its pane", async () => {
    const surface = createTrackedSurface(env, `stop-id-${uniqueId()}`);
    await sleep(600);
    running.set("keep-1", makeRow({ id: "keep-1", name: "Worker", surface: "%keep" }));
    running.set("target-1", makeRow({ id: "target-1", name: "Scout", surface }));

    const result = handleSubagentStop({ id: "target-1" });

    assert.equal(result.details.status, "stopped");
    assert.deepEqual(result.details.stopped, [{ id: "target-1", name: "Scout" }]);
    assert.match(result.content[0].text, /target-1/);
    assert.equal(running.has("target-1"), false, "the stopped row must be gone");
    assert.equal(running.has("keep-1"), true, "the id must win over a shared name");

    untrackSurface(env, surface);
    assert.throws(() => readScreen(surface, 5), "the stop path should close the pane");
  });

  it("stops a running subagent by name", () => {
    const killed: string[] = [];
    running.set("a1", makeRow({ id: "a1", name: "Scout", surface: "%a" }));
    running.set("b1", makeRow({ id: "b1", name: "Worker", surface: "%b" }));

    const result = handleSubagentStop({ name: "Scout" }, (surface: string) => killed.push(surface));

    assert.equal(result.details.stopped.length, 1);
    assert.deepEqual(killed, ["%a"]);
    assert.equal(running.has("a1"), false);
    assert.equal(running.has("b1"), true);
  });

  it("stops every row when the name is ambiguous", () => {
    const killed: string[] = [];
    running.set("a1", makeRow({ id: "a1", name: "Worker", surface: "%a" }));
    running.set("b2", makeRow({ id: "b2", name: "Worker", surface: "%b" }));
    running.set("c3", makeRow({ id: "c3", name: "Scout", surface: "%c" }));

    const result = handleSubagentStop({ name: "Worker" }, (surface: string) => killed.push(surface));

    assert.equal(result.details.stopped.length, 2, "both matching rows should stop");
    assert.deepEqual(killed.sort(), ["%a", "%b"]);
    assert.equal(result.content[0].text.includes("[a1]"), true);
    assert.equal(result.content[0].text.includes("[b2]"), true);
    assert.equal(running.size, 1, "only the unrelated row should remain");
    assert.equal(running.has("c3"), true);
  });

  it("errors for an unknown name or id and names the resume path", () => {
    running.set("a1", makeRow({ id: "a1", name: "Worker", surface: "%a" }));

    const missingName = handleSubagentStop({ name: "Ghost" });
    assert.match(missingName.content[0].text, /No running subagent named "Ghost"/);
    assert.match(missingName.content[0].text, /subagent_message/);
    assert.match(missingName.content[0].text, /Running: Worker/);
    assert.equal(running.size, 1, "an unknown name stops nothing");

    const missingId = handleSubagentStop({ id: "nope" });
    assert.match(missingId.content[0].text, /No running subagent with id "nope"/);
    assert.match(missingId.content[0].text, /subagent_message/);
    assert.equal(missingId.details.error !== undefined, true);

    const empty = handleSubagentStop({});
    assert.match(empty.content[0].text, /Provide `id` or `name`/);
  });
});
