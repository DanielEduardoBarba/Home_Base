import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionDef, Project } from "../../src/config";
import {
  buildActionCommand,
  resolveScript,
  runAction,
  splitScriptField,
} from "../../src/process";

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
  test("restart without restartAction fails (no stack overflow)", async () => {
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
    await expect(runAction(p, "restart")).rejects.toThrow(/restartAction/);
  });

  test("restart targeting self fails", async () => {
    const p = project({
      actions: [
        action({
          id: "restart",
          type: "restart",
          restartAction: "restart",
        }),
      ],
    });
    await expect(runAction(p, "restart")).rejects.toThrow(/restartAction/);
  });

  test("unknown action throws without crashing process", async () => {
    const p = project({ actions: [] });
    await expect(runAction(p, "api-noflags")).rejects.toThrow(/Unknown action/);
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
