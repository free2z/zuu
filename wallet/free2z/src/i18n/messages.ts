/**
 * The reviewed message-key surface for this bounded i18n slice. Catalog policy
 * compares every locale with these exact values, so an added catalog entry is
 * an orphan until application code declares it here and a removed entry is a
 * hard failure in every locale.
 *
 * Deliberately a copy of ZUULI's kernel shape rather than an import:
 * `wallet/zuuli/scripts/project-boundary.mjs` forbids one wallet application
 * from importing another (#904, #906).
 */
export const MESSAGE_KEYS = {
  appName: "app.name",
  appTagline: "app.tagline",
  articlesSearchAccessible: "articles.searchAccessible",
  authZcashPendingBody: "auth.zcashPending.body",
  authZcashPendingTitle: "auth.zcashPending.title",
  commonLoading: "common.loading",
  commonRetry: "common.retry",
  commonRetrying: "common.retrying",
  commonTryAgain: "common.tryAgain",
  creatorZecTipBlockedBody: "creator.zecTip.blocked.body",
  creatorZecTipBlockedTitle: "creator.zecTip.blocked.title",
  creatorZecTipDeclinedBody: "creator.zecTip.declined.body",
  creatorZecTipDeclinedTitle: "creator.zecTip.declined.title",
  creatorZecTipIndeterminateBody: "creator.zecTip.indeterminate.body",
  creatorZecTipIndeterminateTitle: "creator.zecTip.indeterminate.title",
  creatorZecTipSentBody: "creator.zecTip.sent.body",
  creatorZecTipSentTitle: "creator.zecTip.sent.title",
  creatorZecTipUnsentBody: "creator.zecTip.unsent.body",
  creatorZecTipUnsentTitle: "creator.zecTip.unsent.title",
  errorNotFoundBack: "error.notFound.back",
  errorNotFoundDescription: "error.notFound.description",
  errorNotFoundTitle: "error.notFound.title",
  fundBody: "fund.body",
  fundTitle: "fund.title",
  liveFailureEndedRoom: "live.failure.endedRoom",
  liveFailureExpiredTicket: "live.failure.expiredTicket",
  liveFailureLifecycleRace: "live.failure.lifecycleRace",
  liveFailureMalformedTicket: "live.failure.malformedTicket",
  liveFailureOffline: "live.failure.offline",
  liveFailurePolicy: "live.failure.policy",
  liveFailureReplayedTicket: "live.failure.replayedTicket",
  liveFailureTimeout: "live.failure.timeout",
  liveFailureTokenRejected: "live.failure.tokenRejected",
  liveFailureTransport: "live.failure.transport",
  liveFailureUnknown: "live.failure.unknown",
  liveStageConnecting: "live.stage.connecting",
  liveStageEnded: "live.stage.ended",
  liveStageHostRecoveryHint: "live.stage.hostRecoveryHint",
  liveStageReconnect: "live.stage.reconnect",
  liveStageRefreshingTicket: "live.stage.refreshingTicket",
  liveStageTryAgain: "live.stage.tryAgain",
  liveStageWaitingForConnection: "live.stage.waitingForConnection",
  navAccountMenu: "navigation.accountMenu",
  navAi: "navigation.ai",
  navAiAccessible: "navigation.aiAccessible",
  navApp: "navigation.app",
  navArticles: "navigation.articles",
  navBack: "navigation.back",
  navBuyTuzis: "navigation.buyTuzis",
  navBuyTuzisBalance: "navigation.buyTuzisBalance",
  navGroupAccount: "navigation.groups.account",
  navGroupExplore: "navigation.groups.explore",
  navGroupMoney: "navigation.groups.money",
  navLive: "navigation.live",
  navLogin: "navigation.login",
  navPrimary: "navigation.primary",
  navSearch: "navigation.search",
  navSearchAction: "navigation.searchAction",
  navSignOut: "navigation.signOut",
  searchAll: "search.all",
  searchClear: "search.clear",
} as const;

export type MessageKey = (typeof MESSAGE_KEYS)[keyof typeof MESSAGE_KEYS];

export const DECLARED_MESSAGE_KEYS: ReadonlySet<MessageKey> = new Set(
  Object.values(MESSAGE_KEYS),
);
