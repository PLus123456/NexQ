import { describe, expect, it } from "vitest";
import { meetingShortcutAction, switchShortcutTarget } from "./windows";

describe("meetingShortcutAction", () => {
  it("ends a running meeting, even while a quit is pending", () => {
    expect(meetingShortcutAction(true, false)).toBe("end");
    expect(meetingShortcutAction(true, true)).toBe("end");
  });

  it("starts a meeting when none is running", () => {
    expect(meetingShortcutAction(false, false)).toBe("start");
  });

  it("never starts a meeting while a deferred quit is pending", () => {
    expect(meetingShortcutAction(false, true)).toBe("ignore");
  });
});

describe("switchShortcutTarget (Ctrl+B)", () => {
  it("goes from the overlay to the dashboard", () => {
    expect(switchShortcutTarget(true, true)).toBe("launcher");
  });

  it("brings the meeting overlay back during a meeting", () => {
    expect(switchShortcutTarget(false, true)).toBe("overlay");
  });

  it("opens the dashboard when no meeting is running, so NexQ is never out of reach", () => {
    expect(switchShortcutTarget(false, false)).toBe("launcher");
  });
});
