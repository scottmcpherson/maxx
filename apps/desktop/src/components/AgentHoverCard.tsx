import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { providerDisplayName, type AgentDefinition } from "../contract/types";
import { AgentAvatar } from "./AgentAvatar";
import { ProviderIcon } from "./ProviderIcon";

/**
 * Hover popup for an @mention token. Base UI accepts a virtual anchor, so the
 * existing DOMRect-based placement remains stable without a hand-rolled portal
 * or focus/escape implementation.
 */
export function AgentHoverCard({
  agent,
  anchor,
}: {
  agent: AgentDefinition;
  anchor: DOMRect;
}) {
  const below = anchor.top < 230;
  const instructions = agent.instructions.trim();
  return (
    <HoverCard open>
      <HoverCardTrigger
        render={
          <span
            aria-hidden="true"
            className="fixed pointer-events-none"
            style={{ left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height }}
          />
        }
      />
      <HoverCardContent side={below ? "bottom" : "top"} sideOffset={8} className="w-64 p-3">
        <div className="flex items-center gap-3">
          <AgentAvatar
            name={agent.name}
            colorHex={agent.colorHex}
            emoji={agent.emoji}
            imagePath={agent.imagePath}
            size={42}
          />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="truncate font-medium">{agent.name}</span>
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <ProviderIcon provider={agent.provider} size={11} />
              <span className="truncate">
                {providerDisplayName(agent.provider)}
                {agent.model && agent.model.toLowerCase() !== "default" ? ` · ${agent.model}` : ""}
              </span>
            </span>
          </div>
        </div>
        {instructions && <p className="mt-3 text-sm text-muted-foreground">{instructions}</p>}
      </HoverCardContent>
    </HoverCard>
  );
}
