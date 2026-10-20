/**
 * Integration tests for cross-session surface placement.
 *
 * `launchSurfaceAt` puts a subagent pane in a new window, in another tmux
 * session, or in a detached new session. These tests assert real tmux
 * behaviour: the launch script runs in the placed pane and prints its marker.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  launchSurfaceAt,
  readScreenAsync,
  writeLaunchScript,
  type SurfacePlacement,
} from "../../pi-extension/subagents/tmux.ts";
import {
  createTestEnv,
  cleanupTestEnv,
  getAvailableBackends,
  sleep,
  uniqueId,
  waitForScreen,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();

if (backends.length === 0) {
  console.log("⚠️  tmux is not available — skipping surface-placement integration tests");
}

/** Launch a script that prints a marker, and wait until the marker shows. */
async function place(env: TestEnv, target: string | undefined): Promise<
  SurfacePlacement & { marker: string }
> {
  const marker = `PLACE_${uniqueId()}`;
  const scriptPath = join(env.dir, `placement-${uniqueId()}.sh`);
  writeLaunchScript(`echo "${marker}"`, { scriptPath });
  const placement = launchSurfaceAt("placement-test", scriptPath, env.dir, target);
  await waitForScreen(placement.pane, new RegExp(marker), 20_000, 50);
  return { ...placement, marker };
}

function killSession(name: string): void {
  try {
    execFileSync("tmux", ["kill-session", "-t", `=${name}`], { stdio: "ignore" });
  } catch {}
}

function screenOf(surface: string): Promise<string> {
  return readScreenAsync(surface, 50);
}

for (const backend of backends) {
  describe(`surface-placement [${backend}]`, { timeout: 60_000 }, () => {
    let env: TestEnv = createTestEnv();
    const createdSessions: string[] = [];
    const createdPanes: string[] = [];

    after(() => {
      for (const session of createdSessions) killSession(session);
      for (const pane of createdPanes) {
        try {
          execFileSync("tmux", ["kill-pane", "-t", pane], { stdio: "ignore" });
        } catch {}
      }
      cleanupTestEnv(env);
    });

    it("splits a pane when no surface target is given", async () => {
      const placement = await place(env, undefined);
      createdPanes.push(placement.pane);

      assert.equal(placement.target, null);
      assert.ok(placement.session, "expected a resolved session name");
      assert.match(await screenOf(placement.pane), new RegExp(placement.marker));
    });

    it("opens a new window in the caller session for new-window", async () => {
      const placement = await place(env, "new-window");
      createdPanes.push(placement.pane);

      assert.equal(placement.target, "new-window");
      assert.ok(placement.session, "expected a resolved session name");
      assert.match(await screenOf(placement.pane), new RegExp(placement.marker));
    });

    it("targets an existing tmux session by name", async () => {
      const session = `pi-test-${uniqueId()}`;
      execFileSync("tmux", ["new-session", "-d", "-s", session], { stdio: "ignore" });
      createdSessions.push(session);

      const placement = await place(env, session);
      createdPanes.push(placement.pane);

      assert.equal(placement.target, session);
      assert.equal(placement.session, session);
      assert.match(await screenOf(placement.pane), new RegExp(placement.marker));
    });

    it("creates a detached session for NEW <name>", async () => {
      const session = `pi-test-new-${uniqueId()}`;
      createdSessions.push(session);

      const placement = await place(env, `NEW ${session}`);
      createdPanes.push(placement.pane);

      assert.equal(placement.target, `NEW ${session}`);
      assert.equal(placement.session, session);
      assert.match(await screenOf(placement.pane), new RegExp(placement.marker));
    });

    it("reuses an existing session for a second NEW <name>", async () => {
      const session = `pi-test-reuse-${uniqueId()}`;
      createdSessions.push(session);

      const first = await place(env, `NEW ${session}`);
      await sleep(500);
      const second = await place(env, `NEW ${session}`);
      createdPanes.push(first.pane, second.pane);

      assert.notEqual(first.pane, second.pane);
      assert.equal(second.session, session);
      assert.match(await screenOf(second.pane), new RegExp(second.marker));
    });
  });
}
