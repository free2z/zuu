import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const viewportOffsets = {
  right: "var(--toast-horizontal-offset)",
  bottom: "var(--toast-bottom-offset)",
  left: "var(--toast-horizontal-offset)",
} as const;

/** App-wide toast host. Import { toast } from "sonner" to fire toasts. */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="app-toaster toaster group"
      position="bottom-right"
      offset={viewportOffsets}
      mobileOffset={viewportOffsets}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-card group-[.toaster]:text-card-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg group-[.toaster]:rounded-xl",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
