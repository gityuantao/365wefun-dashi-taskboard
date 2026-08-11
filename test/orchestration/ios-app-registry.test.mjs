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
    testScheme: "E365AU",
    testTarget: "E365StoreKitTests",
    bundleId: "online.365english.app",
    testFlightGroup: "Internal Testing",
    buildNumberSource: "app-store-connect",
    appStoreAppId: "0000000001",
    releaseMode: "automatic",
    reviewConfigurationRef: "app-store-review/au",
  },
  {
    id: "cn",
    name: "中国版",
    enabled: true,
    scheme: "E365CN",
    testScheme: "E365ChinaComplianceTests",
    testTarget: "E365ChinaComplianceTests",
    bundleId: "online.365english.china",
    testFlightGroup: "Internal Testing",
    buildNumberSource: "app-store-connect",
    appStoreAppId: "0000000002",
    releaseMode: "automatic",
    reviewConfigurationRef: "app-store-review/cn",
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

test("registry rejects duplicate App Store App IDs", () => {
  assertInvalid(
    [{ ...CURRENT_APPS[0] }, { ...CURRENT_APPS[1], appStoreAppId: "0000000001" }],
    "iosApps[1].appStoreAppId",
  );
});

test("registry rejects a missing TestFlight group", () => {
  assertInvalid([{ ...CURRENT_APPS[0], testFlightGroup: "" }], "iosApps[0].testFlightGroup");
});

test("registry requires an explicit automated test scheme and target", () => {
  const { testScheme: _testScheme, ...withoutScheme } = CURRENT_APPS[0];
  assertInvalid([withoutScheme], "iosApps[0].testScheme");

  const { testTarget: _testTarget, ...withoutTarget } = CURRENT_APPS[0];
  assertInvalid([withoutTarget], "iosApps[0].testTarget");
});

test("registry rejects an unsupported build number source", () => {
  assertInvalid(
    [{ ...CURRENT_APPS[0], buildNumberSource: "xcode-project" }],
    "iosApps[0].buildNumberSource",
  );
});

test("registry requires own non-secret production release fields", () => {
  for (const field of ["appStoreAppId", "releaseMode", "reviewConfigurationRef"]) {
    const { [field]: _omitted, ...withoutField } = CURRENT_APPS[0];
    assertInvalid([withoutField], `iosApps[0].${field}`);
  }

  Object.defineProperty(Object.prototype, "appStoreAppId", {
    configurable: true,
    value: "inherited-app-store-id",
  });
  try {
    const { appStoreAppId: _appStoreAppId, ...withoutOwnAppStoreId } = CURRENT_APPS[0];
    assertInvalid([withoutOwnAppStoreId], "iosApps[0].appStoreAppId");
  } finally {
    delete Object.prototype.appStoreAppId;
  }
});

test("registry rejects blank production release field values", () => {
  for (const field of ["appStoreAppId", "reviewConfigurationRef"]) {
    assertInvalid([{ ...CURRENT_APPS[0], [field]: "   " }], `iosApps[0].${field}`);
  }
});

test("registry permits only automatic production App Store release mode", () => {
  assertInvalid([{ ...CURRENT_APPS[0], releaseMode: "manual" }], "iosApps[0].releaseMode");
  assert.deepEqual(loadIosApps([CURRENT_APPS[0]])[0].releaseMode, "automatic");
});

test("registry returns a third enabled app without country-specific branching", () => {
  const apps = loadIosApps([
    ...CURRENT_APPS,
    {
      ...CURRENT_APPS[0],
      id: "jp",
      name: "日本版",
      scheme: "E365JP",
      testScheme: "E365JP",
      bundleId: "online.365english.japan",
      appStoreAppId: "0000000003",
      reviewConfigurationRef: "app-store-review/jp",
    },
  ]);

  assert.deepEqual(enabledIosApps(apps).map((app) => app.id), ["au", "cn", "jp"]);
});

test("registry rejects required fields inherited through the prototype", () => {
  assertInvalid([Object.create(CURRENT_APPS[0])], "iosApps[0]");
});

test("registry rejects entries with a non-plain prototype", () => {
  const app = Object.assign(Object.create({ source: "inherited" }), CURRENT_APPS[0]);

  assertInvalid([app], "iosApps[0]");
});

test("the public runtime example contains the current iOS production App identities", async () => {
  const configPath = fileURLToPath(
    new URL("../../orchestration/runtime.example.json", import.meta.url),
  );
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const apps = loadIosApps(config.iosApps);

  assert.deepEqual(
    apps.map(({ id, scheme, testScheme, testTarget, bundleId, appStoreAppId, releaseMode, reviewConfigurationRef }) => ({
      id,
      scheme,
      testScheme,
      testTarget,
      bundleId,
      appStoreAppId,
      releaseMode,
      reviewConfigurationRef,
    })),
    [
      { id: "au", scheme: "E365AU", testScheme: "E365AU", testTarget: "E365StoreKitTests", bundleId: "online.365english.app", appStoreAppId: "0000000001", releaseMode: "automatic", reviewConfigurationRef: "app-store-review/au" },
      { id: "cn", scheme: "E365CN", testScheme: "E365ChinaComplianceTests", testTarget: "E365ChinaComplianceTests", bundleId: "online.365english.china", appStoreAppId: "0000000002", releaseMode: "automatic", reviewConfigurationRef: "app-store-review/cn" },
    ],
  );
});
