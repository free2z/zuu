import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useSession } from "@/store/session";
import { ProducerPanel } from "./ProducerPanel";

/** HTTP v1 host runtime, independent from viewer/legacy join tickets. */
export function ProducerDialog() {
  const [open, setOpen] = useState(false);
  const user = useSession((s) => s.user);
  const { t } = useTranslation();
  if (!user?.id) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="lg">{t("producer.heading")}</Button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[95dvh] overflow-y-auto max-w-3xl"
        closeClassName="min-tap grid place-items-center rounded-md"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>{t("producer.heading")}</DialogTitle>
        </DialogHeader>
        <ProducerPanel />
      </DialogContent>
    </Dialog>
  );
}
