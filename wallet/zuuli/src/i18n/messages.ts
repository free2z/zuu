/**
 * The reviewed message-key surface for this bounded i18n slice. Catalog policy
 * compares every locale with these exact values, so an added catalog entry is
 * an orphan until application code declares it here and a removed entry is a
 * hard failure in every locale.
 */
export const MESSAGE_KEYS = {
  torTitle: "tor.title",
  torScope: "tor.scope",
  torEnable: "tor.enable",
  torDisable: "tor.disable",
  torReconnect: "tor.reconnect",
  torAdvanced: "tor.advanced",
  torDetails: "tor.details",
  torMobile: "tor.mobile",
  torEpoch: "tor.epoch",
  torDirect: "tor.direct",
  torWaiting: "tor.waiting",
  torProxyConnected: "tor.proxyConnected",
  torDegraded: "tor.degraded",
  torSuspended: "tor.suspended",
  torWeb: "tor.web",
  torLoading: "tor.loading",
  torError: "tor.error",

  commonLoading: "common.loading",
  commonPending: "common.pending",
  commonRetry: "common.retry",
  commonRetrying: "common.retrying",
  errorNotFoundBack: "error.notFound.back",
  errorNotFoundDescription: "error.notFound.description",
  errorNotFoundTitle: "error.notFound.title",
  legacyWalletDescription: "shell.legacyWallet.description",
  legacyWalletLabel: "shell.legacyWallet.label",
  legacyWalletTitle: "shell.legacyWallet.title",
  navAbout: "navigation.about",
  navAboutAccessible: "navigation.aboutAccessible",
  navAccountMenu: "navigation.accountMenu",
  navApp: "navigation.app",
  navBack: "navigation.back",
  navBuyTuzis: "navigation.buyTuzis",
  navBuyTuzisBalance: "navigation.buyTuzisBalance",
  navGroupAccount: "navigation.groups.account",
  navGroupMoney: "navigation.groups.money",
  navGroupOverview: "navigation.groups.overview",
  navHome: "navigation.home",
  navLogin: "navigation.login",
  navMore: "navigation.more",
  navMoreAccessible: "navigation.moreAccessible",
  navMoreDescription: "navigation.moreDescription",
  navMoreNavigation: "navigation.moreNavigation",
  navOpenWallet: "navigation.openWallet",
  navPrimary: "navigation.primary",
  navSignOut: "navigation.signOut",
  navWallet: "navigation.wallet",
  navWalletAccessible: "navigation.walletAccessible",
  navZcashLogin: "navigation.zcashLogin",
} as const;

export type MessageKey = (typeof MESSAGE_KEYS)[keyof typeof MESSAGE_KEYS];

export const DECLARED_MESSAGE_KEYS: readonly MessageKey[] = Object.freeze(
  Object.values(MESSAGE_KEYS),
);
