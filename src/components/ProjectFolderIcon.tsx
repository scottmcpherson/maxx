import { Icons } from "./Icons";

export function ProjectFolderIcon({
  expanded = false,
  remote = false,
  hostName,
  className = "",
}: {
  expanded?: boolean;
  remote?: boolean;
  hostName?: string;
  className?: string;
}) {
  const locationTitle = remote
    ? `Remote project${hostName ? ` on ${hostName}` : ""}`
    : "Local project on this computer";

  return (
    <span
      className={`project-folder-icon ${remote ? "is-remote" : ""} ${className}`.trim()}
      title={locationTitle}
      aria-hidden="true"
    >
      {expanded ? <Icons.folderOpen size={15} /> : <Icons.folder size={15} />}
      {remote && (
        <span className="remote-project-marker">
          <Icons.globe size={8} strokeWidth={2.25} />
        </span>
      )}
    </span>
  );
}
