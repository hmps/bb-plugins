// Local stand-ins for three host components the upstream github plugin imports
// from `@get-bb/plugin-sdk/app`.
//
// `experimental_Diff`, `experimental_FileLink`, and `experimental_UrlLink`
// landed in plugin SDK 0.4.10, after bb 0.39.0. The 0.39.0 plugin runtime does
// not export them, so importing them by name makes `bb plugin build` fail.
// These fallbacks keep the fork buildable and useful on 0.39.0; swap them back
// for the host components once bb ships the newer runtime.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** An external link. Opens in the system browser, like the host component. */
export function UrlLink({
  href,
  className,
  children,
  ...rest
}: {
  href: string;
  className?: string;
  children?: ReactNode;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className} {...rest}>
      {children}
    </a>
  );
}

export interface FileLinkTarget {
  kind: "workspace";
  environmentId: string;
  path: string;
}

/**
 * A workspace file reference. bb 0.39.0 exposes no plugin API for opening a
 * workspace file, so this renders the path as plain text instead of a link.
 */
export function FileLink({
  className,
  children,
}: {
  target: FileLinkTarget;
  className?: string;
  children?: ReactNode;
}) {
  return <span className={className}>{children}</span>;
}

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) {
    return "text-muted-foreground";
  }
  if (line.startsWith("@@")) return "bg-muted/60 text-muted-foreground";
  if (line.startsWith("+")) {
    return "bg-green-500/10 text-green-700 dark:text-green-400";
  }
  if (line.startsWith("-")) {
    return "bg-red-500/10 text-red-700 dark:text-red-400";
  }
  return "text-foreground";
}

/** A unified diff hunk, rendered line by line with add/remove shading. */
export function Diff({ patch, path }: { patch: string; path: string }) {
  const lines = patch.replace(/\n$/, "").split("\n");
  return (
    <pre
      data-testid="bb-diff"
      data-path={path}
      className="overflow-x-auto py-1 font-mono text-xs leading-5"
    >
      {lines.map((line, index) => (
        <div key={index} className={cn("px-3 whitespace-pre", lineClass(line))}>
          {line.length > 0 ? line : " "}
        </div>
      ))}
    </pre>
  );
}
