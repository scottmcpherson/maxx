import assert from "node:assert/strict";
import test from "node:test";
import { deriveDevInstance } from "./dev_instance.mjs";

test("the primary checkout keeps the familiar development ports and app identities", () => {
  const instance = deriveDevInstance("/repo/maxx", { primary: true, label: "main" });
  assert.equal(instance.rendererPort, 1420);
  assert.equal(instance.metroPort, 8081);
  assert.equal(instance.mobileBundleID, "com.maxx.mobile");
  assert.equal(instance.mobileScheme, "maxx-mobile");
  assert.equal(instance.previewName, "Maxx Preview");
  assert.equal(instance.previewBundleID, "com.maxx.preview");
});

test("linked worktrees receive stable isolated ports and native app identities", () => {
  const first = deriveDevInstance("/repo/worktrees/feature-one", { primary: false, label: "maxx/feature one" });
  const repeated = deriveDevInstance("/repo/worktrees/feature-one", { primary: false, label: "renamed-branch" });
  const second = deriveDevInstance("/repo/worktrees/feature-two", { primary: false, label: "feature-two" });

  assert.equal(first.id, repeated.id);
  assert.equal(first.rendererPort, repeated.rendererPort);
  assert.equal(first.metroPort, repeated.metroPort);
  assert.equal(first.listenPort, repeated.listenPort);
  assert.notEqual(first.rendererPort, second.rendererPort);
  assert.notEqual(first.metroPort, second.metroPort);
  assert.notEqual(first.listenPort, second.listenPort);
  assert.match(first.mobileBundleID, /^com\.maxx\.mobile\.dev\.w[0-9a-f]{8}$/u);
  assert.match(first.mobileScheme, /^maxx-mobile-w[0-9a-f]{8}$/u);
  assert.match(first.previewBundleID, /^com\.maxx\.preview\.w[0-9a-f]{8}$/u);
  assert.equal(first.label, "maxx-feature-one");
});
