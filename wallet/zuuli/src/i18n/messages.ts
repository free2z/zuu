/**
 * The reviewed message-key surface for this bounded i18n slice. Catalog policy
 * compares every locale with these exact values, so an added catalog entry is
 * an orphan until application code declares it here and a removed entry is a
 * hard failure in every locale.
 */
export const MESSAGE_KEYS = {
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
  navAccountMenu: "navigation.accountMenu",
  navAi: "navigation.ai",
  navAiAccessible: "navigation.aiAccessible",
  navApp: "navigation.app",
  navArticles: "navigation.articles",
  navBack: "navigation.back",
  navBuyTuzis: "navigation.buyTuzis",
  navBuyTuzisBalance: "navigation.buyTuzisBalance",
  navEditProfile: "navigation.editProfile",
  navGroupAccount: "navigation.groups.account",
  navGroupExplore: "navigation.groups.explore",
  navGroupMoney: "navigation.groups.money",
  navGroupTools: "navigation.groups.tools",
  navHome: "navigation.home",
  navLive: "navigation.live",
  navLiveShort: "navigation.liveShort",
  navLogin: "navigation.login",
  navMessages: "navigation.messages",
  navMessagesAccessible: "navigation.messagesAccessible",
  navMore: "navigation.more",
  navMoreAccessible: "navigation.moreAccessible",
  navMoreDescription: "navigation.moreDescription",
  navMoreNavigation: "navigation.moreNavigation",
  navOpenWallet: "navigation.openWallet",
  navPrimary: "navigation.primary",
  navProfile: "navigation.profile",
  navProfileAccessible: "navigation.profileAccessible",
  navRevenueShare: "navigation.revenueShare",
  navSearch: "navigation.search",
  navSearchAction: "navigation.searchAction",
  navSearchPlaceholder: "navigation.searchPlaceholder",
  navSignOut: "navigation.signOut",
  navWallet: "navigation.wallet",
  navWalletAccessible: "navigation.walletAccessible",
  navZcashLogin: "navigation.zcashLogin",
} as const;

export type MessageKey = (typeof MESSAGE_KEYS)[keyof typeof MESSAGE_KEYS];

export const DECLARED_MESSAGE_KEYS: readonly MessageKey[] = Object.freeze(
  Object.values(MESSAGE_KEYS),
);
