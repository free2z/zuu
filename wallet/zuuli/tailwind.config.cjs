/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: { "2xl": "1400px" },
    },
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
        // Lighter violet used for hyperlinks in rendered content (see
        // src/index.css) so link text meets WCAG AA contrast on dark
        // backgrounds without changing the app-wide --primary accent.
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
        // Status semantics. These exist so a callout or a badge never has to
        // reach for a raw palette step (emerald-400, amber-500, sky-400) and
        // drift away from the rest of the interface.
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
        // ZUULI brand — Zcash gold, 2Z violet, LIVE rose. Tokenised so they
        // move with the theme instead of being pasted as hex literals.
        zec: {
          DEFAULT: "hsl(var(--zec))",
          fg: "hsl(var(--zec-foreground))",
        },
        tuzi: {
          DEFAULT: "hsl(var(--tuzi))",
          fg: "hsl(var(--tuzi-foreground))",
        },
        live: {
          DEFAULT: "hsl(var(--live))",
          fg: "hsl(var(--live-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      // A tuned scale rather than Tailwind's defaults: 12px is the floor for
      // anything meant to be read, body sizes keep generous leading, and the
      // display steps tighten their tracking as they grow so Plex Sans reads
      // as display type instead of enlarged body copy.
      fontSize: {
        xs: ["0.75rem", { lineHeight: "1.125rem" }],
        sm: ["0.875rem", { lineHeight: "1.375rem" }],
        base: ["1rem", { lineHeight: "1.5625rem" }],
        lg: ["1.125rem", { lineHeight: "1.625rem", letterSpacing: "-0.008em" }],
        xl: ["1.25rem", { lineHeight: "1.75rem", letterSpacing: "-0.014em" }],
        "2xl": ["1.5rem", { lineHeight: "1.95rem", letterSpacing: "-0.018em" }],
        "3xl": ["1.875rem", { lineHeight: "2.25rem", letterSpacing: "-0.022em" }],
        "4xl": ["2.25rem", { lineHeight: "2.5rem", letterSpacing: "-0.026em" }],
        "5xl": ["3rem", { lineHeight: "1", letterSpacing: "-0.03em" }],
        "6xl": ["3.75rem", { lineHeight: "1", letterSpacing: "-0.034em" }],
      },
      fontFamily: {
        // Bundled in src/fonts.css — the Tauri CSP has no font-src, so a
        // remote webfont would silently fall back to system UI.
        sans: ["IBM Plex Sans Variable", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        // A short, small settle. This fires on almost every route root, so it
        // has to read as the content arriving rather than as an effect.
        "slide-up": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        // Dialog/modal entrance. Keeps the `-translate-x/y-1/2` centering baked
        // into the transform so the content never jumps off-center mid-anim
        // (a plain translateY keyframe overrides the centering and makes the
        // panel jerk in from the lower-right before snapping to center).
        "dialog-in": {
          from: { opacity: "0", transform: "translate(-50%, -48%) scale(0.985)" },
          to: { opacity: "1", transform: "translate(-50%, -50%) scale(1)" },
        },
        "pulse-live": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.45" },
        },
        // Loading placeholders breathe in place instead of sweeping a
        // highlight across themselves.
        "skeleton-pulse": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.55" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 0.25s ease-out",
        "slide-up": "slide-up 0.24s cubic-bezier(0.22, 1, 0.36, 1)",
        "dialog-in": "dialog-in 0.18s cubic-bezier(0.22, 1, 0.36, 1)",
        "pulse-live": "pulse-live 1.6s ease-in-out infinite",
        "skeleton-pulse": "skeleton-pulse 1.8s ease-in-out infinite",
      },
    },
  },
  plugins: [
    require("tailwindcss-animate"),
    function ({ addUtilities }) {
      addUtilities({
        ".min-tap": { "min-width": "44px", "min-height": "44px" },
      });
    },
  ],
};
