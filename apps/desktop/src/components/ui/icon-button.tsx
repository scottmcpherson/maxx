import * as React from "react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

type IconButtonProps = Omit<React.ComponentProps<typeof Button>, "children"> & {
  label: string
  tooltip?: string
  children: React.ReactNode
}

function IconButton({ label, tooltip = label, children, ...props }: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={label} {...props} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

export { IconButton }
