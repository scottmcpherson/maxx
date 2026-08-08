import { createPortal } from "react-dom";
import { AgentDefinition, providerDisplayName } from "../contract/types";
import { AgentAvatar } from "./AgentAvatar";
import { ProviderIcon } from "./ProviderIcon";

const CARD_WIDTH = 264;

/**
 * Hover popup for an @mention token: the same identity summary as an agents
 * page card. Portaled to <body> and fixed-positioned so timeline overflow
 * never clips it; anchored above the token, flipping below near the top.
 */
export function AgentHoverCard({
  agent,
  anchor,
}: {
  agent: AgentDefinition;
  anchor: DOMRect;
}) {
  const left = Math.min(
    Math.max(anchor.left + anchor.width / 2 - CARD_WIDTH / 2, 10),
    window.innerWidth - CARD_WIDTH - 10,
  );
  const below = anchor.top < 230;
  const style = below
    ? { left, top: anchor.bottom + 8 }
    : { left, bottom: window.innerHeight - anchor.top + 8 };
  const instructions = agent.instructions.trim();
  return createPortal(
    <div className="agent-hovercard" style={style} role="tooltip">
      <div className="agent-hovercard-header">
        <AgentAvatar
          name={agent.name}
          colorHex={agent.colorHex}
          emoji={agent.emoji}
          imagePath={agent.imagePath}
          size={42}
        />
        <div className="agent-hovercard-title">
          <span className="agent-hovercard-name">{agent.name}</span>
          <span className="agent-hovercard-runtime">
            <ProviderIcon provider={agent.provider} size={11} />
            {providerDisplayName(agent.provider)}
            {agent.model && agent.model.toLowerCase() !== "default" ? ` · ${agent.model}` : ""}
          </span>
        </div>
      </div>
      {instructions && <p className="agent-hovercard-instructions">{instructions}</p>}
    </div>,
    document.body,
  );
}
