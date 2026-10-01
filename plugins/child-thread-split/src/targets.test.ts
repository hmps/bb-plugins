// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { threadIdFromHref } from "./targets";

describe("threadIdFromHref", () => {
  it("reads the thread id from a bb thread route", () => {
    expect(threadIdFromHref("/projects/prj_1/threads/thr_abc")).toBe("thr_abc");
    expect(threadIdFromHref("/projects/prj_1/threads/thr_abc?panel=diff#end")).toBe("thr_abc");
    expect(threadIdFromHref("/projects/prj_1/threads/thr%20x")).toBe("thr x");
  });

  it("rejects links that are not thread routes", () => {
    expect(threadIdFromHref("/projects/prj_1")).toBeNull();
    expect(threadIdFromHref("/projects/prj_1/threads/%E0%A4%A")).toBeNull();
  });
});
