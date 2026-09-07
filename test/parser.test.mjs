import test from "node:test";
import assert from "node:assert/strict";
import { analyseRows, detectStatus } from "../monitor.mjs";

test("detects explicit PeopleSoft open icon", () => {
  assert.equal(detectStatus("GEA2000 L09", "PS_CS_STATUS_OPEN_ICN alt=Open").status, "open");
});

test("zero available seats is closed", () => {
  const result = detectStatus("T23 Available Seats: 0 Status Open");
  assert.equal(result.status, "closed");
  assert.equal(result.seats, 0);
});

test("all mode requires both sections open", () => {
  const rows = [
    { text: "GEA2000 L09", signals: "PS_CS_STATUS_OPEN_ICN Open" },
    { text: "GEA2000 T23", signals: "PS_CS_STATUS_CLOSED_ICN Closed" }
  ];
  const result = analyseRows(rows, "GEA", ["L09", "T23"], "all", "GEA2000 L09 T23");
  assert.equal(result.status, "closed");
});

test("all mode opens when both sections have seats", () => {
  const rows = [
    { text: "GEA2000 L09 Available Seats: 3", signals: "" },
    { text: "GEA2000 T23 Available Seats: 1", signals: "" }
  ];
  const result = analyseRows(rows, "GEA", ["L09", "T23"], "all", "GEA2000 L09 T23");
  assert.equal(result.status, "open");
});
