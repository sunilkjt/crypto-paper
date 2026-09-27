import { describe, expect, it } from "vitest";
import { lastRsi, rsiSeries } from "../../indicators/rsi";
import { lastMacd, macdSeries } from "../../indicators/macd";
import { classifyMomentum } from "../momentum";
import { rally, selloff, vRecovery } from "./helpers";

function momentumOf(closes: number[]) {
  const rsi = rsiSeries(closes, 14);
  const m = macdSeries(closes);
  const hist = m.map((p) => p.histogram);
  const last = m[m.length - 1];
  return classifyMomentum({
    rsiNow: rsi[rsi.length - 1],
    rsiThen: rsi[rsi.length - 6],
    crossedUp30: false,
    crossedDown70: false,
    histNow: hist[hist.length - 1],
    histRising: (hist[hist.length - 1] as number) > (hist[hist.length - 2] as number),
    histFalling: (hist[hist.length - 1] as number) < (hist[hist.length - 2] as number),
    aboveSignal:
      last.line !== null && last.signal !== null ? last.line > last.signal : null,
  });
}

describe("momentum", () => {
  it("is positive in a rally, negative in a selloff", () => {
    const bull = momentumOf(rally());
    const bear = momentumOf(selloff());
    expect(["POSITIVE", "STRONG POSITIVE"]).toContain(bull?.label);
    expect(["NEGATIVE", "STRONG NEGATIVE"]).toContain(bear?.label);
    expect((bull?.longScore as number)).toBeGreaterThan(bull?.shortScore as number);
    expect((bear?.shortScore as number)).toBeGreaterThan(bear?.longScore as number);
  });

  it("flags oversold recovery without calling deep-oversold LONG blindly", () => {
    const closes = vRecovery();
    const r = rsiSeries(closes, 14);
    const troughIdx = 40;
    // Still weak at the trough: RSI low and not yet recovering.
    const early = classifyMomentum({
      rsiNow: r[troughIdx],
      rsiThen: r[troughIdx - 5],
      crossedUp30: false,
      crossedDown70: false,
      histNow: -1,
      histRising: false,
      histFalling: true,
      aboveSignal: false,
    });
    expect(early?.recovering).toBe(false);
    expect((early?.shortScore as number)).toBeGreaterThan(early?.longScore as number);

    // After the turn (early bounce phase): rising RSI + improving histogram.
    const bounceCloses = closes.slice(0, 40 + 12);
    const late = momentumOf(bounceCloses);
    expect(late?.recovering).toBe(true);
    expect((late?.longScore as number)).toBeGreaterThan(0.4);
  });

  it("never scores direction from RSI level alone", () => {
    // RSI 25 but still falling with negative histogram → short wins.
    const res = classifyMomentum({
      rsiNow: 25,
      rsiThen: 35,
      crossedUp30: false,
      crossedDown70: false,
      histNow: -0.5,
      histRising: false,
      histFalling: true,
      aboveSignal: false,
    });
    expect(res?.recovering).toBe(false);
    expect((res?.shortScore as number)).toBeGreaterThan(res?.longScore as number);
    // RSI 75 but still rising with positive histogram → long wins.
    const res2 = classifyMomentum({
      rsiNow: 75,
      rsiThen: 65,
      crossedUp30: false,
      crossedDown70: false,
      histNow: 0.5,
      histRising: true,
      histFalling: false,
      aboveSignal: true,
    });
    expect(res2?.fading).toBe(false);
    expect((res2?.longScore as number)).toBeGreaterThan(res2?.shortScore as number);
  });

  it("returns null on missing inputs", () => {
    expect(
      classifyMomentum({
        rsiNow: null,
        rsiThen: 50,
        crossedUp30: false,
        crossedDown70: false,
        histNow: 0,
        histRising: false,
        histFalling: false,
        aboveSignal: null,
      }),
    ).toBeNull();
  });

  it("sanity: indicator helpers agree on the scenario", () => {
    const rec = vRecovery();
    expect(lastRsi(rec.slice(0, 45), 14) as number).toBeLessThan(35);
    expect((lastMacd(rec).histogram as number) ?? 0).not.toBeNaN();
  });
});
