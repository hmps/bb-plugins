import { describe, expect, it } from "vitest";
import { currentThreadId, newThreadPath, threadPath } from "./navigate";

describe("routes", () => {
  it("routes a thread through its project", () => {
    expect(threadPath("th_1", "proj_1")).toBe("/projects/proj_1/threads/th_1");
  });

  it("falls back when a thread has no project", () => {
    expect(threadPath("th_1", null)).toBe("/threads/th_1");
    expect(threadPath("th_1", "")).toBe("/threads/th_1");
  });

  it("routes a new thread to the composer, or to a project", () => {
    expect(newThreadPath(null)).toBe("/");
    expect(newThreadPath("proj_1")).toBe("/projects/proj_1");
  });
});

describe("currentThreadId", () => {
  it("reads the thread id from a thread route", () => {
    expect(currentThreadId("/projects/proj_1/threads/th_1")).toBe("th_1");
    expect(currentThreadId("/threads/th_2")).toBe("th_2");
  });

  it("returns null elsewhere", () => {
    expect(currentThreadId("/")).toBeNull();
    expect(currentThreadId("/projects/proj_1")).toBeNull();
  });
});
