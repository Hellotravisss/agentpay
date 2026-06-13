import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlStore, SqliteStore, openStore, type RecordStore } from "../src/store/store.js";
import { SpendLedger } from "../src/ledger/ledger.js";
import type { PaymentReceipt } from "../src/types.js";

interface Row {
  id: string;
  n: number;
}

const created: string[] = [];
function tmp(ext: string): string {
  const p = join(tmpdir(), `agentpay-test-${created.length}-${process.pid}.${ext}`);
  created.push(p);
  return p;
}

afterEach(() => {
  for (const p of created.splice(0)) rmSync(p, { force: true });
});

function roundtrips(make: () => RecordStore<Row>): void {
  const a = make();
  a.append({ id: "x", n: 1 });
  a.append({ id: "y", n: 2 });
  expect(a.all()).toEqual([{ id: "x", n: 1 }, { id: "y", n: 2 }]);
  // A fresh store over the same backing replays what was appended.
  const b = make();
  expect(b.all()).toEqual([{ id: "x", n: 1 }, { id: "y", n: 2 }]);
}

describe("RecordStore backends", () => {
  it("JsonlStore appends and replays in order", () => {
    const path = tmp("jsonl");
    roundtrips(() => new JsonlStore<Row>(path));
  });

  it("JsonlStore.all() is empty for a missing file", () => {
    expect(new JsonlStore<Row>(tmp("jsonl")).all()).toEqual([]);
  });

  it("SqliteStore appends and replays in order", () => {
    const path = tmp("sqlite");
    roundtrips(() => new SqliteStore<Row>(path, "rows"));
  });

  it("SqliteStore rejects an unsafe table name", () => {
    expect(() => new SqliteStore<Row>(tmp("sqlite"), "rows; drop table")).toThrow(/Invalid SQLite table/);
  });

  it("openStore selects SQLite for .sqlite and JSONL otherwise", () => {
    expect(openStore(tmp("sqlite"), "t")).toBeInstanceOf(SqliteStore);
    expect(openStore(tmp("log"), "t")).toBeInstanceOf(JsonlStore);
  });

  it("SpendLedger replays its store so budgets survive a restart", () => {
    const path = tmp("sqlite");
    const receipt: PaymentReceipt = {
      id: "r1", rail: "mock", agentId: "bot", amount: "0.36", currency: "CNY",
      payTo: "m", resource: "http://x", timestamp: 1000, proof: "mock:1",
      baseAmount: "0.0504", baseCurrency: "USD",
    };
    new SpendLedger(openStore<PaymentReceipt>(path, "receipts")).record(receipt);

    const reopened = new SpendLedger(openStore<PaymentReceipt>(path, "receipts"));
    expect(reopened.spentSince("bot", "USD", 0, 2000)).toBe(50400n); // 0.0504 USD in micro-units
  });
});
