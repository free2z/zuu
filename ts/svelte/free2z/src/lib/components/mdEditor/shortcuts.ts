export type PlatformShortcut = {
  mac: string;
  windows: string;
};

export const editorShortcuts = {
  heading1: { mac: "Cmd+Opt+1", windows: "Ctrl+Alt+1" },
  heading2: { mac: "Cmd+Opt+2", windows: "Ctrl+Alt+2" },
  heading3: { mac: "Cmd+Opt+3", windows: "Ctrl+Alt+3" },
  heading4: { mac: "Cmd+Opt+4", windows: "Ctrl+Alt+4" },
  heading5: { mac: "Cmd+Opt+5", windows: "Ctrl+Alt+5" },
  heading6: { mac: "Cmd+Opt+6", windows: "Ctrl+Alt+6" },
  bold: { mac: "Cmd+B", windows: "Ctrl+B" },
  italic: { mac: "Cmd+I", windows: "Ctrl+I" },
  strikethrough: { mac: "Cmd+Shift+X", windows: "Ctrl+Shift+X" },
  code: { mac: "Cmd+E", windows: "Ctrl+E" },
  link: { mac: "Cmd+K", windows: "Ctrl+K" },
  orderedList: { mac: "Cmd+Shift+7", windows: "Ctrl+Shift+7" },
  bulletList: { mac: "Cmd+Shift+8", windows: "Ctrl+Shift+8" },
  quote: { mac: "Cmd+Shift+.", windows: "Ctrl+Shift+." },
} satisfies Record<string, PlatformShortcut>;

export function getShortcutLabel(
  shortcut: PlatformShortcut,
  isMac: boolean,
): string {
  return isMac ? shortcut.mac : shortcut.windows;
}

export function detectMacPlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  const nav = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
    };
  };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent;

  return /mac/i.test(platform);
}
