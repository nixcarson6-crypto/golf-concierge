import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium leading-tight transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-surface-raised text-foreground",
        navy: "border-[hsl(var(--navy)/0.25)] bg-[hsl(var(--navy)/0.06)] text-[hsl(var(--navy))]",
        copper: "border-[hsl(var(--copper)/0.35)] bg-[hsl(var(--copper)/0.08)] text-[hsl(var(--copper))]",
        emerald: "border-[hsl(var(--emerald)/0.3)] bg-[hsl(var(--emerald)/0.07)] text-[hsl(var(--emerald))]",
        muted: "border-border bg-transparent text-muted-foreground",
        warning: "border-[hsl(var(--warning)/0.35)] bg-[hsl(var(--warning)/0.08)] text-[hsl(var(--warning))]",
        destructive: "border-[hsl(var(--destructive)/0.35)] bg-[hsl(var(--destructive)/0.08)] text-[hsl(var(--destructive))]",
        outline: "border-border text-foreground",
      },
      size: {
        sm: "px-2 py-0.5 text-[10px]",
        md: "px-2.5 py-0.5 text-xs",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}
