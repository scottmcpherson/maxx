import * as React from "react"

import { cn } from "@/lib/utils"

type TextareaProps = React.ComponentProps<"textarea"> & {
  variant?: "default" | "composer"
}

function Textarea({ className, variant = "default", ...props }: TextareaProps) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full px-2.5 py-2 text-base transition-colors outline-none placeholder:text-placeholder-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        variant === "default"
          ? "rounded-lg border border-input bg-transparent disabled:bg-input/50 dark:bg-input/30 dark:disabled:bg-input/80"
          : "border-0 bg-transparent shadow-none disabled:bg-transparent",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
export type { TextareaProps }
