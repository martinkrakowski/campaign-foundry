import type { ReactNode } from "react";

export function FloatingBar({ children, ...rest }: { children: ReactNode } & Record<string, unknown>) {
  return (
    <div
      {...rest}
      className="absolute bottom-6 left-1/2 z-20 w-full max-w-[800px] -translate-x-1/2 rounded-xl border border-border bg-surface p-2 shadow-2xl"
    >
      {children}
    </div>
  );
}
