import type { AIInteraction } from "../../lib/types";
import type { ChatItem } from "../../hooks/useMeetingChat";
import { useT } from "../../i18n";
import { formatRelativeTime, getModeLabel } from "../../lib/utils";
import { MessageSquare, ChevronDown, ChevronUp } from "lucide-react";

interface AIInteractionLogProps {
  interactions: AIInteraction[];
  /** Answered "Ask this meeting" questions, oldest first. */
  chat?: { question: ChatItem; answer: ChatItem }[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}

export function AIInteractionLog({ interactions, chat = [], expandedId, onToggle }: AIInteractionLogProps) {
  const { t } = useT("launcher");
  if (interactions.length === 0 && chat.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <MessageSquare className="mb-3 h-8 w-8 text-primary/20" />
        <p className="text-sm font-medium text-muted-foreground/40">{t("aiLog.empty")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 p-4">
      {interactions.map((interaction) => (
        <LogRow
          key={interaction.id}
          id={interaction.id}
          label={getModeLabel(interaction.mode)}
          title={interaction.question_context}
          aside={t("aiLog.latency", { ms: interaction.latency_ms })}
          meta={`${interaction.provider}/${interaction.model}`}
          time={formatRelativeTime(interaction.timestamp)}
          body={interaction.response}
          expanded={expandedId === interaction.id}
          onToggle={onToggle}
        />
      ))}
      {chat.length > 0 && (
        <>
          <h3 className="px-1 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50 first:pt-0">
            {t("aiLog.askMeeting")}
          </h3>
          {chat.map(({ question, answer }) => (
            <LogRow
              key={answer.id}
              id={answer.id}
              label={getModeLabel("MeetingAsk")}
              title={question.content}
              meta={answer.model ?? undefined}
              time={formatRelativeTime(new Date(question.createdAt).toISOString())}
              body={answer.content}
              expanded={expandedId === answer.id}
              onToggle={onToggle}
            />
          ))}
        </>
      )}
    </div>
  );
}

function LogRow({
  id,
  label,
  title,
  aside,
  meta,
  time,
  body,
  expanded,
  onToggle,
}: {
  id: string;
  label: string;
  title: string;
  aside?: string;
  meta?: string;
  time: string;
  body: string;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="rounded-xl border border-border/20 bg-card/30 border-l-2 border-l-primary/20">
      <button
        onClick={() => onToggle(id)}
        className="flex w-full items-center justify-between px-4 py-3 text-left cursor-pointer"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2.5">
          <span className="rounded-lg bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{label}</span>
          <span className="truncate max-w-[250px] text-sm text-foreground/60">{title}</span>
        </div>
        <div className="flex items-center gap-2.5">
          {aside && <span className="text-xs tabular-nums text-muted-foreground/50">{aside}</span>}
          {expanded
            ? <ChevronUp className="h-4 w-4 text-muted-foreground/40" />
            : <ChevronDown className="h-4 w-4 text-muted-foreground/40" />}
        </div>
      </button>
      {expanded && (
        <div className="border-t border-border/20 px-4 py-3">
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground/50">
            {meta && (
              <>
                <span>{meta}</span>
                <span>&middot;</span>
              </>
            )}
            <span>{time}</span>
          </div>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/80">{body}</p>
        </div>
      )}
    </div>
  );
}
