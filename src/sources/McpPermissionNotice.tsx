import { useT } from "../i18n";
import { SourcesModal } from "./SourcesModal";

/** Shown once, the first time a server is added. */
export function McpPermissionNotice({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useT("sources");
  return (
    <SourcesModal title={t("notice.title")} onClose={onDismiss} hideClose>
      <div className="space-y-3 text-xs leading-relaxed text-muted-foreground">
        <p>{t("notice.first")}</p>
        <p>{t("notice.second")}</p>
        <p>{t("notice.third")}</p>
      </div>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onDismiss}
          className="cursor-pointer rounded-lg bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground transition-all duration-150 hover:brightness-110 active:scale-[0.98]"
        >
          {t("notice.dismiss")}
        </button>
      </div>
    </SourcesModal>
  );
}
