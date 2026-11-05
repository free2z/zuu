import { expect, test } from "@playwright/test";

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
]) {
  test(`RealtimeKit paginated chat contract after departure at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/search");
    await page.evaluate(async (negativeControl) => {
      const loader = "/@id/@cloudflare/realtimekit-ui/loader";
      const { defineCustomElements } = await import(/* @vite-ignore */ loader);
      await defineCustomElements();
      class Emitter {
        listeners = new Map<string, Set<(value: any) => void>>();
        on(event: string, fn: (value: any) => void) {
          if (!this.listeners.has(event)) this.listeners.set(event, new Set());
          this.listeners.get(event)!.add(fn);
          return this;
        }
        addListener(event: string, fn: (value: any) => void) {
          return this.on(event, fn);
        }
        off(event: string, fn: (value: any) => void) {
          this.listeners.get(event)?.delete(fn);
          return this;
        }
        removeListener(event: string, fn: (value: any) => void) {
          return this.off(event, fn);
        }
        emit(event: string, value: any) {
          for (const fn of this.listeners.get(event) ?? []) fn(value);
        }
      }
      const picture =
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Crect width='20' height='20' fill='red'/%3E%3C/svg%3E";
      const attachment =
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='15'%3E%3Crect width='30' height='15' fill='blue'/%3E%3C/svg%3E";
      const sender = { userId: "alice", name: "Alice", picture };
      let members = [sender];
      const joined = Object.assign(new Emitter(), { toArray: () => members });
      const chat = Object.assign(new Emitter(), {
        fetchPublicMessages: async () => [],
      });
      const permissions = new Emitter();
      const meeting = {
        meta: { viewType: "MEETING" },
        self: { userId: "self", permissions },
        participants: { joined, waitlisted: { toArray: () => [] } },
        chat,
      };
      const element = document.createElement(
        "rtk-chat-messages-ui-paginated",
      ) as any;
      element.meeting = meeting;
      element.style.cssText =
        "height:600px;width:320px;position:fixed;top:0;left:0;z-index:9999";
      document.body.append(element);
      await element.componentOnReady();
      const now = Date.now();
      const message = {
        id: "image-1",
        userId: "alice",
        displayName: "Alice",
        type: "image",
        link: negativeControl ? "data:image/png;base64,invalid" : attachment,
        time: new Date(now),
        timeMs: now,
        targetUserIds: [],
      };
      (window as any).chatFixture = {
        send: () => {
          chat.emit("chatUpdate", { action: "add", message });
          chat.emit("chatUpdate", {
            action: "add",
            message: {
              ...message,
              id: "text-1",
              type: "text",
              message: "Hello from Alice",
              timeMs: now + 1,
            },
          });
        },
        leave: () => {
          members = [];
          joined.emit("participantLeft", sender);
        },
        rerender: () => chat.emit("chatUpdate", { action: "edit", message }),
        rejoin: () => {
          members = [sender];
          joined.emit("participantJoined", sender);
        },
        broken: () => {
          sender.picture = "data:image/png;base64,invalid";
        },
        remove: () => element.remove(),
        listeners: () => chat.listeners.get("chatUpdate")?.size ?? 0,
      };
    }, process.env.RTK_CHAT_NEGATIVE_CONTROL === "1");
    await page.evaluate(() => (window as any).chatFixture.send());
    const message = page.locator("#image-1 rtk-message-view");
    await expect(message).toHaveCount(1);
    await expect(page.locator("rtk-text-message-view")).toContainText(
      "Hello from Alice",
    );
    if (viewport.width < 400) {
      await expect(message.locator("rtk-avatar img")).toBeHidden();
    } else {
      await expect(message.locator("rtk-avatar img")).toBeVisible();
    }
    const attachment = message.locator("rtk-image-message-view img");
    const assertAttachment = async () => {
      await expect(attachment).toBeVisible();
      await expect(attachment).toHaveAttribute("src", /width='30'/);
      await expect
        .poll(() =>
          attachment.evaluate(
            (img: HTMLImageElement) => img.complete && img.naturalWidth === 30,
          ),
        )
        .toBe(true);
      await expect(message).toContainText("Alice");
    };
    await assertAttachment();
    await page.evaluate(() => {
      (window as any).chatFixture.leave();
    });
    await assertAttachment();
    if (viewport.width < 400)
      await expect(message.locator("rtk-avatar")).toBeHidden();
    else await expect(message.locator("rtk-avatar img")).toBeVisible();
    await page.evaluate(() => (window as any).chatFixture.rerender());
    const initials = message.locator("rtk-avatar [part=initials]");
    await expect(initials).toHaveText("A");
    if (viewport.width < 400) await expect(initials).toBeHidden();
    else await expect(initials).toBeVisible();
    await expect(message).toContainText("Alice");
    await expect(page.locator("rtk-text-message-view")).toContainText(
      "Hello from Alice",
    );
    await assertAttachment();
    await page.evaluate(() => {
      (window as any).chatFixture.rejoin();
      (window as any).chatFixture.rerender();
    });
    if (viewport.width < 400) {
      await expect(message.locator("rtk-avatar img")).toBeHidden();
    } else {
      await expect(message.locator("rtk-avatar img")).toBeVisible();
    }
    await assertAttachment();
    await page.evaluate(() => {
      (window as any).chatFixture.broken();
      (window as any).chatFixture.rerender();
    });
    // A hidden lazy image is not fetched on mobile; request it to exercise
    // the browser's real error event while retaining the responsive layout.
    if (viewport.width < 400) {
      const avatarImage = message.locator("rtk-avatar img");
      await expect(avatarImage).toHaveAttribute(
        "src",
        "data:image/png;base64,invalid",
      );
      await avatarImage.evaluate((img: HTMLImageElement) => {
        img.loading = "eager";
      });
    }
    await expect(initials).toHaveText("A");
    if (viewport.width < 400) await expect(initials).toBeHidden();
    else await expect(initials).toBeVisible();
    await assertAttachment();
    await page.evaluate(() => (window as any).chatFixture.remove());
    await expect
      .poll(() => page.evaluate(() => (window as any).chatFixture.listeners()))
      .toBe(0);
  });
}
