import type { ParseKeys } from "i18next";
import type { MeetingSummary } from "../lib/types";
import { useT } from "../i18n";
import { getDateGroup } from "../lib/utils";
import { MeetingCard } from "./MeetingCard";
import { Mic } from "lucide-react";

interface RecentMeetingsProps {
  meetings: MeetingSummary[];
  onSelect: (meetingId: string) => void;
  onDelete: (meetingId: string) => void;
  onRename: (meetingId: string, newTitle: string) => void;
  favorites?: Set<string>;
  onToggleFavorite?: (meetingId: string) => void;
  activeMeetingId?: string | null;
}

/**
 * Heading of each group `getDateGroup()` can return. The English names stay the
 * Map keys and the sort order; only the heading shown is translated.
 */
const DATE_GROUP_KEYS: Record<string, ParseKeys<["launcher", "common"]>> = {
  Today: "common:time.today",
  Yesterday: "common:time.yesterday",
  "This Week": "common:time.thisWeek",
  Earlier: "common:time.earlier",
};

/** Groups meetings by date category: Today, Yesterday, This Week, Earlier */
function groupMeetingsByDate(
  meetings: MeetingSummary[]
): Map<string, MeetingSummary[]> {
  const groups = new Map<string, MeetingSummary[]>();
  const order = ["Today", "Yesterday", "This Week", "Earlier"]; // i18n-ignore: getDateGroup() 返回的分组 id，用作 Map 的 key 和排序，显示时才翻译

  for (const label of order) {
    groups.set(label, []);
  }

  for (const meeting of meetings) {
    const group = getDateGroup(meeting.start_time);
    const list = groups.get(group);
    if (list) {
      list.push(meeting);
    } else {
      groups.set(group, [meeting]);
    }
  }

  for (const [key, value] of groups) {
    if (value.length === 0) {
      groups.delete(key);
    }
  }

  return groups;
}

export function RecentMeetings({
  meetings,
  onSelect,
  onDelete,
  onRename,
  favorites,
  onToggleFavorite,
  activeMeetingId,
}: RecentMeetingsProps) {
  const { t } = useT(["launcher", "common"]);

  if (meetings.length === 0) {
    return (
      <div className="dash-main flex flex-col items-center justify-center rounded-2xl border border-border/20 bg-secondary/10 py-14">
        <div className="mb-3 rounded-full bg-primary/10 p-3.5">
          <Mic className="h-4.5 w-4.5 text-primary/30" />
        </div>
        <p className="text-xs font-medium text-muted-foreground/50">
          {t("recent.empty.title")}
        </p>
        <p className="mt-1 text-meta text-muted-foreground/60">
          {t("recent.empty.hint")}
        </p>
      </div>
    );
  }

  const grouped = groupMeetingsByDate(meetings);

  // Running counter for staggered card entrance across all groups
  let cardIndex = 0;

  return (
    <div className="space-y-4">
      {Array.from(grouped.entries()).map(([dateGroup, groupMeetings]) => (
        <div key={dateGroup}>
          <h3 className="mb-2 text-meta font-semibold uppercase tracking-wider text-muted-foreground/60">
            {DATE_GROUP_KEYS[dateGroup] ? t(DATE_GROUP_KEYS[dateGroup]) : dateGroup}
          </h3>
          <div className="space-y-1.5">
            {groupMeetings.map((meeting) => {
              const idx = cardIndex++;
              return (
                <MeetingCard
                  key={meeting.id}
                  meeting={meeting}
                  onSelect={onSelect}
                  onDelete={onDelete}
                  onRename={onRename}
                  isFavorite={favorites?.has(meeting.id) ?? false}
                  onToggleFavorite={onToggleFavorite}
                  isLive={meeting.id === activeMeetingId}
                  staggerIndex={idx}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
