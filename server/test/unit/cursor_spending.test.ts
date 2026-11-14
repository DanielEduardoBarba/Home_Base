import { describe, expect, test } from "bun:test";
import { mapCursorSpending } from "../../src/cursor_spending";

describe("mapCursorSpending", () => {
  test("matches the Spending page included / model split", () => {
    const now = Date.parse("2026-11-14T23:00:00.000Z");
    const mapped = mapCursorSpending({
      now,
      period: {
        billingCycleEnd: "1796940136000",
        planUsage: {
          totalSpend: 15586,
          limit: 40000,
          remaining: 24414,
          autoPercentUsed: 4.2716666666666665,
          apiPercentUsed: 11.084,
          totalPercentUsed: 4.795692307692308,
        },
        displayMessage: "You've used 39% of your included usage",
        autoModelSelectedDisplayMessage: "You've used 5% of your included total usage",
        namedModelSelectedDisplayMessage: "You've used 11% of your included API usage",
      },
      plan: {
        planInfo: {
          planName: "Ultra",
          price: "$200/mo",
          includedUsagePeriod: "INCLUDED_USAGE_PERIOD_MONTHLY",
          renewsAt: "1796940136000",
        },
      },
      summary: {
        individualUsage: {
          onDemand: { enabled: false, used: 0, limit: null },
        },
      },
      email: "person@example.com",
    });

    expect(mapped.ok).toBe(true);
    expect(mapped.planName).toBe("Ultra");
    expect(mapped.price).toBe("$200/mo");
    expect(mapped.cycleKind).toBe("monthly");
    expect(mapped.included.percent).toBe(39);
    expect(mapped.included.detail).toBe("$155.86 / $400.00");
    expect(mapped.cursorModels.percent).toBe(5);
    expect(mapped.otherModels.percent).toBe(11);
    expect(mapped.onDemandEnabled).toBe(false);
    expect(mapped.onDemandUsedCents).toBe(0);
    expect(mapped.daysRemaining).toBeGreaterThan(20);
  });
});
