import type { Meeting } from "../../lib/types";
import { useT } from "../../i18n";
import { FileText, Sparkles, MessageSquare, MessageCircleQuestion, Users, ListTodo, Bookmark, Loader2 } from "lucide-react";
import { ExportDropdown } from "./ExportDropdown";

export type MeetingTab = "transcript" | "summary" | "ask" | "ai" | "speakers" | "actions" | "bookmarks";

interface MeetingTabBarProps {
  activeTab: MeetingTab;
  setActiveTab: (tab: MeetingTab) => void;
  meeting: Meeting;
  onGenerateSummary?: () => void;
  onSuggestBookmarks?: () => void;
  onExtractActions?: () => void;
  isSummaryGenerating?: boolean;
  isBookmarksSuggesting?: boolean;
  isActionsExtracting?: boolean;
  /** Show the "Ask" tab (finished meetings only). */
  showAsk?: boolean;
  /** AI Log entries: AI interactions plus answered Ask questions. */
  aiLogCount?: number;
}

export function MeetingTabBar({ activeTab, setActiveTab, meeting, onGenerateSummary, onSuggestBookmarks, onExtractActions, isSummaryGenerating, isBookmarksSuggesting, isActionsExtracting, showAsk, aiLogCount }: MeetingTabBarProps) {
  const { t } = useT("launcher");
  const actionCount = meeting.action_items?.length ?? 0;
  const bookmarkCount = meeting.bookmarks?.length ?? 0;
  // Named remote speaker tags are labels for "Them" lines, not tab entries.
  const speakerCount = meeting.speakers?.filter((s) => s.source !== "remote_tag").length ?? 0;

  return (
    <div className="relative flex items-center border-b border-border/20 px-3 py-1.5" role="tablist">
      <div className="flex items-center gap-1 overflow-x-auto">
        <TabButton
          active={activeTab === "transcript"}
          onClick={() => setActiveTab("transcript")}
          icon={<FileText className="h-3.5 w-3.5" />}
          label={t("tabs.transcript")}
          count={meeting.transcript.length}
        />
        <TabButton
          active={activeTab === "summary"}
          onClick={() => setActiveTab("summary")}
          icon={<Sparkles className="h-3.5 w-3.5" />}
          label={t("tabs.summary")}
          indicator={!!meeting.summary}
        />
        {showAsk && (
          <TabButton
            active={activeTab === "ask"}
            onClick={() => setActiveTab("ask")}
            icon={<MessageCircleQuestion className="h-3.5 w-3.5" />}
            label={t("tabs.ask")}
          />
        )}
        <TabButton
          active={activeTab === "ai"}
          onClick={() => setActiveTab("ai")}
          icon={<MessageSquare className="h-3.5 w-3.5" />}
          label={t("tabs.aiLog")}
          count={aiLogCount ?? meeting.ai_interactions.length}
        />
        <TabButton
          active={activeTab === "speakers"}
          onClick={() => setActiveTab("speakers")}
          icon={<Users className="h-3.5 w-3.5" />}
          label={t("tabs.speakers")}
          count={speakerCount > 0 ? speakerCount : undefined}
        />
        <TabButton
          active={activeTab === "actions"}
          onClick={() => setActiveTab("actions")}
          icon={<ListTodo className="h-3.5 w-3.5" />}
          label={t("tabs.actions")}
          count={actionCount > 0 ? actionCount : undefined}
        />
        <TabButton
          active={activeTab === "bookmarks"}
          onClick={() => setActiveTab("bookmarks")}
          icon={<Bookmark className="h-3.5 w-3.5" />}
          label={t("tabs.bookmarks")}
          count={bookmarkCount > 0 ? bookmarkCount : undefined}
        />
      </div>

      {/* Spacer + AI Actions + Export — OUTSIDE the overflow container */}
      <div className="ml-auto flex items-center gap-1 pl-2">
        {/* AI Actions */}
        {onGenerateSummary && (
          <button
            onClick={onGenerateSummary}
            disabled={isSummaryGenerating || meeting.transcript.length === 0}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-primary/70 hover:bg-primary/10 hover:text-primary transition-colors disabled:opacity-30 cursor-pointer"
            title={meeting.summary ? t("tabs.summaryAction.regenerate.title") : t("tabs.summaryAction.generate.title")}
          >
            {isSummaryGenerating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            {meeting.summary ? t("tabs.summaryAction.regenerate.label") : t("tabs.summaryAction.generate.label")}
          </button>
        )}
        {onExtractActions && (
          <button
            onClick={onExtractActions}
            disabled={isActionsExtracting || meeting.transcript.length === 0}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-primary/70 hover:bg-primary/10 hover:text-primary transition-colors disabled:opacity-30 cursor-pointer"
            title={t("tabs.extractActions.title")}
          >
            {isActionsExtracting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            {t("tabs.extractActions.label")}
          </button>
        )}
        {onSuggestBookmarks && (
          <button
            onClick={onSuggestBookmarks}
            disabled={isBookmarksSuggesting || meeting.transcript.length === 0}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-primary/70 hover:bg-primary/10 hover:text-primary transition-colors disabled:opacity-30 cursor-pointer"
            title={t("tabs.suggestBookmarks.title")}
          >
            {isBookmarksSuggesting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            {t("tabs.suggestBookmarks.label")}
          </button>
        )}
        <div className="mx-1 h-4 w-px bg-border/20" />
        <ExportDropdown meeting={meeting} />
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
  indicator,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
  indicator?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={`relative flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-medium transition-all duration-200 cursor-pointer ${
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground/50 hover:bg-secondary/30 hover:text-muted-foreground"
      }`}
    >
      {/* Active indicator bar */}
      <span className={`absolute bottom-0 left-2 right-2 h-0.5 rounded-full transition-all duration-200 ${
        active ? "bg-primary scale-x-100" : "bg-transparent scale-x-0"
      }`} />
      {icon}
      {label}
      {count !== undefined && count > 0 && (
        <span className={`rounded-md px-1.5 py-0.5 text-xs tabular-nums font-semibold ${
          active ? "bg-primary/10 text-primary/80" : "bg-primary/5 text-muted-foreground/50"
        }`}>
          {count}
        </span>
      )}
      {indicator && (
        <span className="h-2 w-2 rounded-full bg-success" />
      )}
    </button>
  );
}
