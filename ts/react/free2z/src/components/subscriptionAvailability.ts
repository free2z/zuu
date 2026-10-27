type SubscriptionAvailabilityCopy = {
  inactive: string;
  creatorUnavailable: string;
  subscriberUnavailable: string;
};

const copyByLanguage: Record<string, SubscriptionAvailabilityCopy> = {
  en: {
    inactive: "Inactive",
    creatorUnavailable:
      "This creator's account is no longer active, so their profile and price are unavailable and your maximum cannot be changed. The subscription does not renew while the account is inactive. Unsubscribe to make sure it never does.",
    subscriberUnavailable:
      "This subscriber's account is no longer active. Their subscription stays on record but does not renew while the account is inactive.",
  },
  es: {
    inactive: "Inactivo",
    creatorUnavailable:
      "La cuenta de este creador ya no está activa, así que su perfil y su precio no están disponibles y no puedes cambiar tu máximo. La suscripción no se renueva mientras la cuenta esté inactiva. Cancela la suscripción para asegurarte de que nunca se renueve.",
    subscriberUnavailable:
      "La cuenta de este suscriptor ya no está activa. Su suscripción sigue registrada, pero no se renueva mientras la cuenta esté inactiva.",
  },
  fr: {
    inactive: "Inactif",
    creatorUnavailable:
      "Le compte de ce créateur n’est plus actif : son profil et son prix ne sont plus disponibles et votre maximum ne peut pas être modifié. L’abonnement ne se renouvelle pas tant que le compte est inactif. Désabonnez-vous pour qu’il ne se renouvelle jamais.",
    subscriberUnavailable:
      "Le compte de cet abonné n’est plus actif. Son abonnement reste enregistré mais ne se renouvelle pas tant que le compte est inactif.",
  },
  "pt-br": {
    inactive: "Inativo",
    creatorUnavailable:
      "A conta deste criador não está mais ativa, então o perfil e o preço dele não estão disponíveis e seu máximo não pode ser alterado. A assinatura não é renovada enquanto a conta estiver inativa. Cancele a assinatura para garantir que ela nunca seja renovada.",
    subscriberUnavailable:
      "A conta deste assinante não está mais ativa. A assinatura continua registrada, mas não é renovada enquanto a conta estiver inativa.",
  },
};

export function getSubscriptionAvailabilityCopy(
  language?: string
): SubscriptionAvailabilityCopy {
  const normalizedLanguage = (language || "en").toLowerCase();
  const locale =
    normalizedLanguage === "pt-br" ? "pt-br" : normalizedLanguage.split("-")[0];
  return copyByLanguage[locale] || copyByLanguage.en;
}

export function getBrowserSubscriptionAvailabilityCopy(): SubscriptionAvailabilityCopy {
  return getSubscriptionAvailabilityCopy(
    typeof navigator === "undefined" ? "en" : navigator.language
  );
}
