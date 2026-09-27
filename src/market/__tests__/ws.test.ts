import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wsManager } from "../ws";

/** Deterministic in-test WebSocket twin (node has no native WebSocket). */
class FakeWS {
  static OPEN = 1;
  static instances: FakeWS[] = [];
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) } as MessageEvent);
  }
  Close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  close(): void {
    this.Close();
  }
}

const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;

beforeEach(() => {
  FakeWS.instances = [];
  vi.stubGlobal("WebSocket", FakeWS);
  vi.stubGlobal("window", {
    setTimeout: ((...args: [() => void, number]) => realSetTimeout(...args)) as typeof setTimeout,
    clearTimeout: ((id: unknown) => realClearTimeout(id as never)) as typeof clearTimeout,
  });
});

afterEach(() => {
  wsManager.closeAll();
  vi.unstubAllGlobals();
});

describe("wsManager sharing", () => {
  it("multiplexes many subscribers over ONE connection", async () => {
    const mids: Record<string, number>[] = [];
    const btc: unknown[] = [];
    const eth: unknown[] = [];
    const un1 = wsManager.subscribeAllMids((m) => mids.push(m));
    const un2 = wsManager.subscribeAllMids((m) => mids.push(m));
    const un3 = wsManager.subscribeCandles("BTC", "15m", (c) => btc.push(c));
    const un4 = wsManager.subscribeCandles("ETH", "15m", (c) => eth.push(c));
    expect(FakeWS.instances).toHaveLength(1);
    expect(wsManager.connectionCount).toBe(0);
    FakeWS.instances[0].open();
    await Promise.resolve();
    expect(wsManager.connectionCount).toBe(1);
    // One socket carried both subscription kinds.
    const subs = FakeWS.instances[0].sent.map((s) => JSON.parse(s).subscription.type).sort();
    expect(subs).toEqual(["allMids", "candle", "candle"]);

    FakeWS.instances[0].receive({ channel: "allMids", data: { mids: { BTC: "1", ETH: "2" } } });
    expect(mids).toHaveLength(2); // both listeners, one message

    FakeWS.instances[0].receive({
      channel: "candle",
      data: [{ t: 1, T: 2, s: "ETH", i: "15m", o: 1, c: 2, h: 3, l: 0.5, v: 10, n: 1 }],
    });
    expect(btc).toHaveLength(0); // routed away from BTC
    expect(eth).toHaveLength(1); // routed to ETH only

    un1();
    un2();
    un3();
    un4();
    expect(wsManager.connectionCount).toBe(0);
    expect(wsManager.connectionState).toBe("idle");
  });

  it("page navigation cleans up: last unsubscribe closes the socket", async () => {
    const un1 = wsManager.subscribeAllMids(() => undefined);
    FakeWS.instances[0].open();
    await Promise.resolve();
    expect(wsManager.connectionCount).toBe(1);
    un1(); // simulate leaving the last page that needed data
    expect(wsManager.connectionCount).toBe(0);
    expect(wsManager.connectionState).toBe("idle");
  });

  it("unexpected close schedules a reconnect instead of dying", async () => {
    const un = wsManager.subscribeAllMids(() => undefined);
    FakeWS.instances[0].open();
    await Promise.resolve();
    FakeWS.instances[0].Close(); // server-side drop
    expect(wsManager.connectionState).toBe("connecting");
    un();
    wsManager.closeAll();
  });
});
