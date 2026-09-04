import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";
import { MESSAGE_KEYS } from "@/i18n/messages";

export function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="animate-slide-up py-8">
      <EmptyState
        icon={Compass}
        title={t(MESSAGE_KEYS.errorNotFoundTitle)}
        description={t(MESSAGE_KEYS.errorNotFoundDescription)}
        action={
          <Button asChild>
            <Link to="/" aria-label={t(MESSAGE_KEYS.errorNotFoundBack)}>
              {t(MESSAGE_KEYS.errorNotFoundBack)}
            </Link>
          </Button>
        }
      />
    </div>
  );
}
