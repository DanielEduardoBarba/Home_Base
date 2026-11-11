import { getCurrentWindow } from "@tauri-apps/api/window";

export function TitleBar({
  status,
  active,
  count,
}: {
  status: string;
  active: boolean;
  count: number;
}) {
  const win = () => getCurrentWindow();

  return (
    <header
      data-tauri-drag-region
      className="flex items-center gap-2 border-b border-hb-line/70 px-3 py-2.5"
    >
      <div data-tauri-drag-region className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${
              active
                ? "bg-hb-warn shadow-[0_0_8px_rgba(240,180,41,0.7)]"
                : "bg-hb-mute/50"
            }`}
            aria-hidden
          />
          <h1 className="truncate text-[13px] font-semibold tracking-tight text-hb-text">
            Presence
          </h1>
          {count > 0 ? (
            <span className="rounded-md bg-hb-panel2 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-hb-sky">
              {count}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 truncate pl-4 text-[10px] text-hb-mute">{status}</p>
      </div>
      <div className="flex shrink-0 gap-0.5">
        <button
          type="button"
          className="rounded-md px-2.5 py-1.5 text-sm leading-none text-hb-mute hover:bg-hb-panel2 hover:text-hb-text"
          title="Minimize"
          onClick={() => void win().minimize()}
        >
          –
        </button>
        <button
          type="button"
          className="rounded-md px-2.5 py-1.5 text-sm leading-none text-hb-mute hover:bg-hb-panel2 hover:text-hb-text"
          title="Hide"
          onClick={() => void win().hide()}
        >
          ×
        </button>
      </div>
    </header>
  );
}
