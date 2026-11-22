import { useT } from "../i18n";
import { SourcesModal } from "./SourcesModal";

interface SourcesGuideModalProps {
  kind: "notes" | "tools";
  onClose: () => void;
}

const TOPICS = ["can", "cant", "claudeOnly", "slow", "howTo"] as const;

export function SourcesGuideModal({ kind, onClose }: SourcesGuideModalProps) {
  const { t } = useT("sources");
  return (
    <SourcesModal title={kind === "notes" ? t("guide.notesTitle") : t("guide.toolsTitle")} onClose={onClose}>
      <dl className="space-y-3.5">
        {TOPICS.map((topic) => (
          <div key={topic}>
            <dt className="text-xs font-semibold text-foreground">{t(`guide.${kind}.${topic}.title`)}</dt>
            <dd className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t(`guide.${kind}.${topic}.body`)}</dd>
          </div>
        ))}
      </dl>
    </SourcesModal>
  );
}
