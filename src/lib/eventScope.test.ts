import { expect, it, vi } from "vitest";
import { createEventScope } from "./eventScope";

it("unsubscribes a listener whose registration resolves after disposal", async () => {
  const scope = createEventScope("test");
  const unlisten = vi.fn();
  const receive = vi.fn();
  let registered!: (unlisten: () => void) => void;
  let deliver!: (payload: string) => void;
  const ready = scope.add<string>((callback) => {
    deliver = callback;
    return new Promise((resolve) => { registered = resolve; });
  }, receive);
  scope.dispose();
  deliver("late");
  registered(unlisten);
  expect(await ready).toBe(false);
  expect(receive).not.toHaveBeenCalled();
  expect(unlisten).toHaveBeenCalledOnce();
});
