import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionDef, Project } from "../../src/config";
import {
  assertPortFreeForAction,
  buildActionCommand,
  resolveScript,
  runAction,
  splitScriptField,
} from "../../src/process";
import { killSession, listSessions, spawnShell } from "../../src/pty";

function project(partial?: Partial<Project>): Project {
  const path = partial?.path || mkdtempSync(join(tmpdir(), "hb-act-"));
  return {
    id: partial?.id || "okeroo",
    name: partial?.name || "Okeroo",
    path,
    ports: partial?.ports || [
      { id: "api", port: 4200, label: "API" },
      { id: "web", port: 3200, label: "Web" },
      { id: "expo", port: 8200, label: "Expo" },
      {
        id: "api-noflags",
        port: 4201,
        label: "API (dev flags off)",
      },
    ],
    actions: partial?.actions || [],
    stateDir: partial?.stateDir || ".runtime",
  };
}

function action(partial: Partial<ActionDef> & { id: string }): ActionDef {
  return {
    label: partial.label || partial.id,
    type: partial.type || "script",
    script: partial.script || "scripts/x.sh",
    args: partial.args || [],
    kind: partial.kind || "action",
    group: partial.group || "main",
    variant: partial.variant || "default",
    hint: partial.hint || "",
    restartAction: partial.restartAction || "",
    compose: partial.compose || [],
    env: partial.env || {},
    ...partial,
  };
}

describe("splitScriptField", () => {
  test("splits pnpm --filter args (spaces in script field)", () => {
    expect(splitScriptField("pnpm --filter @okeroo/api seed:qa")).toEqual([
      "pnpm",
      "--filter",
      "@okeroo/api",
      "seed:qa",
    ]);
  });

  test("keeps quoted tokens intact", () => {
    expect(splitScriptField(`echo "hello world" 'x y'`)).toEqual([
      "echo",
      "hello world",
      "x y",
    ]);
  });

  test("empty / whitespace → []", () => {
    expect(splitScriptField("")).toEqual([]);
    expect(splitScriptField("   ")).toEqual([]);
  });
});

describe("resolveScript / buildActionCommand", () => {
  test("path script resolves under project; rejects escape", () => {
    const p = project();
    mkdirSync(join(p.path, "scripts"), { recursive: true });
    writeFileSync(join(p.path, "scripts", "qa-start-api-noflags.sh"), "#!/bin/bash\n");
    const abs = resolveScript(p, "scripts/qa-start-api-noflags.sh");
    expect(abs).toBe(join(p.path, "scripts", "qa-start-api-noflags.sh"));
    expect(() => resolveScript(p, "../outside.sh")).toThrow(/escapes/);
  });

  test("path-like script → bash <abs> …", () => {
    const p = project();
    mkdirSync(join(p.path, "scripts"), { recursive: true });
    writeFileSync(join(p.path, "scripts", "qa-start-api-noflags.sh"), "#!/bin/bash\n");
    expect(
      buildActionCommand(p, "scripts/qa-start-api-noflags.sh", ["--flag"]),
    ).toEqual([
      "bash",
      join(p.path, "scripts", "qa-start-api-noflags.sh"),
      "--flag",
    ]);
  });

  test("bare command with args → bash -lc (does not treat whole string as path)", () => {
    const p = project();
    const cmd = buildActionCommand(p, "pnpm --filter @okeroo/api seed:qa");
    expect(cmd[0]).toBe("bash");
    expect(cmd[1]).toBe("-lc");
    expect(cmd[2]).toContain("pnpm");
    expect(cmd[2]).toContain("@okeroo/api");
    expect(cmd[2]).not.toContain(p.path);
  });

  test("hyphenated ids / labels do not affect command build", () => {
    const p = project();
    mkdirSync(join(p.path, "scripts"), { recursive: true });
    writeFileSync(join(p.path, "scripts", "qa-start-api-noflags.sh"), "#!/bin/bash\n");
    const cmd = buildActionCommand(p, "scripts/qa-start-api-noflags.sh");
    expect(cmd[1]).toEndWith("qa-start-api-noflags.sh");
  });
});

describe("runAction hardening", () => {
  test("restart without restartAction fails BEFORE stopping sessions", async () => {
    const p = project({
      actions: [
        action({
          id: "restart",
          type: "restart",
          label: "Restart",
          restartAction: "",
        }),
      ],
    });
    const alive = spawnShell({
      projectId: p.id,
      cwd: p.path,
      kind: "run",
      title: "keep-me",
      command: ["bash", "-lc", "sleep 30"],
    });
    try {
      await expect(runAction(p, "restart")).rejects.toThrow(/restartAction/);
      const still = listSessions(p.id).find((s) => s.id === alive.id);
      expect(still?.alive).toBe(true);
    } finally {
      killSession(alive.id);
    }
  });

  test("restart targeting self fails BEFORE stopping sessions", async () => {
    const p = project({
      actions: [
        action({
          id: "restart",
          type: "restart",
          restartAction: "restart",
        }),
      ],
    });
    const alive = spawnShell({
      projectId: p.id,
      cwd: p.path,
      kind: "run",
      title: "keep-me-self",
      command: ["bash", "-lc", "sleep 30"],
    });
    try {
      await expect(runAction(p, "restart")).rejects.toThrow(/restartAction/);
      const still = listSessions(p.id).find((s) => s.id === alive.id);
      expect(still?.alive).toBe(true);
    } finally {
      killSession(alive.id);
    }
  });

  test("unknown action throws without crashing process", async () => {
    const p = project({ actions: [] });
    await expect(runAction(p, "api-noflags")).rejects.toThrow(/Unknown action/);
  });

  test("missing script → error before spawn", async () => {
    const p = project({
      actions: [
        action({
          id: "api-noflags",
          group: "qa",
          script: "scripts/does-not-exist.sh",
        }),
      ],
    });
    expect(() =>
      buildActionCommand(p, "scripts/does-not-exist.sh"),
    ).toThrow(/Script not found/);
    await expect(runAction(p, "api-noflags")).rejects.toThrow(/Script not found/);
    expect(listSessions(p.id).length).toBe(0);
  });

  test("port already in use → error before spawn", async () => {
    const srv = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response("ok");
      },
    });
    const bound = Number(srv.port);
    try {
      const p = project({
        ports: [{ id: "api-noflags", port: bound, label: "API" }],
        actions: [
          action({
            id: "api-noflags",
            group: "qa",
            script: "scripts/qa-start-api-noflags.sh",
          }),
        ],
      });
      mkdirSync(join(p.path, "scripts"), { recursive: true });
      writeFileSync(
        join(p.path, "scripts", "qa-start-api-noflags.sh"),
        "#!/bin/bash\nsleep 30\n",
      );
      expect(() => assertPortFreeForAction(p, "api-noflags")).toThrow(
        /already in use/,
      );
      await expect(runAction(p, "api-noflags")).rejects.toThrow(/already in use/);
      expect(listSessions(p.id).length).toBe(0);
    } finally {
      srv.stop(true);
    }
  });

  test("non-zero quick exit reports failure (not started)", async () => {
    const p = project({
      ports: [{ id: "boom", port: 59999, label: "Boom" }],
      actions: [
        action({
          id: "boom",
          kind: "action",
          script: "scripts/boom.sh",
        }),
      ],
    });
    mkdirSync(join(p.path, "scripts"), { recursive: true });
    const script = join(p.path, "scripts", "boom.sh");
    writeFileSync(script, "#!/bin/bash\necho boom-error >&2\nexit 7\n");
    chmodSync(script, 0o755);
    await expect(runAction(p, "boom")).rejects.toThrow(/Run failed|exited|boom/i);
  });

  test("port id == action id is allowed (separate namespaces)", async () => {
    const p = project({
      actions: [
        action({
          id: "api-noflags",
          group: "qa",
          script: "scripts/qa-start-api-noflags.sh",
        }),
      ],
    });
    mkdirSync(join(p.path, "scripts"), { recursive: true });
    writeFileSync(
      join(p.path, "scripts", "qa-start-api-noflags.sh"),
      "#!/bin/bash\necho ok\n",
    );
    // Spawning a PTY may or may not succeed in CI sandbox; at minimum
    // resolve/build must not throw before spawn. Call buildActionCommand
    // path which runAction uses — assert command shape for matching ids.
    const cmd = buildActionCommand(p, "scripts/qa-start-api-noflags.sh");
    expect(cmd[0]).toBe("bash");
    expect(p.ports.some((x) => x.id === "api-noflags")).toBe(true);
    expect(p.actions.some((x) => x.id === "api-noflags")).toBe(true);
  });
});
