import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  unityMcpProjectHash,
  writeUnityMcpBridgePort,
} from "../../src/unity_mcp_port";

describe("unity_mcp_port", () => {
  test("hash matches PortManager short SHA1 of Assets path", () => {
    const assets = "/tmp/proj/Assets";
    expect(unityMcpProjectHash(assets)).toMatch(/^[a-f0-9]{8}$/);
    expect(unityMcpProjectHash(assets)).toBe(unityMcpProjectHash(assets));
  });

  test("writeUnityMcpBridgePort writes hashed + legacy PortManager JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "hb-mcp-port-"));
    const prevStatus = process.env.UNITY_MCP_STATUS_DIR;
    const statusDir = join(root, ".unity-mcp");
    process.env.UNITY_MCP_STATUS_DIR = statusDir;
    try {
      const proj = join(root, "game");
      mkdirSync(join(proj, "Assets"), { recursive: true });
      mkdirSync(join(proj, "ProjectSettings"), { recursive: true });
      const r = writeUnityMcpBridgePort(proj, 6407);
      expect(r.ok).toBe(true);
      const assets = join(proj, "Assets");
      const hash = unityMcpProjectHash(assets);
      const hashed = join(statusDir, `unity-mcp-port-${hash}.json`);
      const legacy = join(statusDir, "unity-mcp-port.json");
      expect(existsSync(hashed)).toBe(true);
      expect(existsSync(legacy)).toBe(true);
      const body = JSON.parse(readFileSync(hashed, "utf8")) as {
        unity_port: number;
        project_path: string;
      };
      expect(body.unity_port).toBe(6407);
      expect(body.project_path).toBe(assets);
      const local = join(proj, "ProjectSettings", "HomeBaseMcpBridge.json");
      expect(existsSync(local)).toBe(true);
      expect(JSON.parse(readFileSync(local, "utf8")).unity_port).toBe(6407);
    } finally {
      if (prevStatus === undefined) delete process.env.UNITY_MCP_STATUS_DIR;
      else process.env.UNITY_MCP_STATUS_DIR = prevStatus;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
