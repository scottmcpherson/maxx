import * as React from "react"

import { cn } from "@/lib/utils"

type TextareaProps = React.ComponentProps<"textarea"> & {
  variant?: "default" | "composer"
}

const textareaComposerTextMetrics = "px-0.5 pt-0.5 pb-1.5 text-sm leading-normal"

function Textarea({ className, variant = "default", ...props }: TextareaProps) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full transition-colors outline-none placeholder:text-placeholder-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        variant === "default"
          ? "rounded-lg border border-input bg-transparent px-2.5 py-2 text-base disabled:bg-input/50 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80"
          : cn("border-0 bg-transparent shadow-none disabled:bg-transparent", textareaComposerTextMetrics),
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
export { textareaComposerTextMetrics }
export type { TextareaProps }
