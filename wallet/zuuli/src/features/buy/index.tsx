import { useState } from "react";
import { Coins, Gift, Receipt } from "lucide-react";
import { PageHeader } from "@/components/common/PageHeader";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { BalanceHero } from "./BalanceHero";
import { BuyTab } from "./BuyTab";
import { SendTab } from "./SendTab";
import { ActivityTab } from "./ActivityTab";

type TabKey = "buy" | "send" | "activity";

export default function BuyFeature() {
  const [tab, setTab] = useState<TabKey>("buy");

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        title="2Z economy"
        description="Your two balances, one app — buy 2Zs, tip creators, and track every transaction."
      />

      <BalanceHero />

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList className="grid w-full grid-cols-3 sm:inline-flex sm:w-auto">
          <TabsTrigger value="buy" className="gap-1.5">
            <Coins className="h-4 w-4" />
            Buy
          </TabsTrigger>
          <TabsTrigger value="send" className="gap-1.5">
            <Gift className="h-4 w-4" />
            Send &amp; Tip
          </TabsTrigger>
          <TabsTrigger value="activity" className="gap-1.5">
            <Receipt className="h-4 w-4" />
            Activity
          </TabsTrigger>
        </TabsList>

        <TabsContent value="buy">
          <BuyTab />
        </TabsContent>
        <TabsContent value="send">
          <SendTab onNeedBuy={() => setTab("buy")} />
        </TabsContent>
        <TabsContent value="activity">
          <ActivityTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
