import { describe, expect, test } from "vitest";

import { dequeueNext, removeByRequestId } from "./queueUtils";

describe("queueUtils", () => {
  test("dequeueNext returns first entry", () => {
    const queue = [1, 2, 3];

    const next = dequeueNext(queue);

    expect(next).toBe(1);
    expect(queue).toEqual([2, 3]);
  });

  test("removeByRequestId removes matching entry", () => {
    const queue = [
      { requestId: "a", value: 1 },
      { requestId: "b", value: 2 },
      { requestId: "c", value: 3 },
    ];

    const removed = removeByRequestId(queue, "b");

    expect(removed).toEqual({ requestId: "b", value: 2 });
    expect(queue).toEqual([
      { requestId: "a", value: 1 },
      { requestId: "c", value: 3 },
    ]);
  });

  test("removeByRequestId returns undefined when missing", () => {
    const queue = [{ requestId: "a", value: 1 }];

    const removed = removeByRequestId(queue, "missing");

    expect(removed).toBeUndefined();
    expect(queue).toEqual([{ requestId: "a", value: 1 }]);
  });
});
