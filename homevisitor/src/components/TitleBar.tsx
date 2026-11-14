import type { PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

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
    <header className="flex cursor-default items-center gap-2 border-b border-white/5 px-3 py-2.5">
      <div
        className="min-w-0 flex-1 select-none cursor-grab active:cursor-grabbing"
        onPointerDown={startDrag}
        data-tauri-drag-region
      >
        <div className="flex items-center gap-2" data-tauri-drag-region>
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              live ? "bg-emerald-400" : "bg-white/25"
            }`}
            aria-hidden
          />
          <h1
            className="truncate text-[13px] font-semibold tracking-tight text-white/95"
            data-tauri-drag-region
          >
            Home Visitor
          </h1>
        </div>
        <p className="mt-0.5 truncate pl-3.5 text-[11px] text-white/45" data-tauri-drag-region>
          {subtitle}
        </p>
      </div>
      <div className="flex shrink-0 gap-0.5">
        <button
          type="button"
          className="rounded-md px-2.5 py-1.5 text-sm leading-none text-white/45 hover:bg-white/8 hover:text-white/90"
          title="Minimize"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => void win().minimize()}
        >
          –
        </button>
        <button
          type="button"
          className="rounded-md px-2.5 py-1.5 text-sm leading-none text-white/45 hover:bg-white/8 hover:text-white/90"
          title="Close"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            // Exit process (not hide) so Home Base can respawn a healthy window.
            void invoke("quit_app").catch(() => void win().close());
          }}
        >
          ×
        </button>
      </div>
    </header>
  );
}
