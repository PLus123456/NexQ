import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bookmark,
  Check,
  Globe,
  Lock,
  Mic,
  MicOff,
  Minus,
  Settings,
  Terminal,
  Unlock,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useT } from "../i18n";
import { languageLabel } from "../lib/languages";
import { MODE_COLORS } from "../lib/speakerColors";
import type { AudioMode } from "../lib/types";
import { clampPopoverPosition, type PopoverRect } from "./popoverUtils";

const MENU_WIDTH = 276;
const MENU_EST_HEIGHT = 400;

export interface OverlayMoreMenuProps {
  open: boolean;
  anchorRef: RefObject<HTMLButtonElement>;
  onClose: (refocus?: boolean) => void;
  audioMode: AudioMode;
  scenarioName: string;
  mutedYou: boolean;
  mutedThem: boolean;
  onToggleMuteYou: () => void;
  onToggleMuteThem: () => void;
  captionsLocked: boolean;
  onToggleCaptionsLock: () => void;
  autoTranslateActive: boolean;
  translationNotReady: string | null;
  displayMode: "inline" | "hover";
  targetLang: string;
  isBatchTranslating: boolean;
  onToggleTranslate: () => void;
  onSetDisplayMode: (mode: "inline" | "hover") => void;
  onTranslateAll: () => void;
  statsOpen: boolean;
  bookmarksOpen: boolean;
  logOpen: boolean;
  devLogOpen: boolean;
  onToggleStats: () => void;
  onToggleBookmarks: () => void;
  onToggleLog: () => void;
  onToggleDevLog: () => void;
  onOpenSettings: () => void;
  minimizeLabel: string;
  onMinimize: () => void;
}

export function OverlayMoreMenu({
  open,
  anchorRef,
  onClose,
  audioMode,
  scenarioName,
  mutedYou,
  mutedThem,
  onToggleMuteYou,
  onToggleMuteThem,
  captionsLocked,
  onToggleCaptionsLock,
  autoTranslateActive,
  translationNotReady,
  displayMode,
  targetLang,
  isBatchTranslating,
  onToggleTranslate,
  onSetDisplayMode,
  onTranslateAll,
  statsOpen,
  bookmarksOpen,
  logOpen,
  devLogOpen,
  onToggleStats,
  onToggleBookmarks,
  onToggleLog,
  onToggleDevLog,
  onOpenSettings,
  minimizeLabel,
  onMinimize,
}: OverlayMoreMenuProps) {
  const { t } = useT(["translation", "overlay"]);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<PopoverRect>({ top: 36, left: 8, maxHeight: 420 });

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    setPos(clampPopoverPosition(rect, MENU_WIDTH, MENU_EST_HEIGHT, "below", "right"));
  }, [open, anchorRef, autoTranslateActive]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose(true);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, anchorRef, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("overlay:header.more.menuLabel")}
      onKeyDown={(e) => e.stopPropagation()}
      style={{
        top: pos.top,
        left: pos.left,
        width: Math.min(MENU_WIDTH, Math.max(220, window.innerWidth - 16)),
        maxHeight: pos.maxHeight,
      }}
      className="scope-pop-enter fixed z-50 flex flex-col overflow-y-auto rounded-xl border border-border/30 bg-popover/95 p-1.5 shadow-2xl backdrop-blur-md"
    >
      {/* Top: meeting audio mode + active scenario */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border/15">
        <span
          className="shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wider"
          style={{ color: MODE_COLORS[audioMode].text, backgroundColor: MODE_COLORS[audioMode].bg }}
        >
          {audioMode === "online" ? t("overlay.mode.online") : t("overlay.mode.inPerson")}
        </span>
        <span className="min-w-0 truncate rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-muted-foreground" title={scenarioName}>
          {scenarioName}
        </span>
      </div>

      {/* Section: Audio & Captions */}
      <div className="py-1 border-b border-border/15">
        <SectionLabel text={t("overlay:header.more.sections.audio")} />
        <div className="grid grid-cols-2 gap-1 px-1 mb-1">
          <button
            type="button"
            onClick={onToggleMuteYou}
            aria-pressed={mutedYou}
            aria-label={mutedYou ? t("overlay.mute.unmuteYou") : t("overlay.mute.muteYou")}
            title={mutedYou ? t("overlay.mute.unmuteYou") : t("overlay.mute.muteYou")}
            className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium transition-colors cursor-pointer ${
              mutedYou
                ? "bg-destructive/15 text-destructive hover:bg-destructive/25"
                : "bg-muted/25 text-foreground/80 hover:bg-accent/60"
            }`}
          >
            {mutedYou ? <MicOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <Mic className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
            <span className="truncate">{mutedYou ? t("overlay.mute.unmuteYou") : t("overlay.mute.muteYou")}</span>
          </button>
          <button
            type="button"
            onClick={onToggleMuteThem}
            aria-pressed={mutedThem}
            aria-label={mutedThem ? t("overlay.mute.unmuteThem") : t("overlay.mute.muteThem")}
            title={mutedThem ? t("overlay.mute.unmuteThem") : t("overlay.mute.muteThem")}
            className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium transition-colors cursor-pointer ${
              mutedThem
                ? "bg-destructive/15 text-destructive hover:bg-destructive/25"
                : "bg-muted/25 text-foreground/80 hover:bg-accent/60"
            }`}
          >
            {mutedThem ? <VolumeX className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <Volume2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
            <span className="truncate">{mutedThem ? t("overlay.mute.unmuteThem") : t("overlay.mute.muteThem")}</span>
          </button>
        </div>
        <button
          type="button"
          onClick={onToggleCaptionsLock}
          aria-pressed={captionsLocked}
          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors cursor-pointer ${
            captionsLocked
              ? "bg-warning/15 text-warning hover:bg-warning/20"
              : "text-foreground/80 hover:bg-accent/50"
          }`}
        >
          {captionsLocked ? <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <Unlock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
          <span className="min-w-0 flex-1 truncate text-left">
            {captionsLocked ? t("overlay:header.captions.unlock") : t("overlay:header.captions.lock")}
          </span>
          {captionsLocked && (
            <span className="shrink-0 rounded bg-warning/20 px-1.5 py-0.5 text-[10px] font-medium">
              {t("overlay:header.captions.lockedBadge")}
            </span>
          )}
        </button>
      </div>

      {/* Section: Live Translation */}
      <div className="py-1 border-b border-border/15">
        <SectionLabel text={t("overlay:header.more.sections.translation")} />
        <button
          type="button"
          onClick={onToggleTranslate}
          aria-pressed={autoTranslateActive}
          aria-label={t("overlay.translate.label")}
          title={
            translationNotReady !== null
              ? t("overlay.translate.notReady", { detail: translationNotReady })
              : t("overlay.translate.toggle")
          }
          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors cursor-pointer ${
            autoTranslateActive
              ? translationNotReady !== null
                ? "bg-warning/10 text-warning"
                : "bg-primary/10 text-primary"
              : "text-foreground/80 hover:bg-accent/50"
          }`}
        >
          {translationNotReady !== null ? (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          )}
          <span className="flex-1 text-left font-medium">{t("overlay.translate.label")}</span>
          {targetLang && (
            <span
              className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground/70"
              title={t("overlay.translate.target", { language: languageLabel(targetLang) })}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full inline-block ${
                  translationNotReady !== null ? "bg-warning" : autoTranslateActive ? "bg-success" : "bg-muted-foreground/40"
                }`}
              />
              {targetLang.toUpperCase()}
            </span>
          )}
        </button>

        {autoTranslateActive && (
          <div className="mt-1 flex items-center gap-1.5 px-2 pb-0.5">
            <div className="flex overflow-hidden rounded-md border border-border/30">
              <button
                type="button"
                onClick={() => onSetDisplayMode("inline")}
                aria-pressed={displayMode === "inline"}
                className={`px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                  displayMode === "inline" ? "bg-primary/15 text-primary" : "text-muted-foreground/60 hover:text-foreground"
                }`}
              >
                {t("overlay.translate.inline")}
              </button>
              <button
                type="button"
                onClick={() => onSetDisplayMode("hover")}
                aria-pressed={displayMode === "hover"}
                className={`border-l border-border/30 px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                  displayMode === "hover" ? "bg-primary/15 text-primary" : "text-muted-foreground/60 hover:text-foreground"
                }`}
              >
                {t("overlay.translate.hover")}
              </button>
            </div>
            <button
              type="button"
              onClick={onTranslateAll}
              disabled={isBatchTranslating}
              className="ml-auto flex items-center gap-1 rounded-md border border-primary/20 bg-primary/5 px-2 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/15 transition-colors disabled:opacity-50 cursor-pointer"
              title={t("overlay.translate.allTitle")}
            >
              {isBatchTranslating ? t("overlay.translate.allRunning") : t("overlay.translate.all")}
            </button>
          </div>
        )}
      </div>

      {/* Section: Panels & Tools */}
      <div className="py-1 border-b border-border/15">
        <SectionLabel text={t("overlay:header.more.sections.panels")} />
        <MenuRow
          icon={<BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />}
          label={t("overlay.panels.speakerStats")}
          active={statsOpen}
          onClick={() => {
            onToggleStats();
            onClose(false);
          }}
        />
        <MenuRow
          icon={<Bookmark className="h-3.5 w-3.5" aria-hidden="true" />}
          label={t("overlay.panels.bookmarks")}
          active={bookmarksOpen}
          onClick={() => {
            onToggleBookmarks();
            onClose(false);
          }}
        />
        <MenuRow
          icon={<Activity className="h-3.5 w-3.5" aria-hidden="true" />}
          label={t("overlay.panels.callLog")}
          active={logOpen}
          onClick={() => {
            onToggleLog();
            onClose(false);
          }}
        />
        <MenuRow
          icon={<Terminal className="h-3.5 w-3.5" aria-hidden="true" />}
          label={t("overlay.panels.devLog")}
          active={devLogOpen}
          onClick={() => {
            onToggleDevLog();
            onClose(false);
          }}
        />
      </div>

      {/* Section: Window & Settings */}
      <div className="pt-1">
        <SectionLabel text={t("overlay:header.more.sections.window")} />
        <MenuRow
          icon={<Settings className="h-3.5 w-3.5" aria-hidden="true" />}
          label={t("overlay.settings")}
          onClick={() => {
            onOpenSettings();
            onClose(false);
          }}
        />
        <MenuRow
          icon={<Minus className="h-3.5 w-3.5" aria-hidden="true" />}
          label={minimizeLabel}
          onClick={() => {
            onMinimize();
            onClose(false);
          }}
        />
      </div>
    </div>,
    document.body,
  );
}

function SectionLabel({ text }: { text: string }) {
  return (
    <p className="px-2 pb-0.5 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/45">
      {text}
    </p>
  );
}

function MenuRow({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors cursor-pointer ${
        active ? "bg-primary/10 text-primary" : "text-foreground/85 hover:bg-accent/50"
      }`}
    >
      <span className={`shrink-0 ${active ? "text-primary" : "text-muted-foreground/70"}`}>{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {active && <Check className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />}
    </button>
  );
}
