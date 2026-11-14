/**
 * The declared message-key surface for the shipping ZUULI app. Catalog policy
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
  appAccountLinked: "app.accountLinked",
  appWelcomeToZUULI: "app.welcomeToZUULI",
  appFinishedSignInAfterReturningToThe: "app.finishedSignInAfterReturningToThe",
  appCouldnTFinishSignIn: "app.couldnTFinishSignIn",
  appPleaseTryAgain: "app.pleaseTryAgain",
  appCheckoutCancelled: "app.checkoutCancelled",
  appNoPaymentSuccessWasRecorded: "app.noPaymentSuccessWasRecorded",
  appMessage: "app.message",
  appMessage2: "app.message2",
  appPaymentProcessing: "app.paymentProcessing",
  appFree2ZCreditsYour2ZWhenStripeS: "app.free2ZCreditsYour2ZWhenStripeS",
  appCouldnTVerifyCheckoutReturn: "app.couldnTVerifyCheckoutReturn",
  appRefreshAndTryAgain: "app.refreshAndTryAgain",
  appCheckoutReturnUnavailable: "app.checkoutReturnUnavailable",
  appRestartZUULIAndTryAgain: "app.restartZUULIAndTryAgain",
  componentsBrandLogoBy2ZInc: "components.brand.logo.by2ZInc",
  componentsUiDialogClose: "components.ui.dialog.close",
  componentsLayoutLegacyWalletNoticePreviewBlocked:
    "components.layout.legacyWalletNotice.previewBlocked",
  componentsLayoutLegacyWalletNoticeNoEarlierWalletDataFound:
    "components.layout.legacyWalletNotice.noEarlierWalletDataFound",
  componentsLayoutLegacyWalletNoticePreviewUnavailableOnThisPlatform:
    "components.layout.legacyWalletNotice.previewUnavailableOnThisPlatform",
  componentsLayoutLegacyWalletNoticePreviewCouldNotBeCompleted:
    "components.layout.legacyWalletNotice.previewCouldNotBeCompleted",
  componentsLayoutLegacyWalletNoticeThePreservedWalletCouldNotBeInspected:
    "components.layout.legacyWalletNotice.thePreservedWalletCouldNotBeInspected",
  componentsLayoutLegacyWalletNoticeInspecting:
    "components.layout.legacyWalletNotice.inspecting",
  componentsLayoutLegacyWalletNoticeRetryPreview:
    "components.layout.legacyWalletNotice.retryPreview",
  componentsLayoutLegacyWalletNoticeInspectPreservedWallet:
    "components.layout.legacyWalletNotice.inspectPreservedWallet",
  featuresAuthIndexLogIn: "features.auth.index.logIn",
  featuresAuthIndexPassword: "features.auth.index.password",
  featuresAuthIndexHowItWorks: "features.auth.index.howItWorks",
  featuresAuthIndexContinueAsGuest: "features.auth.index.continueAsGuest",
  featuresAuthIndexGuest: "features.auth.index.guest",
  featuresAuthIndexChooseAnotherLoginMethod:
    "features.auth.index.chooseAnotherLoginMethod",
  featuresAuthIndexChooseAnotherMethod:
    "features.auth.index.chooseAnotherMethod",
  componentsCommonSocialButtonsMoreSignInOptionsComingSoon:
    "components.common.socialButtons.moreSignInOptionsComingSoon",
  componentsCommonSocialButtonsCouldnTCheckAccountLinkOptions:
    "components.common.socialButtons.couldnTCheckAccountLinkOptions",
  componentsCommonSocialButtonsCouldnTCheckSignInOptions:
    "components.common.socialButtons.couldnTCheckSignInOptions",
  componentsCommonSocialButtonsRetrying:
    "components.common.socialButtons.retrying",
  componentsCommonSocialButtonsRetry: "components.common.socialButtons.retry",
  componentsCommonSocialButtonsLinked: "components.common.socialButtons.linked",
  componentsCommonSocialButtonsThisIdentityIsNowLinkedToYour:
    "components.common.socialButtons.thisIdentityIsNowLinkedToYour",
  componentsCommonSocialButtonsWelcomeToZUULI:
    "components.common.socialButtons.welcomeToZUULI",
  componentsCommonSocialButtonsLoggedInWith:
    "components.common.socialButtons.loggedInWith",
  componentsCommonSocialButtonsCouldnTLinkThatAccount:
    "components.common.socialButtons.couldnTLinkThatAccount",
  componentsCommonSocialButtonsCouldnTLogIn:
    "components.common.socialButtons.couldnTLogIn",
  componentsCommonSocialButtonsPleaseTryAgain:
    "components.common.socialButtons.pleaseTryAgain",
  componentsCommonSocialButtonsLink: "components.common.socialButtons.link",
  componentsCommonSocialButtonsContinueWith:
    "components.common.socialButtons.continueWith",
  featuresAuthBrandPanelYourKeyIsYourIdentity:
    "features.auth.brandPanel.yourKeyIsYourIdentity",
  featuresAuthBrandPanelOneZcashKeySignsYouInEverywhere:
    "features.auth.brandPanel.oneZcashKeySignsYouInEverywhere",
  featuresAuthBrandPanelNoEmailNoPasswordNoKYC:
    "features.auth.brandPanel.noEmailNoPasswordNoKYC",
  featuresAuthBrandPanelNothingToPhishLeakOrResetThere:
    "features.auth.brandPanel.nothingToPhishLeakOrResetThere",
  featuresAuthBrandPanelW3CDIDZIP304Signatures:
    "features.auth.brandPanel.w3CDIDZIP304Signatures",
  featuresAuthBrandPanelOpenStandardsNotAProprietaryLoginYour:
    "features.auth.brandPanel.openStandardsNotAProprietaryLoginYour",
  featuresAuthBrandPanelAnonymousByDesign:
    "features.auth.brandPanel.anonymousByDesign",
  featuresAuthBrandPanelProveControlWithoutRevealingWhoYouAre:
    "features.auth.brandPanel.proveControlWithoutRevealingWhoYouAre",
  featuresAuthBrandPanelLogInYourWayIncludingWithJust:
    "features.auth.brandPanel.logInYourWayIncludingWithJust",
  featuresAuthBrandPanelWhyZcash: "features.auth.brandPanel.whyZcash",
  featuresAuthClassicLoginFormWelcomeBack:
    "features.auth.classicLoginForm.welcomeBack",
  featuresAuthClassicLoginFormLoggedInAs:
    "features.auth.classicLoginForm.loggedInAs",
  featuresAuthClassicLoginFormSignInFailedCheckYourDetails:
    "features.auth.classicLoginForm.signInFailedCheckYourDetails",
  featuresAuthClassicLoginFormEmailOrUsername:
    "features.auth.classicLoginForm.emailOrUsername",
  featuresAuthClassicLoginFormPassword:
    "features.auth.classicLoginForm.password",
  featuresAuthClassicLoginFormLoggingIn:
    "features.auth.classicLoginForm.loggingIn",
  featuresAuthClassicLoginFormLogIn: "features.auth.classicLoginForm.logIn",
  featuresAuthClassicLoginFormVerificationFailed:
    "features.auth.classicLoginForm.verificationFailed",
  featuresAuthClassicLoginFormTwoFactorAuthentication:
    "features.auth.classicLoginForm.twoFactorAuthentication",
  featuresAuthClassicLoginFormEnterThe6DigitCodeFromYour:
    "features.auth.classicLoginForm.enterThe6DigitCodeFromYour",
  featuresAuthClassicLoginFormAuthenticationCode:
    "features.auth.classicLoginForm.authenticationCode",
  featuresAuthClassicLoginFormVerifying:
    "features.auth.classicLoginForm.verifying",
  featuresAuthClassicLoginFormVerifyAndLogIn:
    "features.auth.classicLoginForm.verifyAndLogIn",
  featuresAuthClassicLoginFormUseADifferentAccount:
    "features.auth.classicLoginForm.useADifferentAccount",
  featuresAuthZcashLoginFlowYourKeySignsAOneTimeChallenge:
    "features.auth.zcashLoginFlow.yourKeySignsAOneTimeChallenge",
  featuresAuthZcashLoginFlowContinue: "features.auth.zcashLoginFlow.continue",
  featuresAuthZcashLoginFlowBackUpYourRecoveryPhrase:
    "features.auth.zcashLoginFlow.backUpYourRecoveryPhrase",
  featuresAuthZcashLoginFlowThisIdentityWasCreatedButItsRequired:
    "features.auth.zcashLoginFlow.thisIdentityWasCreatedButItsRequired",
  featuresAuthZcashLoginFlowOpeningSecureBackup:
    "features.auth.zcashLoginFlow.openingSecureBackup",
  featuresAuthZcashLoginFlowRevealRecoveryPhrase:
    "features.auth.zcashLoginFlow.revealRecoveryPhrase",
  featuresAuthZcashLoginFlowNoZcashIdentityOnThisDevice:
    "features.auth.zcashLoginFlow.noZcashIdentityOnThisDevice",
  featuresAuthZcashLoginFlowRestoreTheKeyAlreadyLinkedToYour:
    "features.auth.zcashLoginFlow.restoreTheKeyAlreadyLinkedToYour",
  featuresAuthZcashLoginFlowUseExistingIdentity:
    "features.auth.zcashLoginFlow.useExistingIdentity",
  featuresAuthZcashLoginFlowOr: "features.auth.zcashLoginFlow.or",
  featuresAuthZcashLoginFlowANewKeyCreatesADistinctIdentity:
    "features.auth.zcashLoginFlow.aNewKeyCreatesADistinctIdentity",
  featuresAuthZcashLoginFlowCreatingIdentity:
    "features.auth.zcashLoginFlow.creatingIdentity",
  featuresAuthZcashLoginFlowCreateNewIdentity:
    "features.auth.zcashLoginFlow.createNewIdentity",
  featuresAuthZcashLoginFlowIdentityVerified:
    "features.auth.zcashLoginFlow.identityVerified",
  featuresAuthZcashLoginFlowLoggingYouInToZUULI:
    "features.auth.zcashLoginFlow.loggingYouInToZUULI",
  featuresAuthZcashLoginFlowSigningAs: "features.auth.zcashLoginFlow.signingAs",
  featuresAuthZcashLoginFlowLoginProgress:
    "features.auth.zcashLoginFlow.loginProgress",
  featuresAuthZcashLoginFlowWorking: "features.auth.zcashLoginFlow.working",
  featuresAuthZcashLoginFlowTheLoginCouldNotBeCompleted:
    "features.auth.zcashLoginFlow.theLoginCouldNotBeCompleted",
  featuresAuthZcashLoginFlowTryAgain: "features.auth.zcashLoginFlow.tryAgain",
  featuresAuthSeedRevealThisRecoveryPhraseIsYourIdentity:
    "features.auth.seedReveal.thisRecoveryPhraseIsYourIdentity",
  featuresAuthSeedRevealWriteTheseWordsDownInOrderAnd:
    "features.auth.seedReveal.writeTheseWordsDownInOrderAnd",
  featuresAuthSeedRevealRevealRecoveryPhrase:
    "features.auth.seedReveal.revealRecoveryPhrase",
  featuresAuthSeedRevealTapToReveal: "features.auth.seedReveal.tapToReveal",
  featuresAuthSeedRevealNeverShareThisNoOneFrom2Z:
    "features.auth.seedReveal.neverShareThisNoOneFrom2Z",
  featuresAuthSeedRevealHide: "features.auth.seedReveal.hide",
  featuresAuthSeedRevealIHaveWrittenDownMyRecoveryPhrase:
    "features.auth.seedReveal.iHaveWrittenDownMyRecoveryPhrase",
  featuresAuthSeedRevealSavingConfirmation:
    "features.auth.seedReveal.savingConfirmation",
  featuresAuthSeedRevealISavedItContinue:
    "features.auth.seedReveal.iSavedItContinue",
  featuresAuthRestoreIdentityEnterYourRecoveryPhrase:
    "features.auth.restoreIdentity.enterYourRecoveryPhrase",
  featuresAuthRestoreIdentityARecoveryPhraseMustHave1215:
    "features.auth.restoreIdentity.aRecoveryPhraseMustHave1215",
  featuresAuthRestoreIdentityEnterAValidBirthdayHeight:
    "features.auth.restoreIdentity.enterAValidBirthdayHeight",
  featuresAuthRestoreIdentityBackToIdentityChoices:
    "features.auth.restoreIdentity.backToIdentityChoices",
  featuresAuthRestoreIdentityUseExistingIdentity:
    "features.auth.restoreIdentity.useExistingIdentity",
  featuresAuthRestoreIdentityRestoreLocallyWithYourRecoveryPhrase:
    "features.auth.restoreIdentity.restoreLocallyWithYourRecoveryPhrase",
  featuresAuthRestoreIdentityRecoveryPhrase:
    "features.auth.restoreIdentity.recoveryPhrase",
  featuresAuthRestoreIdentityHide: "features.auth.restoreIdentity.hide",
  featuresAuthRestoreIdentityShow: "features.auth.restoreIdentity.show",
  featuresAuthRestoreIdentityWordsSeparatedBySpaces:
    "features.auth.restoreIdentity.wordsSeparatedBySpaces",
  featuresAuthRestoreIdentityNeverSentToFree2z:
    "features.auth.restoreIdentity.neverSentToFree2z",
  featuresAuthRestoreIdentitySupportedPhrasesUsuallyHave121518:
    "features.auth.restoreIdentity.supportedPhrasesUsuallyHave121518",
  featuresAuthRestoreIdentityBirthdayHeightOptional:
    "features.auth.restoreIdentity.birthdayHeightOptional",
  featuresAuthRestoreIdentityFasterWalletScan:
    "features.auth.restoreIdentity.fasterWalletScan",
  featuresAuthRestoreIdentityRestoringIdentity:
    "features.auth.restoreIdentity.restoringIdentity",
  featuresAuthRestoreIdentityRestoreAndContinue:
    "features.auth.restoreIdentity.restoreAndContinue",
  featuresAuthRestoreIdentityExternalWalletSigningIsnTSupportedYet:
    "features.auth.restoreIdentity.externalWalletSigningIsnTSupportedYet",
  featuresAuthUseZcashLoginPreparingYourIdentity:
    "features.auth.useZcashLogin.preparingYourIdentity",
  featuresAuthUseZcashLoginLocatingTheZcashKeyThatWillRepresent:
    "features.auth.useZcashLogin.locatingTheZcashKeyThatWillRepresent",
  featuresAuthUseZcashLoginRequestingAChallenge:
    "features.auth.useZcashLogin.requestingAChallenge",
  featuresAuthUseZcashLoginAskingFree2zForAOneTimeTimestamped:
    "features.auth.useZcashLogin.askingFree2zForAOneTimeTimestamped",
  featuresAuthUseZcashLoginSigningWithYourKey:
    "features.auth.useZcashLogin.signingWithYourKey",
  featuresAuthUseZcashLoginProducingAZIP304SignatureOverThe:
    "features.auth.useZcashLogin.producingAZIP304SignatureOverThe",
  featuresAuthUseZcashLoginVerifying: "features.auth.useZcashLogin.verifying",
  featuresAuthUseZcashLoginFree2zChecksTheSignatureAgainstYourAddress:
    "features.auth.useZcashLogin.free2zChecksTheSignatureAgainstYourAddress",
  featuresAuthUseZcashLoginFree2zCouldnTVerifyYourZcashSignature:
    "features.auth.useZcashLogin.free2zCouldnTVerifyYourZcashSignature",
  featuresAuthUseZcashLoginWelcomeToZUULI:
    "features.auth.useZcashLogin.welcomeToZUULI",
  featuresAuthUseZcashLoginLoggedInWithYourZcashKey:
    "features.auth.useZcashLogin.loggedInWithYourZcashKey",
  featuresAuthUseZcashChallengeFlowSomethingWentWrongPleaseTryAgain:
    "features.auth.useZcashChallengeFlow.somethingWentWrongPleaseTryAgain",
  featuresAuthUseZcashChallengeFlowCouldnTReachFree2zToStartThe:
    "features.auth.useZcashChallengeFlow.couldnTReachFree2zToStartThe",
  featuresAuthUseZcashChallengeFlowRecoveredIdentity:
    "features.auth.useZcashChallengeFlow.recoveredIdentity",
  featuresAuthUseZcashChallengeFlowCouldnTRestoreThisIdentityCheckThe:
    "features.auth.useZcashChallengeFlow.couldnTRestoreThisIdentityCheckThe",
  featuresAuthZShieldInfoYourAddressIsADID:
    "features.auth.zShieldInfo.yourAddressIsADID",
  featuresAuthZShieldInfoAnyZcashAddressMapsToAW3C:
    "features.auth.zShieldInfo.anyZcashAddressMapsToAW3C",
  featuresAuthZShieldInfoYouProveControlBySigning:
    "features.auth.zShieldInfo.youProveControlBySigning",
  featuresAuthZShieldInfoToLogInYouSignAFresh:
    "features.auth.zShieldInfo.toLogInYouSignAFresh",
  featuresAuthZShieldInfoNoThirdPartyInTheLoop:
    "features.auth.zShieldInfo.noThirdPartyInTheLoop",
  featuresAuthZShieldInfoFree2zVerifiesTheSignatureAgainstYourAddress:
    "features.auth.zShieldInfo.free2zVerifiesTheSignatureAgainstYourAddress",
  featuresAuthZShieldInfoZShieldYourKeyIsYourIdentity:
    "features.auth.zShieldInfo.zShieldYourKeyIsYourIdentity",
  featuresAuthZShieldInfoLoginWithZcashReplacesPasswordsAndEmail:
    "features.auth.zShieldInfo.loginWithZcashReplacesPasswordsAndEmail",
  featuresHomeHeroWelcomeBack: "features.home.hero.welcomeBack",
  featuresHomeHeroWelcomeToZUULI: "features.home.hero.welcomeToZUULI",
  featuresHomeHeroYourVault: "features.home.hero.yourVault",
  featuresHomeHeroYourSeedAndYourSpendingKeysLive:
    "features.home.hero.yourSeedAndYourSpendingKeysLive",
  featuresHomeHero2ZBalance: "features.home.hero.tuziBalance",
  featuresHomeHero2ZBalanceBuyMore2Z: "features.home.hero.tuziBalanceBuyMore2Z",
  featuresHomeHeroZECSpendable: "features.home.hero.zECSpendable",
  featuresHomeHeroZEC: "features.home.hero.zEC",
  featuresHomeHeroZECSpendableOpenWallet:
    "features.home.hero.zECSpendableOpenWallet",
  featuresHomeVaultActionsSend: "features.home.vaultActions.send",
  featuresHomeVaultActionsShieldedZECWithAnOptionalEncryptedMemo:
    "features.home.vaultActions.shieldedZECWithAnOptionalEncryptedMemo",
  featuresHomeVaultActionsReceive: "features.home.vaultActions.receive",
  featuresHomeVaultActionsShareYourUnifiedAddressToGetPaid:
    "features.home.vaultActions.shareYourUnifiedAddressToGetPaid",
  featuresHomeVaultActionsHistory: "features.home.vaultActions.history",
  featuresHomeVaultActionsEveryPaymentInAndOutOfThis:
    "features.home.vaultActions.everyPaymentInAndOutOfThis",
  featuresHomeVaultActionsFund: "features.home.vaultActions.fund",
  featuresHomeVaultActionsAdd2ZsWithACardOrTop:
    "features.home.vaultActions.add2ZsWithACardOrTop",
  featuresHomeVaultActionsYourWallet: "features.home.vaultActions.yourWallet",
  featuresHomePartsViewAll: "features.home.parts.viewAll",
  featuresWalletIndexOverview: "features.wallet.index.overview",
  featuresWalletIndexSend: "features.wallet.index.send",
  featuresWalletIndexReceive: "features.wallet.index.receive",
  featuresWalletIndexHistory: "features.wallet.index.history",
  featuresWalletIndexFund: "features.wallet.index.fund",
  featuresWalletIndexWalletSections: "features.wallet.index.walletSections",
  featuresWalletIndexWalletCleanupStatus:
    "features.wallet.index.walletCleanupStatus",
  featuresWalletIndexWalletMaintenanceNeedsAttention:
    "features.wallet.index.walletMaintenanceNeedsAttention",
  featuresWalletIndexWalletMaintenanceNeedsAnotherPass:
    "features.wallet.index.walletMaintenanceNeedsAnotherPass",
  featuresWalletIndexWalletMaintenanceCompletedWithARecoveryNote:
    "features.wallet.index.walletMaintenanceCompletedWithARecoveryNote",
  featuresWalletIndexTechnicalDetails: "features.wallet.index.technicalDetails",
  featuresWalletIndexRetrying: "features.wallet.index.retrying",
  featuresWalletIndexRetryNow: "features.wallet.index.retryNow",
  featuresWalletIndexWallet: "features.wallet.index.wallet",
  featuresWalletIndexYourZcashShieldedByDefault:
    "features.wallet.index.yourZcashShieldedByDefault",
  featuresWalletIndexSendShieldedZECWithAnOptionalEncrypted:
    "features.wallet.index.sendShieldedZECWithAnOptionalEncrypted",
  featuresWalletIndexTipWithZEC: "features.wallet.index.tipWithZEC",
  featuresWalletIndexReviewACreatorPaymentThroughWalletSend:
    "features.wallet.index.reviewACreatorPaymentThroughWalletSend",
  featuresWalletIndexShareYourUnifiedAddressToGetPaid:
    "features.wallet.index.shareYourUnifiedAddressToGetPaid",
  featuresWalletIndexEveryPaymentInAndOutOfThis:
    "features.wallet.index.everyPaymentInAndOutOfThis",
  featuresWalletIndexAdd2ZsForTipsAIAndMemberships:
    "features.wallet.index.add2ZsForTipsAIAndMemberships",
  featuresWalletOverviewSpendableBalance:
    "features.wallet.overview.spendableBalance",
  featuresWalletOverviewPending: "features.wallet.overview.pending",
  featuresWalletOverviewTotalShielded: "features.wallet.overview.totalShielded",
  featuresWalletOverviewSend: "features.wallet.overview.send",
  featuresWalletOverviewReceive: "features.wallet.overview.receive",
  featuresWalletOverviewRecentActivity:
    "features.wallet.overview.recentActivity",
  featuresWalletOverviewCouldnTLoadRecentActivity:
    "features.wallet.overview.couldnTLoadRecentActivity",
  featuresWalletOverviewCouldnTRefreshRecentActivity:
    "features.wallet.overview.couldnTRefreshRecentActivity",
  featuresWalletOverviewYourTransactionHistoryIsTemporarilyUnavailable:
    "features.wallet.overview.yourTransactionHistoryIsTemporarilyUnavailable",
  featuresWalletOverviewShowingTheLastTransactionHistoryLoadedOn:
    "features.wallet.overview.showingTheLastTransactionHistoryLoadedOn",
  featuresWalletOverviewNoTransactionsYet:
    "features.wallet.overview.noTransactionsYet",
  featuresWalletOverviewOnceYouSendOrReceiveZECYour:
    "features.wallet.overview.onceYouSendOrReceiveZECYour",
  featuresWalletSharedCopiedToClipboard:
    "features.wallet.shared.copiedToClipboard",
  featuresWalletSharedCouldnTCopyClipboardUnavailable:
    "features.wallet.shared.couldnTCopyClipboardUnavailable",
  featuresWalletSharedCopy: "features.wallet.shared.copy",
  featuresWalletSharedCopied: "features.wallet.shared.copied",
  featuresWalletComponentsSynced: "features.wallet.components.synced",
  featuresWalletComponentsSyncTroubleRetrying:
    "features.wallet.components.syncTroubleRetrying",
  featuresWalletComponentsConnecting: "features.wallet.components.connecting",
  featuresWalletComponentsSyncing: "features.wallet.components.syncing",
  featuresWalletComponentsWaitingForChainTip:
    "features.wallet.components.waitingForChainTip",
  featuresWalletComponentsChainSyncProgress:
    "features.wallet.components.chainSyncProgress",
  featuresWalletComponentsUnifiedAddressQRCode:
    "features.wallet.components.unifiedAddressQRCode",
  featuresWalletComponentsYourUnifiedAddress:
    "features.wallet.components.yourUnifiedAddress",
  featuresWalletComponentsAddressCopied:
    "features.wallet.components.addressCopied",
  featuresWalletComponentsCopyUnifiedAddress:
    "features.wallet.components.copyUnifiedAddress",
  featuresWalletComponentsReceived: "features.wallet.components.received",
  featuresWalletComponentsSent: "features.wallet.components.sent",
  featuresWalletComponentsPending: "features.wallet.components.pending",
  featuresWalletComponentsViewAll: "features.wallet.components.viewAll",
  featuresWalletSendCreatorZECTipUnavailable:
    "features.wallet.send.creatorZECTipUnavailable",
  featuresWalletSendTheCreatorPaymentDetailsCouldNotBe:
    "features.wallet.send.theCreatorPaymentDetailsCouldNotBe",
  featuresWalletSendReturnToTheCreatorProfileAndStart:
    "features.wallet.send.returnToTheCreatorProfileAndStart",
  featuresWalletSendBrowseCreators: "features.wallet.send.browseCreators",
  featuresWalletSendCouldnTLoadPendingPaymentState:
    "features.wallet.send.couldnTLoadPendingPaymentState",
  featuresWalletSendPaymentRequestLoaded:
    "features.wallet.send.paymentRequestLoaded",
  featuresWalletSendCouldnTReadThatPaymentLink:
    "features.wallet.send.couldnTReadThatPaymentLink",
  featuresWalletSendCouldnTBuildTheTransaction:
    "features.wallet.send.couldnTBuildTheTransaction",
  featuresWalletSendTransactionSent: "features.wallet.send.transactionSent",
  featuresWalletSendPaymentSentBalanceRefreshIsStillPending:
    "features.wallet.send.paymentSentBalanceRefreshIsStillPending",
  featuresWalletSendBroadcastStatusUnknown:
    "features.wallet.send.broadcastStatusUnknown",
  featuresWalletSendRetryingWillRebroadcastTheSameTransactionSafely:
    "features.wallet.send.retryingWillRebroadcastTheSameTransactionSafely",
  featuresWalletSendTransactionRejected:
    "features.wallet.send.transactionRejected",
  featuresWalletSendTheServerRejectedThisTransaction:
    "features.wallet.send.theServerRejectedThisTransaction",
  featuresWalletSendSendFailed: "features.wallet.send.sendFailed",
  featuresWalletSendTransactionBroadcastConfirmed:
    "features.wallet.send.transactionBroadcastConfirmed",
  featuresWalletSendBroadcastIsStillUnresolved:
    "features.wallet.send.broadcastIsStillUnresolved",
  featuresWalletSendNoReplacementPaymentWasCreated:
    "features.wallet.send.noReplacementPaymentWasCreated",
  featuresWalletSendTransactionExpiredWithoutBeingFound:
    "features.wallet.send.transactionExpiredWithoutBeingFound",
  featuresWalletSendItIsSafeToReviewANew:
    "features.wallet.send.itIsSafeToReviewANew",
  featuresWalletSendCouldnTRetryThePendingTransaction:
    "features.wallet.send.couldnTRetryThePendingTransaction",
  featuresWalletSendOnlyContinueIfYouCheckedWalletHistory:
    "features.wallet.send.onlyContinueIfYouCheckedWalletHistory",
  featuresWalletSendRecoveryLockDiscardedAfterWalletHistoryConfirmation:
    "features.wallet.send.recoveryLockDiscardedAfterWalletHistoryConfirmation",
  featuresWalletSendCouldnTDiscardRecoveryState:
    "features.wallet.send.couldnTDiscardRecoveryState",
  featuresWalletSendCheckingWalletRecovery:
    "features.wallet.send.checkingWalletRecovery",
  featuresWalletSendWalletRecoveryStateUnavailable:
    "features.wallet.send.walletRecoveryStateUnavailable",
  featuresWalletSendReturnToWalletSendAndResolveRecovery:
    "features.wallet.send.returnToWalletSendAndResolveRecovery",
  featuresWalletSendCheckingForAnEarlierPayment:
    "features.wallet.send.checkingForAnEarlierPayment",
  featuresWalletSendSendZEC: "features.wallet.send.sendZEC",
  featuresWalletSendZECTipFor: "features.wallet.send.zECTipFor",
  featuresWalletSendTheCreatorDestinationIsLockedFromThe:
    "features.wallet.send.theCreatorDestinationIsLockedFromThe",
  featuresWalletSendAPreviousBroadcastIsUnresolved:
    "features.wallet.send.aPreviousBroadcastIsUnresolved",
  featuresWalletSendTransactionCreationWasInterruptedAndExactRetry:
    "features.wallet.send.transactionCreationWasInterruptedAndExactRetry",
  featuresWalletSendTheRecoveryJournalCouldNotBeDecoded:
    "features.wallet.send.theRecoveryJournalCouldNotBeDecoded",
  featuresWalletSendZUULIRecoveredTheExactTransactionAfterRestart:
    "features.wallet.send.zUULIRecoveredTheExactTransactionAfterRestart",
  featuresWalletSendRecipientAddress: "features.wallet.send.recipientAddress",
  featuresWalletSendU1Zs1T1OrPasteAZcash:
    "features.wallet.send.u1Zs1T1OrPasteAZcash",
  featuresWalletSendCheckingAddress: "features.wallet.send.checkingAddress",
  featuresWalletSendNotARecognizableZcashAddress:
    "features.wallet.send.notARecognizableZcashAddress",
  featuresWalletSendTransparentZECTip: "features.wallet.send.transparentZECTip",
  featuresWalletSendThisPaymentWillBePubliclyVisibleOn:
    "features.wallet.send.thisPaymentWillBePubliclyVisibleOn",
  featuresWalletSendAmount: "features.wallet.send.amount",
  featuresWalletSendMax: "features.wallet.send.max",
  featuresWalletSendEnterAPositiveZECAmountWithNo:
    "features.wallet.send.enterAPositiveZECAmountWithNo",
  featuresWalletSendAmountPlusNetworkFeeExceedsSpendableBalance:
    "features.wallet.send.amountPlusNetworkFeeExceedsSpendableBalance",
  featuresWalletSendMemoOptional: "features.wallet.send.memoOptional",
  featuresWalletSendEncryptedNoteDeliveredWithThePayment:
    "features.wallet.send.encryptedNoteDeliveredWithThePayment",
  featuresWalletSendThisAddressTypeCanTReceiveMemos:
    "features.wallet.send.thisAddressTypeCanTReceiveMemos",
  featuresWalletSendMemosAreEncryptedAndOnlyVisibleTo:
    "features.wallet.send.memosAreEncryptedAndOnlyVisibleTo",
  featuresWalletSendUnlocking: "features.wallet.send.unlocking",
  featuresWalletSendICheckedHistoryUnlockSends:
    "features.wallet.send.iCheckedHistoryUnlockSends",
  featuresWalletSendRecoveryDataLocked:
    "features.wallet.send.recoveryDataLocked",
  featuresWalletSendRetryingExactTransaction:
    "features.wallet.send.retryingExactTransaction",
  featuresWalletSendRetryRecoveredTransaction:
    "features.wallet.send.retryRecoveredTransaction",
  featuresWalletSendResumePendingBroadcast:
    "features.wallet.send.resumePendingBroadcast",
  featuresWalletSendPreparingProvingData:
    "features.wallet.send.preparingProvingData",
  featuresWalletSendBuilding: "features.wallet.send.building",
  featuresWalletSendReviewPayment: "features.wallet.send.reviewPayment",
  featuresWalletSendConfirmPayment: "features.wallet.send.confirmPayment",
  featuresWalletSendReviewTheDetailsBeforeBroadcastingThisCan:
    "features.wallet.send.reviewTheDetailsBeforeBroadcastingThisCan",
  featuresWalletSendCreatorTipFor: "features.wallet.send.creatorTipFor",
  featuresWalletSendTo: "features.wallet.send.to",
  featuresWalletSendNetworkFee: "features.wallet.send.networkFee",
  featuresWalletSendMemo: "features.wallet.send.memo",
  featuresWalletSendNone: "features.wallet.send.none",
  featuresWalletSendNetwork: "features.wallet.send.network",
  featuresWalletSendChange: "features.wallet.send.change",
  featuresWalletSendShieldedAutomatically:
    "features.wallet.send.shieldedAutomatically",
  featuresWalletSendTotal: "features.wallet.send.total",
  featuresWalletSendBroadcastRejected: "features.wallet.send.broadcastRejected",
  featuresWalletSendCancel: "features.wallet.send.cancel",
  featuresWalletSendSending: "features.wallet.send.sending",
  featuresWalletSendConfirmSend: "features.wallet.send.confirmSend",
  featuresWalletReceiveReceiveZEC: "features.wallet.receive.receiveZEC",
  featuresWalletReceiveShareThisUnifiedAddressToGetPaid:
    "features.wallet.receive.shareThisUnifiedAddressToGetPaid",
  featuresWalletReceiveUnifiedAddressQRCode:
    "features.wallet.receive.unifiedAddressQRCode",
  featuresWalletReceiveAddressCopied: "features.wallet.receive.addressCopied",
  featuresWalletReceiveCopyUnifiedAddress:
    "features.wallet.receive.copyUnifiedAddress",
  featuresWalletReceiveUnifiedAddressesReceiveShieldedZECAndSupport:
    "features.wallet.receive.unifiedAddressesReceiveShieldedZECAndSupport",
  featuresWalletHistoryCouldnTLoadTransactionHistory:
    "features.wallet.history.couldnTLoadTransactionHistory",
  featuresWalletHistoryYourTransactionHistoryIsTemporarilyUnavailable:
    "features.wallet.history.yourTransactionHistoryIsTemporarilyUnavailable",
  featuresWalletHistoryCouldnTRefreshTransactionHistory:
    "features.wallet.history.couldnTRefreshTransactionHistory",
  featuresWalletHistoryShowingTheLastTransactionHistoryLoadedOn:
    "features.wallet.history.showingTheLastTransactionHistoryLoadedOn",
  featuresWalletHistoryNoTransactionsYet:
    "features.wallet.history.noTransactionsYet",
  featuresWalletHistorySendOrReceiveZECAndEveryTransaction:
    "features.wallet.history.sendOrReceiveZECAndEveryTransaction",
  featuresWalletHistoryReceived: "features.wallet.history.received",
  featuresWalletHistorySent: "features.wallet.history.sent",
  featuresWalletHistoryPending: "features.wallet.history.pending",
  featuresWalletHistoryTransactionIDCopied:
    "features.wallet.history.transactionIDCopied",
  featuresWalletHistoryCopyTransactionID:
    "features.wallet.history.copyTransactionID",
  featuresWalletOnboardingWalletBackupUnavailable:
    "features.wallet.onboarding.walletBackupUnavailable",
  featuresWalletOnboardingZUULICouldNotVerifyWhichWalletNeeds:
    "features.wallet.onboarding.zUULICouldNotVerifyWhichWalletNeeds",
  featuresWalletOnboardingRetryWalletIdentity:
    "features.wallet.onboarding.retryWalletIdentity",
  featuresWalletOnboardingWalletIdentityUnavailable:
    "features.wallet.onboarding.walletIdentityUnavailable",
  featuresWalletOnboardingZUULICouldNotVerifyWhetherAWallet:
    "features.wallet.onboarding.zUULICouldNotVerifyWhetherAWallet",
  featuresWalletOnboardingSetUpYourZcashWallet:
    "features.wallet.onboarding.setUpYourZcashWallet",
  featuresWalletOnboardingCreateABrandNewShieldedWalletOr:
    "features.wallet.onboarding.createABrandNewShieldedWalletOr",
  featuresWalletOnboardingCreateNew: "features.wallet.onboarding.createNew",
  featuresWalletOnboardingRestore: "features.wallet.onboarding.restore",
  featuresWalletOnboardingCouldnTCreateWallet:
    "features.wallet.onboarding.couldnTCreateWallet",
  featuresWalletOnboardingCreateANewWallet:
    "features.wallet.onboarding.createANewWallet",
  featuresWalletOnboardingNewWalletsAlwaysUseA24Word:
    "features.wallet.onboarding.newWalletsAlwaysUseA24Word",
  featuresWalletOnboardingCreateWallet:
    "features.wallet.onboarding.createWallet",
  featuresWalletOnboardingARecoveryPhraseMustHave1215:
    "features.wallet.onboarding.aRecoveryPhraseMustHave1215",
  featuresWalletOnboardingBirthdayHeightMustBeAPositiveNumber:
    "features.wallet.onboarding.birthdayHeightMustBeAPositiveNumber",
  featuresWalletOnboardingWalletRestored:
    "features.wallet.onboarding.walletRestored",
  featuresWalletOnboardingRestoreFailed:
    "features.wallet.onboarding.restoreFailed",
  featuresWalletOnboardingRestoreFromSeedPhrase:
    "features.wallet.onboarding.restoreFromSeedPhrase",
  featuresWalletOnboardingRecoveryPhrase:
    "features.wallet.onboarding.recoveryPhrase",
  featuresWalletOnboardingHide: "features.wallet.onboarding.hide",
  featuresWalletOnboardingShow: "features.wallet.onboarding.show",
  featuresWalletOnboardingEnterYourRecoveryPhraseSeparatedBySpaces:
    "features.wallet.onboarding.enterYourRecoveryPhraseSeparatedBySpaces",
  featuresWalletOnboardingSecuringRecoveryPhraseEntry:
    "features.wallet.onboarding.securingRecoveryPhraseEntry",
  featuresWalletOnboardingRetry: "features.wallet.onboarding.retry",
  featuresWalletOnboardingWordsAreNeverSentAnywhereButThe:
    "features.wallet.onboarding.wordsAreNeverSentAnywhereButThe",
  featuresWalletOnboardingBirthdayHeightOptional:
    "features.wallet.onboarding.birthdayHeightOptional",
  featuresWalletOnboardingEG2600000: "features.wallet.onboarding.eG2600000",
  featuresWalletOnboardingTheBlockHeightTheWalletWasCreated:
    "features.wallet.onboarding.theBlockHeightTheWalletWasCreated",
  featuresWalletOnboardingRestoreWallet:
    "features.wallet.onboarding.restoreWallet",
  featuresWalletOnboardingCouldnTRevealRecoveryPhrase:
    "features.wallet.onboarding.couldnTRevealRecoveryPhrase",
  featuresWalletOnboardingCouldnTSaveBackupConfirmation:
    "features.wallet.onboarding.couldnTSaveBackupConfirmation",
  featuresWalletOnboardingBackUpYourRecoveryPhrase:
    "features.wallet.onboarding.backUpYourRecoveryPhrase",
  featuresWalletOnboardingAuthenticateThenWriteTheRecoveryWordsDown:
    "features.wallet.onboarding.authenticateThenWriteTheRecoveryWordsDown",
  featuresWalletOnboardingThisPhraseIsTheOnlyBackupOf:
    "features.wallet.onboarding.thisPhraseIsTheOnlyBackupOf",
  featuresWalletOnboardingAuthenticating:
    "features.wallet.onboarding.authenticating",
  featuresWalletOnboardingAuthenticateToRevealPhrase:
    "features.wallet.onboarding.authenticateToRevealPhrase",
  featuresWalletOnboardingBirthdayHeight:
    "features.wallet.onboarding.birthdayHeight",
  featuresWalletOnboardingHidePhrase: "features.wallet.onboarding.hidePhrase",
  featuresWalletOnboardingIVeWrittenDownMyRecoveryPhrase:
    "features.wallet.onboarding.iVeWrittenDownMyRecoveryPhrase",
  featuresWalletOnboardingIVeSavedItOpenMyWallet:
    "features.wallet.onboarding.iVeSavedItOpenMyWallet",
  featuresWalletFundingIndexWalletFunding:
    "features.wallet.funding.index.walletFunding",
  featuresWalletFundingIndexBuyOrSend2ZsAndReviewActivity:
    "features.wallet.funding.index.buyOrSend2ZsAndReviewActivity",
  featuresWalletFundingIndexBuy: "features.wallet.funding.index.buy",
  featuresWalletFundingIndexSendTip: "features.wallet.funding.index.sendTip",
  featuresWalletFundingIndexActivity: "features.wallet.funding.index.activity",
  featuresWalletFundingBalanceHero2ZBalance:
    "features.wallet.funding.balanceHero.tuziBalance",
  featuresWalletFundingBalanceHeroSpendablePlatformCredit:
    "features.wallet.funding.balanceHero.spendablePlatformCredit",
  featuresWalletFundingBalanceHeroZECInWallet:
    "features.wallet.funding.balanceHero.zECInWallet",
  featuresWalletFundingBalanceHeroSpendable:
    "features.wallet.funding.balanceHero.spendable",
  featuresWalletFundingBalanceHeroFund2ZsInstantly:
    "features.wallet.funding.balanceHero.fund2ZsInstantly",
  featuresWalletFundingBuyTabOpeningSecureCheckout:
    "features.wallet.funding.buyTab.openingSecureCheckout",
  featuresWalletFundingBuyTabCompleteYourPurchaseWithStripe:
    "features.wallet.funding.buyTab.completeYourPurchaseWithStripe",
  featuresWalletFundingBuyTabDemoAdded:
    "features.wallet.funding.buyTab.demoAdded",
  featuresWalletFundingBuyTabLocalMockBalanceOnlyNoZECWas:
    "features.wallet.funding.buyTab.localMockBalanceOnlyNoZECWas",
  featuresWalletFundingBuyTabChooseAnAmount:
    "features.wallet.funding.buyTab.chooseAnAmount",
  featuresWalletFundingBuyTab2ZsNeverExpireAndPowerAITips:
    "features.wallet.funding.buyTab.tuzisNeverExpireAndPowerAITips",
  featuresWalletFundingBuyTabBuyFor: "features.wallet.funding.buyTab.buyFor",
  featuresWalletFundingBuyTabCustomAmount2Z:
    "features.wallet.funding.buyTab.customAmount2Z",
  featuresWalletFundingBuyTabEG: "features.wallet.funding.buyTab.eG",
  featuresWalletFundingBuyTabMax2ZPerPurchase:
    "features.wallet.funding.buyTab.max2ZPerPurchase",
  featuresWalletFundingBuyTabEnterAPositiveWhole2ZAmountE:
    "features.wallet.funding.buyTab.enterAPositiveWhole2ZAmountE",
  featuresWalletFundingBuyTabYouPay: "features.wallet.funding.buyTab.youPay",
  featuresWalletFundingBuyTabPayWithCard:
    "features.wallet.funding.buyTab.payWithCard",
  featuresWalletFundingBuyTabLogInToBuy:
    "features.wallet.funding.buyTab.logInToBuy",
  featuresWalletFundingBuyTabSecuredByStripeWeNeverSeeYour:
    "features.wallet.funding.buyTab.securedByStripeWeNeverSeeYour",
  featuresWalletFundingBuyTabOr: "features.wallet.funding.buyTab.or",
  featuresWalletFundingBuyTabLogInToPayWithZEC:
    "features.wallet.funding.buyTab.logInToPayWithZEC",
  featuresWalletFundingBuyTabDemoPayWithZEC:
    "features.wallet.funding.buyTab.demoPayWithZEC",
  featuresWalletFundingBuyTabPayWithZECUnavailable:
    "features.wallet.funding.buyTab.payWithZECUnavailable",
  featuresWalletFundingBuyTabEstDemoCost:
    "features.wallet.funding.buyTab.estDemoCost",
  featuresWalletFundingBuyTabDemoCost:
    "features.wallet.funding.buyTab.demoCost",
  featuresWalletFundingBuyTabDemoOnly:
    "features.wallet.funding.buyTab.demoOnly",
  featuresWalletFundingBuyTabZEC: "features.wallet.funding.buyTab.zEC",
  featuresWalletFundingBuyTabMockWalletSpendable:
    "features.wallet.funding.buyTab.mockWalletSpendable",
  featuresWalletFundingBuyTabDemoPricingUnavailableTryAgain:
    "features.wallet.funding.buyTab.demoPricingUnavailableTryAgain",
  featuresWalletFundingBuyTabNotEnoughMockZECForThisDemo:
    "features.wallet.funding.buyTab.notEnoughMockZECForThisDemo",
  featuresWalletFundingBuyTabDemoOnlyThisChangesALocalMock:
    "features.wallet.funding.buyTab.demoOnlyThisChangesALocalMock",
  featuresWalletFundingBuyTabZECTopUpsAreNotAvailableYet:
    "features.wallet.funding.buyTab.zECTopUpsAreNotAvailableYet",
  featuresWalletFundingBuyTabConfirmDemoZECPayment:
    "features.wallet.funding.buyTab.confirmDemoZECPayment",
  featuresWalletFundingBuyTabSimulateFundingALocalMock2ZBalance:
    "features.wallet.funding.buyTab.simulateFundingALocalMock2ZBalance",
  featuresWalletFundingBuyTabYouReceive:
    "features.wallet.funding.buyTab.youReceive",
  featuresWalletFundingBuyTabPrice: "features.wallet.funding.buyTab.price",
  featuresWalletFundingBuyTabEstimatedZEC:
    "features.wallet.funding.buyTab.estimatedZEC",
  featuresWalletFundingBuyTabZECToSend:
    "features.wallet.funding.buyTab.zECToSend",
  featuresWalletFundingBuyTabEstimated:
    "features.wallet.funding.buyTab.estimated",
  featuresWalletFundingBuyTabDemoOnlyNoTransactionIsProposedSigned:
    "features.wallet.funding.buyTab.demoOnlyNoTransactionIsProposedSigned",
  featuresWalletFundingBuyTabCancel: "features.wallet.funding.buyTab.cancel",
  featuresWalletFundingBuyTabRunDemoPurchase:
    "features.wallet.funding.buyTab.runDemoPurchase",
  featuresWalletFundingLibPurchase: "features.wallet.funding.lib.purchase",
  featuresWalletFundingLibTip: "features.wallet.funding.lib.tip",
  featuresWalletFundingLibSubscription:
    "features.wallet.funding.lib.subscription",
  featuresWalletFundingLibActivity: "features.wallet.funding.lib.activity",
  featuresWalletFundingCardCheckoutTheSecureCheckoutPageCouldNotBe:
    "features.wallet.funding.cardCheckout.theSecureCheckoutPageCouldNotBe",
  featuresWalletFundingCardCheckoutLogInAgain:
    "features.wallet.funding.cardCheckout.logInAgain",
  featuresWalletFundingCardCheckoutYourSessionExpiredLogInThenRetry:
    "features.wallet.funding.cardCheckout.yourSessionExpiredLogInThenRetry",
  featuresWalletFundingCardCheckoutCheckTheAmount:
    "features.wallet.funding.cardCheckout.checkTheAmount",
  featuresWalletFundingCardCheckoutChooseAValidAmountThenTryAgain:
    "features.wallet.funding.cardCheckout.chooseAValidAmountThenTryAgain",
  featuresWalletFundingCardCheckoutTooManyAttempts:
    "features.wallet.funding.cardCheckout.tooManyAttempts",
  featuresWalletFundingCardCheckoutWaitAMomentBeforeTryingCheckoutAgain:
    "features.wallet.funding.cardCheckout.waitAMomentBeforeTryingCheckoutAgain",
  featuresWalletFundingCardCheckoutCheckoutUnavailable:
    "features.wallet.funding.cardCheckout.checkoutUnavailable",
  featuresWalletFundingCardCheckoutThePaymentServiceIsTemporarilyUnavailableTry:
    "features.wallet.funding.cardCheckout.thePaymentServiceIsTemporarilyUnavailableTry",
  featuresWalletFundingCardCheckoutCheckoutLinkBlocked:
    "features.wallet.funding.cardCheckout.checkoutLinkBlocked",
  featuresWalletFundingCardCheckoutThePaymentLinkWasNotAnApproved:
    "features.wallet.funding.cardCheckout.thePaymentLinkWasNotAnApproved",
  featuresWalletFundingCardCheckoutThePaymentServiceReturnedAnInvalidCheckout:
    "features.wallet.funding.cardCheckout.thePaymentServiceReturnedAnInvalidCheckout",
  featuresWalletFundingCardCheckoutCouldnTOpenCheckout:
    "features.wallet.funding.cardCheckout.couldnTOpenCheckout",
  featuresWalletFundingCardCheckoutAllowZUULIToOpenExternalLinksThen:
    "features.wallet.funding.cardCheckout.allowZUULIToOpenExternalLinksThen",
  featuresWalletFundingCardCheckoutCanTReachCheckout:
    "features.wallet.funding.cardCheckout.canTReachCheckout",
  featuresWalletFundingCardCheckoutCheckYourConnectionThenTryAgain:
    "features.wallet.funding.cardCheckout.checkYourConnectionThenTryAgain",
  featuresWalletFundingCardCheckoutCheckoutFailed:
    "features.wallet.funding.cardCheckout.checkoutFailed",
  featuresWalletFundingCardCheckoutTryAgainIfThisKeepsHappeningContact:
    "features.wallet.funding.cardCheckout.tryAgainIfThisKeepsHappeningContact",
  featuresWalletFundingSendTabLogInBeforeSending2Z:
    "features.wallet.funding.sendTab.logInBeforeSending2Z",
  featuresWalletFundingSendTabYouCanTSend2ZToYour:
    "features.wallet.funding.sendTab.youCanTSend2ZToYour",
  featuresWalletFundingSendTabCreatorSearchFailedCheckYourConnectionAnd:
    "features.wallet.funding.sendTab.creatorSearchFailedCheckYourConnectionAnd",
  featuresWalletFundingSendTabNoCreatorFoundFor:
    "features.wallet.funding.sendTab.noCreatorFoundFor",
  featuresWalletFundingSendTabSearchAndChooseACreatorTypedText:
    "features.wallet.funding.sendTab.searchAndChooseACreatorTypedText",
  featuresWalletFundingSendTabTheOriginalTransferWasNotChargedAgain:
    "features.wallet.funding.sendTab.theOriginalTransferWasNotChargedAgain",
  featuresWalletFundingSendTabThanksForSupportingTheCreator:
    "features.wallet.funding.sendTab.thanksForSupportingTheCreator",
  featuresWalletFundingSendTabSendTo: "features.wallet.funding.sendTab.sendTo",
  featuresWalletFundingSendTabSearchCreatorsByNameOrUsername:
    "features.wallet.funding.sendTab.searchCreatorsByNameOrUsername",
  featuresWalletFundingSendTabSearchForA2ZRecipient:
    "features.wallet.funding.sendTab.searchForA2ZRecipient",
  featuresWalletFundingSendTabSearchingCreators:
    "features.wallet.funding.sendTab.searchingCreators",
  featuresWalletFundingSendTabMatchingCreators:
    "features.wallet.funding.sendTab.matchingCreators",
  featuresWalletFundingSendTabChangeRecipientFrom:
    "features.wallet.funding.sendTab.changeRecipientFrom",
  featuresWalletFundingSendTabChange: "features.wallet.funding.sendTab.change",
  featuresWalletFundingSendTabAmount: "features.wallet.funding.sendTab.amount",
  featuresWalletFundingSendTabCustomAmount:
    "features.wallet.funding.sendTab.customAmount",
  featuresWalletFundingSendTabCustomTipAmountIn2Z:
    "features.wallet.funding.sendTab.customTipAmountIn2Z",
  featuresWalletFundingSendTabMax2ZPerTip:
    "features.wallet.funding.sendTab.max2ZPerTip",
  featuresWalletFundingSendTabEnterAPositiveWhole2ZAmountE:
    "features.wallet.funding.sendTab.enterAPositiveWhole2ZAmountE",
  featuresWalletFundingSendTabReviewTip:
    "features.wallet.funding.sendTab.reviewTip",
  featuresWalletFundingSendTabYouWillConfirmBeforeAnythingIsSent:
    "features.wallet.funding.sendTab.youWillConfirmBeforeAnythingIsSent",
  featuresWalletFundingSendTabRecipient:
    "features.wallet.funding.sendTab.recipient",
  featuresWalletFundingSendTabBalanceAfter:
    "features.wallet.funding.sendTab.balanceAfter",
  featuresWalletFundingSendTabTransferConfirmed:
    "features.wallet.funding.sendTab.transferConfirmed",
  featuresWalletFundingSendTabStartAnotherTransfer:
    "features.wallet.funding.sendTab.startAnotherTransfer",
  featuresWalletFundingSendTabCheckingAccount:
    "features.wallet.funding.sendTab.checkingAccount",
  featuresWalletFundingSendTabSignInToSend2Z:
    "features.wallet.funding.sendTab.signInToSend2Z",
  featuresWalletFundingSendTabNotEnough2ZBuyMore:
    "features.wallet.funding.sendTab.notEnough2ZBuyMore",
  featuresWalletFundingSendTabConfirmThisTransfer:
    "features.wallet.funding.sendTab.confirmThisTransfer",
  featuresWalletFundingSendTabCancel: "features.wallet.funding.sendTab.cancel",
  featuresWalletFundingSendTabRetrySameTransfer:
    "features.wallet.funding.sendTab.retrySameTransfer",
  featuresWalletFundingSendTabConfirmSend:
    "features.wallet.funding.sendTab.confirmSend",
  featuresWalletFundingSendTabReviewTransfer:
    "features.wallet.funding.sendTab.reviewTransfer",
  featuresWalletFundingSendRecipientYourSessionExpiredLogInAgainBefore:
    "features.wallet.funding.sendRecipient.yourSessionExpiredLogInAgainBefore",
  featuresWalletFundingSendRecipientYour2ZBalanceChangedAndIsNo:
    "features.wallet.funding.sendRecipient.your2ZBalanceChangedAndIsNo",
  featuresWalletFundingSendRecipientThatCreatorIsNoLongerAvailableSearch:
    "features.wallet.funding.sendRecipient.thatCreatorIsNoLongerAvailableSearch",
  featuresWalletFundingSendRecipientYouCanTSend2ZToYour:
    "features.wallet.funding.sendRecipient.youCanTSend2ZToYour",
  featuresWalletFundingSendRecipientThisTransferIsStillProcessingWaitThen:
    "features.wallet.funding.sendRecipient.thisTransferIsStillProcessingWaitThen",
  featuresWalletFundingSendRecipientAPreviousTransferIsUnresolvedRestoreIts:
    "features.wallet.funding.sendRecipient.aPreviousTransferIsUnresolvedRestoreIts",
  featuresWalletFundingSendRecipientThisTransferIDConflictsWithTheServer:
    "features.wallet.funding.sendRecipient.thisTransferIDConflictsWithTheServer",
  featuresWalletFundingSendRecipientSecure2ZTransfersAreNotAvailableOn:
    "features.wallet.funding.sendRecipient.secure2ZTransfersAreNotAvailableOn",
  featuresWalletFundingSendRecipientTheServerRejectedThisTransferNothingWas:
    "features.wallet.funding.sendRecipient.theServerRejectedThisTransferNothingWas",
  featuresWalletFundingSendRecipientACrashSafeTransferIDCouldNot:
    "features.wallet.funding.sendRecipient.aCrashSafeTransferIDCouldNot",
  featuresWalletFundingSendRecipientTheTransferResultIsUncertainRetryUses:
    "features.wallet.funding.sendRecipient.theTransferResultIsUncertainRetryUses",
  featuresWalletFundingActivityTabSignInToViewActivity:
    "features.wallet.funding.activityTab.signInToViewActivity",
  featuresWalletFundingActivityTabCardPurchaseHistoryBelongsToYourAccount:
    "features.wallet.funding.activityTab.cardPurchaseHistoryBelongsToYourAccount",
  featuresWalletFundingActivityTabSignIn:
    "features.wallet.funding.activityTab.signIn",
  featuresWalletFundingActivityTabCouldnTLoadPurchaseHistory:
    "features.wallet.funding.activityTab.couldnTLoadPurchaseHistory",
  featuresWalletFundingActivityTabYourCardPurchaseHistoryIsTemporarilyUnavailable:
    "features.wallet.funding.activityTab.yourCardPurchaseHistoryIsTemporarilyUnavailable",
  featuresWalletFundingActivityTabCouldnTRefreshPurchaseHistory:
    "features.wallet.funding.activityTab.couldnTRefreshPurchaseHistory",
  featuresWalletFundingActivityTabShowingTheLastCardPurchaseHistoryLoaded:
    "features.wallet.funding.activityTab.showingTheLastCardPurchaseHistoryLoaded",
  featuresWalletFundingActivityTabNoCardPurchasesYet:
    "features.wallet.funding.activityTab.noCardPurchasesYet",
  featuresWalletFundingActivityTabYourAvailableCardPurchaseHistoryWillShow:
    "features.wallet.funding.activityTab.yourAvailableCardPurchaseHistoryWillShow",
  featuresWalletFundingActivityTabTotalBought:
    "features.wallet.funding.activityTab.totalBought",
  featuresWalletFundingActivityTabTotalSpent:
    "features.wallet.funding.activityTab.totalSpent",
  featuresWalletFundingActivityTabAdded2Zs:
    "features.wallet.funding.activityTab.added2Zs",
  libAboutCopyAboutFeedback: "lib.aboutCopy.aboutFeedback",
  libAboutCopyBuildDetailsAndWaysToContactThe:
    "lib.aboutCopy.buildDetailsAndWaysToContactThe",
  libAboutCopyAboutAndFeedback: "lib.aboutCopy.aboutAndFeedback",
  libAboutCopyAboutZUULI: "lib.aboutCopy.aboutZUULI",
  libAboutCopyExactDetailsEmbeddedWhenThisAppWas:
    "lib.aboutCopy.exactDetailsEmbeddedWhenThisAppWas",
  libAboutCopyProduct: "lib.aboutCopy.product",
  libAboutCopyVersion: "lib.aboutCopy.version",
  libAboutCopyBuild: "lib.aboutCopy.build",
  libAboutCopyReleaseChannel: "lib.aboutCopy.releaseChannel",
  libAboutCopyInternal: "lib.aboutCopy.internal",
  libAboutCopyBeta: "lib.aboutCopy.beta",
  libAboutCopyStable: "lib.aboutCopy.stable",
  libAboutCopyPlatform: "lib.aboutCopy.platform",
  libAboutCopySourceCommit: "lib.aboutCopy.sourceCommit",
  libAboutCopyUnavailableInThisBuild: "lib.aboutCopy.unavailableInThisBuild",
  libAboutCopyCopyBuildInfo: "lib.aboutCopy.copyBuildInfo",
  libAboutCopyBuildInfoCopied: "lib.aboutCopy.buildInfoCopied",
  libAboutCopyCouldNotCopySelectTheBuildDetails:
    "lib.aboutCopy.couldNotCopySelectTheBuildDetails",
  libAboutCopyBuildProvenance: "lib.aboutCopy.buildProvenance",
  libAboutCopyApplicationID: "lib.aboutCopy.applicationID",
  libAboutCopyFullSourceCommit: "lib.aboutCopy.fullSourceCommit",
  libAboutCopyMetadataSource: "lib.aboutCopy.metadataSource",
  libAboutCopyEmbeddedAtBuildTime: "lib.aboutCopy.embeddedAtBuildTime",
  libAboutCopySendFeedback: "lib.aboutCopy.sendFeedback",
  libAboutCopyChooseADestinationThenReviewExactlyWhat:
    "lib.aboutCopy.chooseADestinationThenReviewExactlyWhat",
  libAboutCopyWhereShouldThisReportGo: "lib.aboutCopy.whereShouldThisReportGo",
  libAboutCopyPrivateEmail: "lib.aboutCopy.privateEmail",
  libAboutCopyOpensADraftToHelpFree2zCom:
    "lib.aboutCopy.opensADraftToHelpFree2zCom",
  libAboutCopyPublicGitHubIssue: "lib.aboutCopy.publicGitHubIssue",
  libAboutCopyOpensAPublicDraftInFree2zZuu:
    "lib.aboutCopy.opensAPublicDraftInFree2zZuu",
  libAboutCopyWhatHappened: "lib.aboutCopy.whatHappened",
  libAboutCopyDoNotIncludeWalletSecretsPasswordsTokens:
    "lib.aboutCopy.doNotIncludeWalletSecretsPasswordsTokens",
  libAboutCopyAutomaticScreeningForRecoveryPhrasesOnlyRecognizes:
    "lib.aboutCopy.automaticScreeningForRecoveryPhrasesOnlyRecognizes",
  libAboutCopyIncludeSanitizedDiagnostics:
    "lib.aboutCopy.includeSanitizedDiagnostics",
  libAboutCopyOffThisBuildDoesNotCollectLogs:
    "lib.aboutCopy.offThisBuildDoesNotCollectLogs",
  libAboutCopyReviewReport: "lib.aboutCopy.reviewReport",
  libAboutCopyReviewTheCompleteOutgoingDraft:
    "lib.aboutCopy.reviewTheCompleteOutgoingDraft",
  libAboutCopyEditThisDraftBeforeContinuingZUULINever:
    "lib.aboutCopy.editThisDraftBeforeContinuingZUULINever",
  libAboutCopyOutgoingSubjectOrTitle: "lib.aboutCopy.outgoingSubjectOrTitle",
  libAboutCopyOutgoingBody: "lib.aboutCopy.outgoingBody",
  libAboutCopyRemoveDiagnostics: "lib.aboutCopy.removeDiagnostics",
  libAboutCopyCopyReviewedReport: "lib.aboutCopy.copyReviewedReport",
  libAboutCopyEditDescription: "lib.aboutCopy.editDescription",
  libAboutCopyCancel: "lib.aboutCopy.cancel",
  libAboutCopyContinueToChosenApp: "lib.aboutCopy.continueToChosenApp",
  libAboutCopyPotentialPrivateDataWasRemovedReviewThe:
    "lib.aboutCopy.potentialPrivateDataWasRemovedReviewThe",
  libAboutCopyThisCompleteReportIsTooLongFor:
    "lib.aboutCopy.thisCompleteReportIsTooLongFor",
  libAboutCopyTheChosenAppCouldNotBeOpened:
    "lib.aboutCopy.theChosenAppCouldNotBeOpened",
  libAboutCopyTheClipboardIsUnavailableNothingWasSent:
    "lib.aboutCopy.theClipboardIsUnavailableNothingWasSent",
  libAboutCopyReviewedReportCopiedNothingWasSent:
    "lib.aboutCopy.reviewedReportCopiedNothingWasSent",
  libAboutCopyTheChosenAppWasOpenedWithThis:
    "lib.aboutCopy.theChosenAppWasOpenedWithThis",
  libAboutCopyZUULIFeedback: "lib.aboutCopy.zUULIFeedback",
  libAboutCopyRemovedSensitiveValue: "lib.aboutCopy.removedSensitiveValue",
  libAboutCopySubject: "lib.aboutCopy.subject",
  errorRequest: "error.request",
  errorSession: "error.session",
  errorRateLimit: "error.rateLimit",
  errorPermission: "error.permission",
  errorWalletIdentity: "error.walletIdentity",
  maintenanceRemaining: "wallet.maintenanceRemaining",
  maintenanceNote: "wallet.maintenanceNote",
  legacyInspected: "wallet.legacyInspected",
  legacySummary: "wallet.legacySummary",
  legacyDiagnostics: "wallet.legacyDiagnostics",
  wordCount: "wallet.wordCount",
  validAddress: "wallet.validAddress",
  memoBytes: "wallet.memoBytes",
  fundingReceipt: "funding.receipt",
  fundingConfirmed: "funding.confirmed",
  fundingConfirm: "funding.confirm",
  homeWalletScope: "home.walletScope",
  fundingForAmount: "funding.forAmount",
  fundingAi: "funding.ai",
  fundingPayPerView: "funding.payPerView",
  errorSignerChanged: "error.signerChanged",
} as const;

export type MessageKey = (typeof MESSAGE_KEYS)[keyof typeof MESSAGE_KEYS];

export const DECLARED_MESSAGE_KEYS: readonly MessageKey[] = Object.freeze(
  Object.values(MESSAGE_KEYS),
);
