// The plugin lives on its own sidebar page, not on the new-thread homepage.
import { describe, expect, it, vi } from "vitest";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: (setup: unknown) => setup,
  useRealtime: () => {},
  useRpc: () => ({}),
}));

const setup = (await import("./app")).default as unknown as (app: unknown) => void;

function capture() {
  const slots: Record<string, unknown[]> = {};
  const app = {
    slots: new Proxy(
      {},
      {
        get: (_target, name: string) => (registration: unknown) => {
          (slots[name] ??= []).push(registration);
        },
      },
    ),
  };
  setup(app);
  return slots;
}

describe("app registration", () => {
  it("adds a Vaam releases sidebar page and no homepage sections", () => {
    const slots = capture();
    expect(Object.keys(slots)).toEqual(["navPanel"]);
    expect(slots.navPanel).toHaveLength(1);
    expect(slots.navPanel[0]).toMatchObject({
      id: "releases",
      title: "Vaam releases",
      path: "releases",
    });
  });
});
