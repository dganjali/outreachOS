import { cn } from "@/lib/utils"

// Shimmer-sweep skeleton (see .app-skeleton in index.css). Reads more clearly as
// "loading" than a faint pulse, and respects prefers-reduced-motion.
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("app-skeleton rounded-md", className)}
      {...props}
    />
  )
}

export { Skeleton }
