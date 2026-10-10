const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getDriver,
  listBackends,
} = require("./index.cjs");

test("registry exposes the Pi SDK backend", () => {
  assert.deepEqual(listBackends(), ["pi"]);
});

test("getDriver returns a driver with runTurn", () => {
  for (const key of listBackends()) {
    const d = getDriver(key);
    assert.equal(typeof d.runTurn, "function", `${key} must expose runTurn`);
  }
});

test("getDriver throws on unknown backend", () => {
  assert.throws(() => getDriver("gemini"), /No SDK driver registered for backend: gemini/);
});

test("Pi driver exposes listModels", async () => {
  for (const key of listBackends()) {
    assert.equal(typeof getDriver(key).listModels, "function", `${key} must expose listModels`);
  }
});
