import { useState } from "react";
import { Link } from "react-router-dom";
import { BadgeCheck, Loader2, Lock, Save, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/common/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/common/PageHeader";
import { Textarea } from "@/components/ui/textarea";
import { profile } from "@/lib/api/free2z";
import { initials } from "@/lib/format";
import { useSession } from "@/store/session";
import type { AuthUser } from "@/lib/api/types";
import { LinkedAccounts } from "./LinkedAccounts";

const BIO_MAX = 1024;
const NAME_MAX = 128;
const ADDR_MAX = 255;

export default function ProfileFeature() {
  const user = useSession((s) => s.user);

  if (!user) {
    return (
      <div className="animate-slide-up">
        <PageHeader title="Edit profile" />
        <EmptyState
          icon={Lock}
          title="Sign in with Zcash to edit your profile"
          description="Sign a challenge with your wallet — no password or email required."
          action={
            <Button asChild>
              <Link to="/login">Sign in with Zcash</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return <ProfileForm key={user.username} user={user} />;
}

function ProfileForm({ user }: { user: AuthUser }) {
  const setUser = useSession((s) => s.setUser);
  const name = user.display_name || user.username;

  const [displayName, setDisplayName] = useState(name);
  const [bio, setBio] = useState(user.bio ?? "");
  const [p2paddr, setP2paddr] = useState(user.p2paddr ?? "");
  const [memberPrice, setMemberPrice] = useState(
    user.member_price != null ? String(user.member_price) : "",
  );
  const [saving, setSaving] = useState(false);

  const trimmedName = displayName.trim();
  const canSave = trimmedName.length > 0 && !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      const price = memberPrice.trim();
      const updated = await profile.update({
        display_name: trimmedName,
        bio: bio.trim(),
        p2paddr: p2paddr.trim(),
        member_price: price === "" ? null : Math.max(0, Math.round(Number(price))),
      });
      setUser(updated);
      toast.success("Profile updated");
    } catch {
      toast.error("Couldn't save your profile. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="animate-slide-up">
      <PageHeader
        title="Edit profile"
        description="This is what other creators and fans see on your public page."
        actions={
          <Button onClick={save} disabled={!canSave}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Saving
              </>
            ) : (
              <>
                <Save className="h-4 w-4" aria-hidden />
                Save changes
              </>
            )}
          </Button>
        }
      />

      <Card className="mb-6 flex flex-col items-start justify-between gap-3 rounded-xl border-border/60 bg-card/60 p-5 sm:flex-row sm:items-center">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
            <ShieldCheck className="h-5 w-5" aria-hidden />
          </div>
          <div>
            <div className="font-medium">Creator revenue share</div>
            <p className="text-sm text-muted-foreground">
              Verify your identity and complete a tax form to apply for the
              creator revenue-share program.
            </p>
          </div>
        </div>
        <Button asChild variant="outline" className="shrink-0">
          <Link to="/kyc">Apply for revenue share</Link>
        </Button>
      </Card>

      <div className="mb-6">
        <LinkedAccounts user={user} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Form */}
        <Card className="space-y-5 rounded-xl border-border/60 bg-card/60 p-5">
          <div className="space-y-2">
            <Label htmlFor="profile-username">Username</Label>
            <Input id="profile-username" value={user.username} disabled />
            <p className="text-xs text-muted-foreground">
              @{user.username} · usernames can't be changed here yet.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="profile-display-name">Display name</Label>
            <Input
              id="profile-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value.slice(0, NAME_MAX))}
              placeholder="How you want to appear to fans"
              maxLength={NAME_MAX}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="profile-bio">Bio</Label>
            <Textarea
              id="profile-bio"
              value={bio}
              onChange={(e) => setBio(e.target.value.slice(0, BIO_MAX))}
              placeholder="Tell people what you're building, streaming or writing about."
              className="min-h-[140px] resize-y"
            />
            <p className="text-xs tabular-nums text-muted-foreground">
              {bio.length} / {BIO_MAX}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="profile-member-price">
              Membership price (2Z / 30 days)
            </Label>
            <Input
              id="profile-member-price"
              type="number"
              min={0}
              inputMode="numeric"
              value={memberPrice}
              onChange={(e) => setMemberPrice(e.target.value)}
              placeholder="Leave blank for no paid membership tier"
              className="tabular-nums"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="profile-p2paddr">
              Zcash address for tips{" "}
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
            </Label>
            <Input
              id="profile-p2paddr"
              value={p2paddr}
              onChange={(e) => setP2paddr(e.target.value.slice(0, ADDR_MAX))}
              placeholder="Defaults to your account address if left blank"
              className="font-mono text-xs"
            />
          </div>
        </Card>

        {/* Preview */}
        <div className="space-y-3 lg:sticky lg:top-6 lg:self-start">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Preview
          </div>
          <Card className="rounded-xl border-border/60 bg-card/40 p-5">
            <div className="flex items-center gap-3">
              <Avatar className="h-14 w-14 border border-border">
                {user.image ? <AvatarImage src={user.image} alt={name} /> : null}
                <AvatarFallback className="bg-primary/15 text-lg text-primary">
                  {initials(trimmedName || user.username)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-semibold">
                    {trimmedName || user.username}
                  </span>
                  {user.is_verified ? (
                    <BadgeCheck
                      className="h-4 w-4 shrink-0 text-primary"
                      aria-label="Verified creator"
                    />
                  ) : null}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  @{user.username}
                </div>
              </div>
            </div>
            {bio ? (
              <p className="mt-4 whitespace-pre-wrap text-sm text-muted-foreground">
                {bio}
              </p>
            ) : null}
          </Card>
          <p className="px-1 text-xs text-muted-foreground">
            Avatar and banner image uploads are coming soon — for now they can
            be set from the classic free2z site.
          </p>
        </div>
      </div>
    </div>
  );
}
