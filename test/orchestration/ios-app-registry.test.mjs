import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { enabledIosApps, loadIosApps } from "../../orchestration/ios/app-registry.mjs";

const CURRENT_APPS = [
  {
    id: "au",
    name: "海外版",
    enabled: true,
    scheme: "E365AU",
    bundleId: "online.365english.app",
    testFlightGroup: "Internal Testing",
    buildNumberSource: "app-store-connect",
  },
  {
    id: "cn",
    name: "中国版",
    enabled: true,
    scheme: "E365CN",
    bundleId: "online.365english.china",
    testFlightGroup: "Internal Testing",
    buildNumberSource: "app-store-connect",
  },
];

function assertInvalid(value, field) {
  assert.throws(
    () => loadIosApps(value),
    (error) => error.code === "INVALID_IOS_APP_CONFIG" && error.details?.field === field,
  );
}

test("registry returns every enabled country app in configuration order", () => {
  const apps = loadIosApps(CURRENT_APPS);

  assert.deepEqual(enabledIosApps(apps).map((app) => app.scheme), ["E365AU", "E365CN"]);
  assert.ok(Object.isFrozen(apps));
  assert.ok(Object.isFrozen(apps[0]));
  assert.ok(Object.isFrozen(enabledIosApps(apps)));
});

test("registry rejects a configuration without an enabled app", () => {
  assertInvalid(CURRENT_APPS.map((app) => ({ ...app, enabled: false })), "iosApps");
});

test("registry rejects duplicate app identifiers", () => {
  assertInvalid([{ ...CURRENT_APPS[0] }, { ...CURRENT_APPS[1], id: "au" }], "iosApps[1].id");
});

test("registry rejects duplicate schemes", () => {
  assertInvalid(
    [{ ...CURRENT_APPS[0] }, { ...CURRENT_APPS[1], scheme: "E365AU" }],
    "iosApps[1].scheme",
  );
});

test("registry rejects duplicate bundle identifiers", () => {
  assertInvalid(
    [{ ...CURRENT_APPS[0] }, { ...CURRENT_APPS[1], bundleId: "online.365english.app" }],
    "iosApps[1].bundleId",
  );
});

test("registry rejects a missing TestFlight group", () => {
  assertInvalid([{ ...CURRENT_APPS[0], testFlightGroup: "" }], "iosApps[0].testFlightGroup");
});

test("registry rejects an unsupported build number source", () => {
  assertInvalid(
    [{ ...CURRENT_APPS[0], buildNumberSource: "xcode-project" }],
    "iosApps[0].buildNumberSource",
  );
});

test("the public runtime example contains the two current iOS app identities", async () => {
  const configPath = fileURLToPath(
    new URL("../../orchestration/clickup/config.example.json", import.meta.url),
  );
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const apps = loadIosApps(config.iosApps);

  assert.deepEqual(
    apps.map(({ id, scheme, bundleId }) => ({ id, scheme, bundleId })),
    [
      { id: "au", scheme: "E365AU", bundleId: "online.365english.app" },
      { id: "cn", scheme: "E365CN", bundleId: "online.365english.china" },
    ],
  );
});
