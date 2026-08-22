import type { ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { cn } from "../lib/utils";

export function TimelineDisclosure({
  summary,
  children,
  contentClassName,
}: {
  summary: ReactNode;
  children: ReactNode;
  contentClassName?: string;
}) {
  return (
    <Collapsible className="min-w-0 px-2 text-xs text-muted-foreground">
      <CollapsibleTrigger className="group flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-left text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        <ChevronRightIcon
          aria-hidden="true"
          size={14}
          className="shrink-0 transition-transform duration-150 ease-out group-data-panel-open:rotate-90"
        />
        {summary}
      </CollapsibleTrigger>
      <CollapsibleContent className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-150 ease-out data-ending-style:h-0 data-starting-style:h-0">
        <div className={cn("min-w-0 max-w-full overflow-hidden pb-1 ps-5 pt-1.5", contentClassName)}>
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
