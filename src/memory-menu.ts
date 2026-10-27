/** Shared action order and descriptions; native dispatch remains generation-specific. */
export const MEMORY_MENU_OPTIONS = [
  { title: "Show memory", value: "show" },
  { title: "Show log file path", value: "logs" },
  { title: "Show settings and config paths", value: "settings" },
  { title: "Show status and live counters", value: "status" },
  { title: "Update memory (uses memory model)", value: "update" },
  { title: "Reset saved memory...", value: "reset" },
  { title: "Create optional example config...", value: "setup" },
] as const;
