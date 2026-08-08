import { formatKeyboardShortcut } from "../keyboardShortcuts";
import { useAppStore } from "../store/appStore";
import { Icons } from "./Icons";

/**
 * The sidebar toggle, anchored to the window instead of to either surface.
 *
 * It used to be two buttons — one in the sidebar's own title bar, one in the
 * collapsed controls of whatever view was showing — which meant toggling the
 * sidebar unmounted one and mounted the other a few points away, while the
 * first slid off with the collapsing sidebar. Read as a jump, because it was
 * one. A single button pinned just right of the traffic lights sits in the same
 * place in both states, so the sidebar slides out from under it.
 */
export function SidebarToggle() {
  const sidebarOpen = useAppStore((state) => state.sidebarOpen);
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);
  const shortcut = useAppStore((state) => state.keyboardShortcuts.toggleSidebar);

  return (
    <button
      className="icon-button window-sidebar-toggle"
      title={`${sidebarOpen ? "Hide" : "Show"} sidebar (${formatKeyboardShortcut(shortcut)})`}
      aria-label="Toggle sidebar"
      aria-expanded={sidebarOpen}
      onClick={() => toggleSidebar()}
    >
      <Icons.sidebar size={15} />
    </button>
  );
}
