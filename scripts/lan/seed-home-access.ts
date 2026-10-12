#!/usr/bin/env bun
/**
 * Seed Home Access gauges for LAN devices in scripts/lan/devices.json.
 * Run after deploy (as the homebased runtime user / root):
 *
 *   HOMEBASE_HOME=/var/lib/homebased bun scripts/lan/seed-home-access.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { upsertAccessWidget } from "../../server/src/home_access";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const probe = join(here, "probe.sh");
const probeAll = join(here, "probe-all.sh");
const devices = JSON.parse(readFileSync(join(here, "devices.json"), "utf8")) as {
  devices: Array<{ id: string; label: string; group?: string; kind?: string }>;
};

let order = 0;
for (const d of devices.devices) {
  const id = `lan-${d.id}`;
  upsertAccessWidget({
    id,
    kind: "gauge",
    label: d.label,
    description: `${d.kind || "host"} presence`,
    group: d.group || "Network",
    order: order++,
    min: 0,
    max: 1,
    unit: "",
    hook: {
      type: "script",
      command: `${JSON.stringify(probe)} ${JSON.stringify(d.id)}`,
      cwd: repoRoot,
      timeoutMs: 12_000,
      valuePath: "up",
      detailPath: "detail",
      pollMs: 15_000,
    },
  });
  console.log("seeded", id);

  if (d.id === "myq") {
    upsertAccessWidget({
      id: "lan-myq-rssi",
      kind: "gauge",
      label: "MyQ RSSI",
      description: "LiftMaster Wi‑Fi signal",
      group: "IoT",
      order: order++,
      min: -100,
      max: 0,
      unit: "dBm",
      hook: {
        type: "script",
        command: `${JSON.stringify(probe)} myq`,
        cwd: repoRoot,
        timeoutMs: 12_000,
        valuePath: "rssi",
        detailPath: "detail",
        pollMs: 30_000,
      },
    });
    console.log("seeded lan-myq-rssi");
  }
}

upsertAccessWidget({
  id: "lan-refresh",
  kind: "button",
  label: "Refresh LAN probes",
  description: "Ping all known devices once",
  group: "Meta",
  order: order++,
  hook: {
    type: "script",
    command: JSON.stringify(probeAll),
    cwd: repoRoot,
    timeoutMs: 60_000,
  },
});
console.log("seeded lan-refresh");
console.log("done", { count: order });
