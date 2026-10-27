import type { EventNotification } from "$lib/api/events/eventNotificationsApi";
import {
  getCurrentLocale,
  t,
  type SupportedLocale,
  type TranslationFunction,
} from "$lib/i18n";
import { defineMessage, translateMessage } from "$lib/i18n-message";

const EVENT_MESSAGES = {
  aiScoreComment: defineMessage(
    "notifications.events.aiScoreComment",
    "You received {amount} 2Z from the AI for your comment.",
  ),
  madeComment: defineMessage(
    "notifications.events.madeComment",
    "You posted a comment with {amount} 2Z.",
  ),
  commentVoteReceived: defineMessage(
    "notifications.events.commentVoteReceived",
    "{username} voted on your comment with {amount} 2Z.",
  ),
  commentVoteSent: defineMessage(
    "notifications.events.commentVoteSent",
    "You voted on \u201C{title}\u201D with {amount} 2Z.",
  ),
  commentVoteSentUntitled: defineMessage(
    "notifications.events.commentVoteSentUntitled",
    "You voted on a comment with {amount} 2Z.",
  ),
  newReply: defineMessage(
    "notifications.events.newReply",
    "New reply from {username}.",
  ),
  pageUpdated: defineMessage(
    "notifications.events.pageUpdated",
    "\u201C{title}\u201D by {username} was updated.",
  ),
  pageUpdatedUntitled: defineMessage(
    "notifications.events.pageUpdatedUntitled",
    "A page by {username} was updated.",
  ),
  pageMention: defineMessage(
    "notifications.events.pageMention",
    "{username} mentioned you in “{title}”.",
  ),
  pageMentionUntitled: defineMessage(
    "notifications.events.pageMentionUntitled",
    "{username} mentioned you in a page.",
  ),
  // PAGE_VOTE is written twice per vote -- once to the voter, once to the page
  // owner -- so the framing depends on which of the two is reading it.
  pageVoteReceived: defineMessage(
    "notifications.events.pageVoteReceived",
    "{username} voted on \u201C{title}\u201D with {amount} 2Z.",
  ),
  pageVoteReceivedUntitled: defineMessage(
    "notifications.events.pageVoteReceivedUntitled",
    "{username} voted on your page with {amount} 2Z.",
  ),
  pageVoteSent: defineMessage(
    "notifications.events.pageVoteSent",
    "You voted on \u201C{title}\u201D with {amount} 2Z.",
  ),
  pageVoteSentUntitled: defineMessage(
    "notifications.events.pageVoteSentUntitled",
    "You voted on a page with {amount} 2Z.",
  ),
  donationReceived: defineMessage(
    "notifications.events.donationReceived",
    "You received {amount} 2Z from {username}.",
  ),
  donationSent: defineMessage(
    "notifications.events.donationSent",
    "You sent {amount} 2Z to {username}.",
  ),
  // dj.apps.e2ee. The link (content_url) opens e2e2z, where the chat
  // actually happens; nothing was sent to the reader yet.
  encryptedChatRequest: defineMessage(
    "notifications.events.encryptedChatRequest",
    "{username} paid {amount} 2Z to start an encrypted chat with you. Open e2e2z to reply.",
  ),
  encryptedChatRequestSent: defineMessage(
    "notifications.events.encryptedChatRequestSent",
    "You paid {amount} 2Z to ask {username} for an encrypted chat.",
  ),
  subscriptionReceived: defineMessage(
    "notifications.events.subscriptionReceived",
    "Subscription payment of {amount} 2Z received from {username}.",
  ),
  subscriptionSent: defineMessage(
    "notifications.events.subscriptionSent",
    "Subscription payment of {amount} 2Z sent to {username}.",
  ),
  bought2Z: defineMessage(
    "notifications.events.bought2Z",
    "You bought {amount} 2Z.",
  ),
  // Observation is not issuance. Confirmation, capacity and source resolution
  // can still be pending; the estimate on a legacy event is not a credited
  // quantity. Actual purchase status and source-backed issuance are separate.
  zecPending: defineMessage(
    "notifications.events.zecPending",
    "Your Zcash payment was detected. We’re processing it. Check your credit balance in Credits & Earnings.",
  ),
  chat2Z: defineMessage(
    "notifications.events.chat2Z",
    "You paid {amount} 2Z for your Chat2Z prompt.",
  ),
  platformFee: defineMessage(
    "notifications.events.platformFee",
    "Platform fee: {amount} 2Z.",
  ),
  payPerViewRevenue: defineMessage(
    "notifications.events.payPerViewRevenue",
    "{username} paid you {amount} 2Z for pay-per-view access.",
  ),
  payPerViewSpend: defineMessage(
    "notifications.events.payPerViewSpend",
    "You paid {username} {amount} 2Z for pay-per-view access.",
  ),
  generic: defineMessage(
    "notifications.events.generic",
    "You have a new notification.",
  ),
  contentUnavailable: defineMessage(
    "notifications.events.contentUnavailable",
    "This content is no longer available.",
  ),
  someone: defineMessage("notifications.events.someone", "Someone"),
  anonymous: defineMessage(
    "notifications.events.anonymous",
    "a supporter who hid their username",
  ),
};

function formatAmount(
  amount: number | null | undefined,
  locale: SupportedLocale,
) {
  return new Intl.NumberFormat(locale).format(amount ?? 0);
}

function titleOf(event: EventNotification): string | undefined {
  const title = (event as { content_title?: unknown }).content_title;
  return typeof title === "string" && title.trim() ? title.trim() : undefined;
}

/**
 * True when the person reading the notification is also the person who caused
 * it. The backend writes one Event row per recipient, so `receiving_user` is
 * the reader and `contributor` is the actor; for the dual-recipient types
 * (PAGE_VOTE) this is the only thing that distinguishes "you voted" from
 * "someone voted on yours".
 */
function readerIsActor(event: EventNotification): boolean {
  const reader = usernameOf(event.receiving_user);
  const actor = usernameOf(event.contributor);
  return Boolean(reader && actor && reader === actor);
}

function usernameOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const username = (value as { username?: unknown }).username;
  return typeof username === "string" && username.trim()
    ? username.trim()
    : undefined;
}

/**
 * Builds notification copy from stable event fields instead of the backend's
 * pre-rendered English `message`. Unknown event types deliberately use a safe,
 * localized generic message rather than leaking server copy into the UI.
 */
export function formatEventNotification(
  event: EventNotification,
  translator: TranslationFunction = t,
  locale: SupportedLocale = getCurrentLocale(),
): string {
  if ((event as { content_available?: unknown }).content_available === false) {
    return translateMessage(
      EVENT_MESSAGES.contentUnavailable,
      undefined,
      translator,
    );
  }
  const amount = formatAmount(event.amount, locale);
  const contributor =
    usernameOf(event.contributor) ??
    translateMessage(EVENT_MESSAGES.someone, undefined, translator);
  const payee =
    usernameOf(event.payee) ??
    translateMessage(EVENT_MESSAGES.someone, undefined, translator);
  const title = titleOf(event);

  switch (event.type) {
    case "AISCORE_COMMENT":
      return translateMessage(
        EVENT_MESSAGES.aiScoreComment,
        { amount },
        translator,
      );
    case "MADE_COMMENT":
      return translateMessage(
        EVENT_MESSAGES.madeComment,
        { amount },
        translator,
      );
    case "VOTE_COMMENT_RECEIVED":
      return translateMessage(
        EVENT_MESSAGES.commentVoteReceived,
        { amount, username: contributor },
        translator,
      );
    case "VOTE_COMMENT_SENT":
      return title
        ? translateMessage(
            EVENT_MESSAGES.commentVoteSent,
            { amount, title },
            translator,
          )
        : translateMessage(
            EVENT_MESSAGES.commentVoteSentUntitled,
            { amount },
            translator,
          );
    case "NEW_REPLY":
      return translateMessage(
        EVENT_MESSAGES.newReply,
        { username: contributor },
        translator,
      );
    case "PAGE_UPDATE":
      return title
        ? translateMessage(
            EVENT_MESSAGES.pageUpdated,
            { title, username: contributor },
            translator,
          )
        : translateMessage(
            EVENT_MESSAGES.pageUpdatedUntitled,
            { username: contributor },
            translator,
          );
    case "PAGE_MENTION":
      return title
        ? translateMessage(
            EVENT_MESSAGES.pageMention,
            { title, username: contributor },
            translator,
          )
        : translateMessage(
            EVENT_MESSAGES.pageMentionUntitled,
            { username: contributor },
            translator,
          );
    case "PAGE_VOTE":
      if (readerIsActor(event)) {
        return title
          ? translateMessage(
              EVENT_MESSAGES.pageVoteSent,
              { amount, title },
              translator,
            )
          : translateMessage(
              EVENT_MESSAGES.pageVoteSentUntitled,
              { amount },
              translator,
            );
      }
      return title
        ? translateMessage(
            EVENT_MESSAGES.pageVoteReceived,
            { amount, title, username: contributor },
            translator,
          )
        : translateMessage(
            EVENT_MESSAGES.pageVoteReceivedUntitled,
            { amount, username: contributor },
            translator,
          );
    case "DONATION_RECEIVED":
      return translateMessage(
        EVENT_MESSAGES.donationReceived,
        {
          amount,
          username:
            usernameOf(event.contributor) ??
            translateMessage(EVENT_MESSAGES.anonymous, undefined, translator),
        },
        translator,
      );
    case "DONATION_SENT":
      return translateMessage(
        EVENT_MESSAGES.donationSent,
        { amount, username: payee },
        translator,
      );
    case "ENCRYPTED_CHAT_REQUEST":
      // Two rows per request, like PAGE_VOTE: the payer's own (read) record
      // and the recipient's invitation.
      if (readerIsActor(event)) {
        return translateMessage(
          EVENT_MESSAGES.encryptedChatRequestSent,
          { amount, username: payee },
          translator,
        );
      }
      return translateMessage(
        EVENT_MESSAGES.encryptedChatRequest,
        { amount, username: contributor },
        translator,
      );
    case "SUBSCRIPTION_RECEIVED":
      return translateMessage(
        EVENT_MESSAGES.subscriptionReceived,
        { amount, username: contributor },
        translator,
      );
    case "SUBSCRIPTION_SENT":
      return translateMessage(
        EVENT_MESSAGES.subscriptionSent,
        { amount, username: payee },
        translator,
      );
    case "BOUGHT_TUZI":
      return translateMessage(EVENT_MESSAGES.bought2Z, { amount }, translator);
    case "ZEC_PENDING":
      return translateMessage(
        EVENT_MESSAGES.zecPending,
        { amount },
        translator,
      );
    case "CHAT2Z":
      return translateMessage(EVENT_MESSAGES.chat2Z, { amount }, translator);
    case "PLATFORM_FEE":
      return translateMessage(
        EVENT_MESSAGES.platformFee,
        { amount },
        translator,
      );
    case "PAY_PER_VIEW_REVENUE":
      return translateMessage(
        EVENT_MESSAGES.payPerViewRevenue,
        { amount, username: contributor },
        translator,
      );
    case "PAY_PER_VIEW_SPEND":
      return translateMessage(
        EVENT_MESSAGES.payPerViewSpend,
        { amount, username: payee },
        translator,
      );
    default:
      return translateMessage(EVENT_MESSAGES.generic, undefined, translator);
  }
}
