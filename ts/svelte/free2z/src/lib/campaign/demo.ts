/** Local-only post/campaign model. All receipt data is fictitious. */
export type Visibility = "public" | "threshold" | "hidden";
export type FundingState = "open" | "paused" | "closed";
export type Phase = {
  id: string;
  title: string;
  target: string;
  benefit: string;
};
export type Campaign = {
  id: string;
  title: string;
  description: string;
  content: string;
  author: string;
  enabled: boolean;
  goal: string;
  wallet: string;
  visibility: Visibility;
  phases: Phase[];
};
export type Simulation = {
  received: string;
  spent: string;
  funding: FundingState;
  delivered: boolean[];
  nonce: string;
  salt: string;
};
export const MAX_ZATOSHIS = (1n << 64n) - 1n;
export const STORAGE_KEY = "free2z-local-campaign-v2";

export function zatoshis(value: string): bigint {
  if (!/^(0|[1-9]\d{0,11})(\.\d{1,8})?$/.test(value))
    throw new Error("Usa un monto positivo con hasta 8 decimales.");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, "0"));
  if (amount > MAX_ZATOSHIS)
    throw new Error("Monto fuera del rango de 64 bits.");
  return amount;
}
export function fromZatoshis(value: bigint): string {
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n)
    .toString()
    .padStart(8, "0")
    .replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}
export function randomHex(bytes = 16): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
export function blankCampaign(): Campaign {
  return {
    id: randomHex(),
    title: "",
    description: "",
    content: "",
    author: "Creador local",
    enabled: false,
    goal: "30",
    wallet: "",
    visibility: "threshold",
    phases: [
      { id: randomHex(), title: "Primera etapa", target: "30", benefit: "" },
    ],
  };
}
export function emptySimulation(count: number): Simulation {
  return {
    received: "0",
    spent: "0",
    funding: "open",
    delivered: Array(count).fill(false),
    nonce: randomHex(),
    salt: BigInt(`0x${randomHex(31)}`).toString(),
  };
}
export function sampleCampaign(): Campaign {
  return {
    id: randomHex(),
    title: "Un taller de privacidad para nuestra comunidad",
    description:
      "Recursos abiertos y encuentros gratuitos para aprender a usar Zcash.",
    content:
      "Cada vez más personas quieren recuperar el control de su privacidad. Queremos ayudarles a dar el primer paso.\n\n## Qué vamos a hacer\n\nPrepararemos una guía en español y organizaremos tres talleres gratuitos. Todo el material quedará abierto para que otras comunidades puedan usarlo.\n\n## Cómo puedes participar\n\nComparte esta publicación, cuéntanos qué te gustaría aprender o apoya una de las etapas. Aquí puedes seguir la financiación y las entregas por separado.\n\nGracias por construir esto con nosotros.",
    author: "Comunidad Zcash LATAM",
    enabled: true,
    goal: "30",
    wallet: "billetera ficticia · sin pagos",
    visibility: "threshold",
    phases: [
      {
        id: randomHex(),
        title: "Guía abierta",
        target: "8",
        benefit: "Guía de primeros pasos en Zcash",
      },
      {
        id: randomHex(),
        title: "Talleres en vivo",
        target: "20",
        benefit: "Tres talleres gratuitos",
      },
      {
        id: randomHex(),
        title: "Material para compartir",
        target: "30",
        benefit: "Grabaciones y kit para otras comunidades",
      },
    ],
  };
}
export function contribute(state: Simulation, amount: string): Simulation {
  const value = zatoshis(amount);
  const next = zatoshis(state.received) + value;
  if (state.funding !== "open" || value === 0n || next > MAX_ZATOSHIS)
    return state;
  return {
    ...state,
    received: fromZatoshis(next),
    nonce: randomHex(),
    salt: BigInt(`0x${randomHex(31)}`).toString(),
  };
}
export function spend(state: Simulation, amount: string): Simulation {
  const value = zatoshis(amount);
  if (value === 0n || value > zatoshis(state.received) - zatoshis(state.spent))
    return state;
  return { ...state, spent: fromZatoshis(zatoshis(state.spent) + value) };
}
export function deliver(
  state: Simulation,
  campaign: Campaign,
  index: number,
): Simulation {
  if (
    !campaign.phases[index] ||
    zatoshis(state.received) < zatoshis(campaign.phases[index].target)
  )
    return state;
  return {
    ...state,
    delivered: state.delivered.map((value, i) => (i === index ? true : value)),
  };
}
/** Threshold status must come from a verified proof, never the private witness. */
export function publicCampaign(
  campaign: Campaign,
  state: Simulation,
  verified: (boolean | null)[] = [],
) {
  const phases = campaign.phases.map((phase, i) => ({
    ...phase,
    delivered: Boolean(state.delivered[i]),
    reached:
      campaign.visibility === "public"
        ? zatoshis(state.received) >= zatoshis(phase.target)
        : campaign.visibility === "threshold"
          ? (verified[i] ?? null)
          : null,
  }));
  return {
    funding: state.funding,
    goalReached: phases.at(-1)?.reached ?? null,
    allDelivered: phases.every((phase) => phase.delivered),
    phases,
    ...(campaign.visibility === "public"
      ? {
          received: state.received,
          spent: state.spent,
          balance: fromZatoshis(
            zatoshis(state.received) - zatoshis(state.spent),
          ),
          percentage: Math.min(
            100,
            Number(
              (zatoshis(state.received) * 10_000n) / zatoshis(campaign.goal),
            ) / 100,
          ),
        }
      : {}),
  };
}
export function validateCampaign(campaign: Campaign): string {
  if (!campaign.title.trim() || !campaign.content.trim())
    return "Añade un título y contenido a tu publicación.";
  if (
    campaign.title.length > 200 ||
    campaign.content.length > 30_000 ||
    campaign.description.length > 500 ||
    campaign.author.length > 80 ||
    campaign.wallet.length > 512
  )
    return "La publicación supera el tamaño permitido en esta prueba local.";
  if (!campaign.enabled) return "";
  try {
    const goal = zatoshis(campaign.goal);
    if (goal === 0n || goal > 100_000_000_000_000n)
      return "La meta debe estar entre 0 y 1.000.000 ZEC.";
    if (campaign.phases.length < 1 || campaign.phases.length > 5)
      return "Añade entre una y cinco etapas.";
    let previous = 0n;
    const ids = new Set<string>();
    for (const phase of campaign.phases) {
      if (
        !phase.title.trim() ||
        !phase.benefit.trim() ||
        phase.title.length > 80 ||
        phase.benefit.length > 200
      )
        return "Cada etapa necesita un nombre y un beneficio.";
      if (ids.has(phase.id))
        return "Cada etapa debe tener una identidad distinta.";
      ids.add(phase.id);
      const target = zatoshis(phase.target);
      if (target <= previous || target > goal)
        return "Las metas acumuladas deben aumentar sin superar la meta final.";
      previous = target;
    }
    if (previous !== goal)
      return "La última etapa debe coincidir con la meta final.";
  } catch (error) {
    return error instanceof Error ? error.message : "Monto inválido.";
  }
  return "";
}
