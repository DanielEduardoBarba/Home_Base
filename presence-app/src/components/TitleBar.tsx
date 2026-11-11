import type { PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function TitleBar({
  subtitle,
  live,
}: {
  subtitle: string;
  live: boolean;
}) {
  const win = () => getCurrentWindow();

  function startDrag(e: ReactPointerEvent) {
    if (e.button !== 0) return;
    // Explicit drag — CSS drag-region alone is unreliable on Linux WebKit.
    void win().startDragging();
  }

  return (
    <header
      onPointerDown={startDrag}
      className="flex cursor-grab items-center gap-2 border-b border-white/5 px-3 py-2.5 active:cursor-grabbing"
      data-tauri-drag-region
    >
      <div className="min-w-0 flex-1 select-none" data-tauri-drag-region>
        <div className="flex items-center gap-2">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              live ? "bg-emerald-400" : "bg-white/25"
            }`}
            aria-hidden
          />
          <h1 className="truncate text-[13px] font-semibold tracking-tight text-white/95">
            Presence
          </h1>
        </div>
        <p className="mt-0.5 truncate pl-3.5 text-[11px] text-white/45">
          {subtitle}
        </p>
      </div>
      <div
        className="flex shrink-0 gap-0.5"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="rounded-md px-2.5 py-1.5 text-sm leading-none text-white/45 hover:bg-white/8 hover:text-white/90"
          title="Minimize"
          onClick={() => void win().minimize()}
        >
          –
        </button>
        <button
          type="button"
          className="rounded-md px-2.5 py-1.5 text-sm leading-none text-white/45 hover:bg-white/8 hover:text-white/90"
          title="Close"
          onClick={() => void win().hide()}
        >
          ×
        </button>
      </div>
    </header>
  );
}
