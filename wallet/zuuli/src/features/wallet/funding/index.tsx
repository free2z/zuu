import { useLocation, useNavigate } from "react-router-dom";
import { Coins, Gift, Receipt } from "lucide-react";
import { PageHeader } from "@/components/common/PageHeader";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { BalanceHero } from "./BalanceHero";
import { BuyTab } from "./BuyTab";
import { SendTab } from "./SendTab";
import { ActivityTab } from "./ActivityTab";
import { useSession } from "@/store/session";

type TabKey = "buy" | "send" | "activity";

export function fundingTabForPath(pathname: string): TabKey {
  const canonicalPath =
    pathname.endsWith("/") && pathname !== "/"
      ? pathname.slice(0, -1)
      : pathname;
  if (canonicalPath === "/wallet/fund/send") return "send";
  if (canonicalPath === "/wallet/fund/activity") return "activity";
  return "buy";
}

export default function FundingFeature() {
  const location = useLocation();
  const navigate = useNavigate();
  const user = useSession((state) => state.user);
  const tab = fundingTabForPath(location.pathname);

  function selectTab(next: TabKey) {
    const destination =
      next === "send"
        ? "/wallet/fund/send"
        : next === "activity"
          ? "/wallet/fund/activity"
          : "/wallet/fund";
    if (location.pathname !== destination) navigate(destination);
  }

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        title="Wallet funding"
        description="Buy or send 2Zs and review activity."
      />

      {user ? <BalanceHero /> : null}

      <Tabs value={tab} onValueChange={(v) => selectTab(v as TabKey)}>
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
          <SendTab onNeedBuy={() => selectTab("buy")} />
        </TabsContent>
        <TabsContent value="activity">
          <ActivityTab key={user?.username ?? "guest"} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
