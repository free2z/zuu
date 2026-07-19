import { Link } from "react-router-dom";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";

export function NotFound() {
  return (
    <div className="animate-slide-up py-8">
      <EmptyState
        icon={Compass}
        title="Page not found"
        description="This page doesn't exist or has moved. Let's get you back on track."
        action={
          <Button asChild>
            <Link to="/" aria-label="Back to Discover">
              Back to Discover
            </Link>
          </Button>
        }
      />
    </div>
  );
}
