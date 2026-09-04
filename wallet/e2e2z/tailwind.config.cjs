/**
 * e2e2z's design tokens.
 *
 * This is `wallet/zuuli/tailwind.config.cjs` reduced to what the messaging
 * surface actually renders (#904 phase 3). It is deliberately a copy rather
 * than an import: `wallet/zuuli/scripts/project-boundary.mjs` forbids one
 * wallet project from reaching into another's tree, and a shared build config
 * would be exactly that. The token *names* and *values* are kept identical so
 * the two apps read as one product; anything unused here — the brand colours,
 * the dialog and accordion keyframes, the container scale — is left out rather
 * than carried dead.
 *
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        link: "hsl(var(--link))",
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontSize: {
        xs: ["0.75rem", { lineHeight: "1.125rem" }],
        sm: ["0.875rem", { lineHeight: "1.375rem" }],
        base: ["1rem", { lineHeight: "1.5625rem" }],
        lg: ["1.125rem", { lineHeight: "1.625rem", letterSpacing: "-0.008em" }],
        xl: ["1.25rem", { lineHeight: "1.75rem", letterSpacing: "-0.014em" }],
        "2xl": ["1.5rem", { lineHeight: "1.95rem", letterSpacing: "-0.018em" }],
        "3xl": ["1.875rem", { lineHeight: "2.25rem", letterSpacing: "-0.022em" }],
        "4xl": ["2.25rem", { lineHeight: "2.5rem", letterSpacing: "-0.026em" }],
      },
      fontFamily: {
        // Bundled in src/fonts.css — the Tauri CSP has no font-src, so a
        // remote webfont would silently fall back to system UI.
        sans: ["IBM Plex Sans Variable", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      keyframes: {
        // A short, small settle: the content arriving, not an effect.
        "slide-up": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        // Loading placeholders breathe in place instead of sweeping a
        // highlight across themselves.
        "skeleton-pulse": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.55" },
        },
      },
      animation: {
        "slide-up": "slide-up 0.24s cubic-bezier(0.22, 1, 0.36, 1)",
        "skeleton-pulse": "skeleton-pulse 1.8s ease-in-out infinite",
      },
    },
  },
  plugins: [
    function ({ addUtilities }) {
      addUtilities({
        ".min-tap": { "min-width": "44px", "min-height": "44px" },
      });
    },
  ],
};
