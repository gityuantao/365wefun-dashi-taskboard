import assert from "node:assert/strict";
import test from "node:test";

import {
  enabledMiniProgramApps,
  loadMiniProgramApps,
} from "../../orchestration/mini-program/app-registry.mjs";

const APP_ID = "wx1fdac5e27c6b5366";

function app(overrides = {}) {
  return {
    id: "wechat",
    name: "365生活口语微信小程序",
    enabled: true,
    appId: APP_ID,
    sourceDirectory: "apps/mp",
    buildCommand: ["npm", "run", "build:mp-weixin"],
    artifactDirectory: "dist/build/mp-weixin",
    uploadCommand: ["node", "scripts/upload-wechat-mini-program.mjs"],
    reviewCommand: ["node", "scripts/submit-wechat-mini-program-review.mjs"],
    releaseCommand: ["node", "scripts/release-wechat-mini-program.mjs"],
    readbackCommand: ["node", "scripts/readback-wechat-mini-program.mjs"],
    credentialsPath: "private/wechat-mini-program.private.json",
    reviewConfigurationRef: "wechat-mini-program-review/primary",
    ...overrides,
  };
}

test("mini-program registry freezes the current App ID and non-secret execution references", () => {
  const registry = loadMiniProgramApps([app()]);

  assert.equal(registry[0].appId, APP_ID);
  assert.deepEqual(enabledMiniProgramApps(registry), registry);
  assert.ok(Object.isFrozen(registry));
  assert.ok(Object.isFrozen(registry[0]));
  assert.deepEqual(Object.keys(registry[0]), Object.keys(app()));
});

test("mini-program registry requires every field as an own property and rejects blanks", () => {
  for (const field of Object.keys(app())) {
    const inherited = Object.create({ [field]: app()[field] });
    Object.assign(inherited, app());
    delete inherited[field];
    assert.throws(() => loadMiniProgramApps([inherited]), new RegExp(field, "i"));
  }

  for (const field of [
    "id", "name", "appId", "sourceDirectory", "artifactDirectory",
    "credentialsPath", "reviewConfigurationRef",
  ]) {
    assert.throws(() => loadMiniProgramApps([app({ [field]: "  " })]), new RegExp(field, "i"));
  }
  for (const field of ["buildCommand", "uploadCommand", "reviewCommand", "releaseCommand", "readbackCommand"]) {
    assert.throws(() => loadMiniProgramApps([app({ [field]: ["node", " "] })]), new RegExp(field, "i"));
  }
});

test("mini-program registry rejects duplicate identities, unsupported fields, and inline secrets", () => {
  assert.throws(() => loadMiniProgramApps([app(), app({ id: "other" })]), /appId.*unique/i);
  assert.throws(() => loadMiniProgramApps([app(), app({ appId: "wx0000000000000000" })]), /id.*unique/i);
  assert.throws(() => loadMiniProgramApps([app({ enabled: "yes" })]), /enabled.*boolean/i);
  assert.throws(() => loadMiniProgramApps([app({ unexpected: true })]), /unsupported.*unexpected/i);
  assert.throws(() => loadMiniProgramApps([app({ credentialsPath: { secret: "raw" } })]), /credentialsPath/i);
  assert.throws(() => loadMiniProgramApps([app({ reviewConfigurationRef: "token=raw-secret" })]), /reviewConfigurationRef.*reference/i);
  assert.throws(() => loadMiniProgramApps([]), /enabled/i);
});

test("mini-program registry accepts only private-file credential paths and bounded review identifiers", () => {
  const invalidCredentials = [
    "https://example.com/credentials", "token=raw", "Bearer abc.def.ghi",
    "-----BEGIN PRIVATE KEY-----", '{"private_key":"raw"}', "private/key.json#token",
    "private/key.json?token=raw", "private/../key.private.json", "private/key.json\nAuthorization: raw",
    `private/${"a".repeat(300)}.private.json`,
  ];
  const invalidReviewRefs = [
    "https://example.com/review", "abc.def.ghi", "Authorization: Bearer raw", "Cookie: sid=raw",
    "review/ref#fragment", "review/ref?token=raw", "review/ref\u0000tail", "x".repeat(129),
  ];
  for (const credentialsPath of invalidCredentials) {
    assert.throws(
      () => loadMiniProgramApps([app({ credentialsPath })]),
      (error) => error.code === "INVALID_MINI_PROGRAM_APP_CONFIG"
        && !error.message.includes(credentialsPath),
    );
  }
  for (const reviewConfigurationRef of invalidReviewRefs) {
    assert.throws(
      () => loadMiniProgramApps([app({ reviewConfigurationRef })]),
      (error) => error.code === "INVALID_MINI_PROGRAM_APP_CONFIG"
        && !error.message.includes(reviewConfigurationRef),
    );
  }
});
