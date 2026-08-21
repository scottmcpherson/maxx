import type { ChatTextSelection } from "../contract/types";
import { BubblesIcon, XIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export function TextSelectionPill({
  selections,
  onClear,
}: {
  selections: ChatTextSelection[];
  onClear?: () => void;
}) {
  if (selections.length === 0) return null;
  const label = `${selections.length} ${selections.length === 1 ? "selection" : "selections"}`;

  return (
    <Tooltip>
      <TooltipTrigger render={<div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-2 py-1 text-xs text-secondary-foreground" tabIndex={0} aria-label={`${label}. Focus or hover to preview.`} />}>
        <BubblesIcon />
        <span>{label}</span>
        {onClear && (
          <Button type="button" variant="ghost" size="icon-xs" className="-my-0.5 -mr-1" aria-label={`Clear ${label}`} onClick={onClear}>
            <XIcon />
          </Button>
        )}
      </TooltipTrigger>
      <TooltipContent className="flex max-w-sm flex-col gap-2">
        {selections.map((selection) => <blockquote key={selection.id} className="border-s-2 border-border ps-2 text-sm text-popover-foreground">{selection.text}</blockquote>)}
      </TooltipContent>
    </Tooltip>
  );
}
