import { describe, expect, test } from "bun:test";
import {
  calendarDaysUntil,
  mapCursorSpending,
  onDemandFromHardLimit,
  onDemandWriteBody,
  ON_DEMAND_UNLIMITED,
} from "../../src/cursor_spending";

describe("mapCursorSpending", () => {
  test("matches Spending: pool percents, calendar days, and Grok Bot", () => {
    const now = Date.parse("2026-11-14T16:00:00.000Z");
    const cycleEnd = 1796940136000;
    const grokReset = Date.parse("2026-11-17T22:02:25.269Z");
    const mapped = mapCursorSpending({
      now,
      period: {
        billingCycleEnd: String(cycleEnd),
        planUsage: {
          totalSpend: 16110,
          limit: 40000,
          autoPercentUsed: 4.335666666666667,
          apiPercentUsed: 11.084,
          totalPercentUsed: 40,
        },
        displayMessage: "You've used 40% of your included usage",
        autoModelSelectedDisplayMessage: "You've used 5% of your included total usage",
        namedModelSelectedDisplayMessage: "You've used 11% of your included API usage",
      },
      plan: {
        planInfo: {
          planName: "Ultra",
          price: "$200/mo",
          includedUsagePeriod: "INCLUDED_USAGE_PERIOD_MONTHLY",
          renewsAt: String(cycleEnd),
        },
      },
      summary: {
        individualUsage: {
          onDemand: { enabled: false, used: 0, limit: null },
        },
      },
      sand: {
        usagePercent: 98.682368,
        nextResetTimestampUtc: "2026-11-17T22:02:25.269Z",
        hasNonZeroIncludedLimit: true,
        cursorPlanName: "Ultra",
      },
      hard: { noUsageBasedAllowed: true },
    });

    expect(mapped.ok).toBe(true);
    expect(mapped.planName).toBe("Ultra");
    expect(mapped.price).toBe("$200/mo");
    expect(mapped.daysRemaining).toBe(calendarDaysUntil(cycleEnd, now));
    expect(mapped.daysRemaining).toBe(26);
    expect(mapped.cursorModels.percent).toBe(4);
    expect(mapped.otherModels.percent).toBe(11);
    expect(mapped.grokBot?.percent).toBe(99);
    expect(mapped.grokBot?.includedLabel).toBe("Included in Ultra");
    expect(mapped.grokBot?.daysRemaining).toBe(calendarDaysUntil(grokReset, now));
    expect(mapped.grokBot?.daysRemaining).toBe(3);
    expect(mapped.onDemandMode).toBe("disabled");
    expect(mapped.onDemandLimitDollars).toBeNull();
  });

  test("on-demand write matches Cursor's Disabled / Fixed / Unlimited payloads", () => {
    expect(onDemandWriteBody("disabled")).toEqual({
      hardLimit: 0,
      noUsageBasedAllowed: true,
    });
    expect(onDemandWriteBody("fixed", 50)).toEqual({
      hardLimit: 50,
      noUsageBasedAllowed: false,
    });
    expect(onDemandWriteBody("unlimited")).toEqual({
      hardLimit: ON_DEMAND_UNLIMITED,
      noUsageBasedAllowed: false,
    });
    expect(onDemandFromHardLimit({ noUsageBasedAllowed: true })).toEqual({
      mode: "disabled",
      dollars: null,
    });
    expect(onDemandFromHardLimit({ hardLimit: 50, noUsageBasedAllowed: false })).toEqual({
      mode: "fixed",
      dollars: 50,
    });
    expect(onDemandFromHardLimit({ hardLimit: ON_DEMAND_UNLIMITED })).toEqual({
      mode: "unlimited",
      dollars: null,
    });
  });
});
