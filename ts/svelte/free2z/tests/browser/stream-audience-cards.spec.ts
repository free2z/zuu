import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoHorizontalScroll } from "./mobile-layout-guards";

// The mock-api fixture is deliberately a real authenticated owner: the page
// server must pass its owner check and the client must receive can_stream=true
// before these assertions can reach the audience controls.
const SESSION = "stream-audience-owner-session";
const USER = "streamaudienceowner";
const STREAM_URL = `/${USER}/dashboard/stream`;
const MODES = ["broadcast", "subscribers-only", "ppv", "private"] as const;
const WIDTHS = [390, 768, 1024, 1280, 1440] as const;
const EXPECTED_COLUMNS = new Map([
  [390, 1],
  [768, 2],
  [1024, 2],
  [1280, 4],
  [1440, 4],
]);
const LOCALE_TITLES = {
  en: ["Broadcast", "Subscribers", "Pay Per View", "Private"],
  es: [
    "Transmisión pública",
    "Suscriptores",
    "Pago por visualización",
    "Privada",
  ],
  fr: ["Diffusion publique", "Abonnés", "Accès à la carte", "Privé"],
  "pt-BR": ["Transmissão", "Assinantes", "Pay-per-view", "Privada"],
} as const;
const LOCALE_GROUP_LABELS = {
  en: "Choose your audience",
  es: "Elige tu audiencia",
  fr: "Choisissez votre audience",
  "pt-BR": "Escolha seu público",
} as const;
const NON_ENGLISH_AUDIENCE_COPY = {
  es: {
    broadcast: {
      description:
        "Pública y gratuita para todos. Llega al mayor número de personas.",
      summary:
        "Pagas alrededor de 1 2Z cada 2 minutos por sesión de espectador.",
      cost: "Costo: alrededor de 1 2Z por cada 2 minutos de cada sesión de un espectador; una sesión de un minuto o menos es gratuita y una reconexión inicia una sesión nueva.",
    },
    "subscribers-only": {
      description: "Contenido exclusivo para quienes te apoyan cada mes.",
      summary: "Gratis: no se cobra ningún 2Z.",
      cost: "Gratis: no se cobra ningún 2Z.",
    },
    ppv: {
      description:
        "Genera ingresos directamente. Los espectadores pagan por minuto.",
      summary: "Pagan los espectadores; tú fijas el precio por minuto.",
      cost: "Pagan los espectadores, no tú: necesitan una reserva de entrada de 30 minutos más la comisión de plataforma para unirse. Una vez dentro, pagan tu precio por minuto por el tiempo visto (redondeado a un 2Z entero), más alrededor de 1 2Z por cada 2 minutos de comisión de plataforma; una sesión de un minuto o menos no tiene comisión de plataforma.",
    },
    private: {
      description:
        "Llamada privada entre dos personas. Genera un enlace secreto.",
      summary: "Gratis: no se cobra ningún 2Z.",
      cost: "Gratis: no se cobra ningún 2Z.",
    },
  },
  fr: {
    broadcast: {
      description:
        "Diffusion publique et gratuite pour tout le monde. Touchez un maximum de personnes.",
      summary:
        "Vous payez environ 1 2Z toutes les 2 minutes par session de spectateur.",
      cost: "Coût : environ 1 2Z toutes les 2 minutes pour chaque session de spectateur ; une session d’une minute ou moins est gratuite et une reconnexion démarre une nouvelle session.",
    },
    "subscribers-only": {
      description:
        "Contenu exclusif pour les personnes qui vous soutiennent chaque mois.",
      summary: "Gratuit : aucun 2Z n’est prélevé.",
      cost: "Gratuit : aucun 2Z n’est prélevé.",
    },
    ppv: {
      description:
        "Monétisez directement votre contenu. Les spectateurs paient à la minute.",
      summary: "Les spectateurs paient ; vous fixez le prix par minute.",
      cost: "Ce sont les spectateurs qui paient, pas vous : ils doivent disposer d’une réserve d’entrée de 30 minutes et des frais de plateforme pour rejoindre le direct. Une fois admis, ils paient votre prix à la minute pour le temps regardé (arrondi à un 2Z entier), plus environ 1 2Z toutes les 2 minutes de frais de plateforme — une session d’une minute ou moins n’entraîne aucun frais de plateforme.",
    },
    private: {
      description: "Appel privé en tête-à-tête. Générez un lien secret.",
      summary: "Gratuit : aucun 2Z n’est prélevé.",
      cost: "Gratuit : aucun 2Z n’est prélevé.",
    },
  },
  "pt-BR": {
    broadcast: {
      description:
        "Pública e gratuita para todos. Alcance o maior público possível.",
      summary:
        "Você paga cerca de 1 2Z a cada 2 minutos por sessão de espectador.",
      cost: "Custo: cerca de 1 2Z a cada 2 minutos por sessão de cada espectador — uma sessão de um minuto ou menos é gratuita, e uma reconexão inicia uma nova sessão.",
    },
    "subscribers-only": {
      description: "Conteúdo exclusivo para seus apoiadores mensais.",
      summary: "Grátis: nenhum 2Z é cobrado.",
      cost: "Grátis: nenhum 2Z é cobrado.",
    },
    ppv: {
      description: "Monetize diretamente. Os espectadores pagam por minuto.",
      summary: "Os espectadores pagam; você define o preço por minuto.",
      cost: "Quem paga são os espectadores, não você: eles precisam de uma reserva de entrada de 30 minutos mais a taxa da plataforma para entrar. Depois, pagam seu preço por minuto pelo tempo assistido (arredondado para um 2Z inteiro), mais cerca de 1 2Z a cada 2 minutos de taxa da plataforma — uma sessão de um minuto ou menos não tem taxa da plataforma.",
    },
    private: {
      description: "Chamada privada individual. Gere um link secreto.",
      summary: "Grátis: nenhum 2Z é cobrado.",
      cost: "Grátis: nenhum 2Z é cobrado.",
    },
  },
} as const;

async function authenticate(page: Page) {
  await page.context().clearCookies();
  await page
    .context()
    .addCookies([
      { name: "sessionid", value: SESSION, domain: "127.0.0.1", path: "/" },
    ]);
}

async function openStream(page: Page, width: number, locale = "en") {
  await page.setViewportSize({ width, height: 900 });
  // The dashboard is SSR-gated and the hydrated auth store revalidates via
  // the browser's same-origin /api proxy. Waiting for this response proves the
  // fixture session traverses both paths; SSR alone would still render enough
  // markup for the card assertions while leaving hydration anonymous.
  const hydratedAuth = page.waitForResponse((response) => {
    try {
      return new URL(response.url()).pathname === "/api/auth/user/";
    } catch {
      return false;
    }
  });
  await page.goto(`${STREAM_URL}?lang=${locale}`);
  const authResponse = await hydratedAuth;
  expect(authResponse.status()).toBe(200);
  expect(await authResponse.json()).toMatchObject({
    username: USER,
    can_stream: true,
  });
  const grid = page.getByTestId("stream-audience-grid");
  await expect(grid).toBeVisible();

  // This is intentionally before any measurement: a regression that only
  // renders the selected card can make every later geometry assertion vacuous.
  await expect(page.locator("[data-audience-card]")).toHaveCount(4);
  await expect(page.getByRole("radio")).toHaveCount(4);
  await expect(page.getByRole("radio", { checked: true })).toHaveCount(1);
  await expect(
    page.getByRole("group", {
      name: LOCALE_GROUP_LABELS[locale as keyof typeof LOCALE_GROUP_LABELS],
    }),
  ).toBeVisible();
  await expect(
    page.locator("[data-audience-card] [data-audience-selection-slot]"),
  ).toHaveCount(4);
  return { grid, cards: page.locator("[data-audience-card]") };
}

async function boxes(locator: Locator) {
  const values = await locator.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      // Keyboard focus may scroll the document. Compare document-space
      // coordinates so selection tests assert layout invariants, not the
      // viewport position chosen by the browser's auto-scroll policy.
      return {
        x: rect.x,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      };
    }),
  );
  return values.map((box) => ({
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  }));
}

async function expectCopyFits(page: Page) {
  const overflowing = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-audience-card] [data-audience-title], [data-audience-card] [data-audience-description], [data-audience-card] [data-audience-summary], [data-audience-cost-detail]",
      ),
    )
      .map((element) => ({
        text: (element.textContent || "").trim(),
        scrollWidth: element.scrollWidth,
        clientWidth: Math.ceil(element.getBoundingClientRect().width),
        textOverflow: getComputedStyle(element).textOverflow,
      }))
      .filter(
        (measurement) =>
          measurement.scrollWidth > measurement.clientWidth + 1 ||
          measurement.textOverflow === "ellipsis",
      ),
  );
  expect(
    overflowing,
    "audience UI copy must wrap, never clip or ellipsize",
  ).toEqual([]);
}

async function expectAudienceNoHorizontalScroll(page: Page, label: string) {
  const measurement = await page.evaluate(() => {
    const surfaces = [
      document.querySelector<HTMLElement>(
        '[data-testid="stream-audience-grid"]',
      ),
      document.querySelector<HTMLElement>(
        '[data-testid="stream-audience-detail"]',
      ),
    ].filter((element): element is HTMLElement => element !== null);
    return {
      viewport: window.innerWidth,
      right: Math.max(
        ...surfaces.map((element) => element.getBoundingClientRect().right),
      ),
      overflow: Math.max(
        ...surfaces.map((element) => element.scrollWidth - element.clientWidth),
      ),
    };
  });
  expect(
    measurement.right,
    `${label}: audience surface must fit`,
  ).toBeLessThanOrEqual(measurement.viewport + 1);
  expect(
    measurement.overflow,
    `${label}: audience surface must not overflow`,
  ).toBeLessThanOrEqual(1);
}

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

for (const width of WIDTHS) {
  test(`audience cards use readable columns and fit at ${width}px`, async ({
    page,
  }) => {
    const { grid, cards } = await openStream(page, width);

    await expectNoHorizontalScroll(page, `stream audience @ ${width}`);
    const columns = new Set((await boxes(cards)).map((box) => box.x)).size;
    expect(columns, `audience columns @ ${width}`).toBe(
      EXPECTED_COLUMNS.get(width),
    );

    await expectCopyFits(page);

    const cardBoxes = await boxes(cards);
    const rows = new Map<number, (typeof cardBoxes)[number][]>();
    for (const box of cardBoxes) {
      const row = rows.get(box.y) || [];
      row.push(box);
      rows.set(box.y, row);
    }
    for (const row of rows.values()) {
      expect(
        new Set(row.map((box) => box.height)).size,
        `cards in a row must share a height @ ${width}`,
      ).toBe(1);
    }

    const iconBoxes = await boxes(cards.locator("[data-audience-icon]"));
    expect(
      new Set(iconBoxes.map((box) => `${box.width}x${box.height}`)).size,
    ).toBe(1);
    expect(iconBoxes[0]).toMatchObject({ width: 48, height: 48 });

    const titleBoxes = await boxes(cards.locator("[data-audience-title]"));
    for (const rowY of new Set(cardBoxes.map((box) => box.y))) {
      const indexes = cardBoxes
        .map((box, index) => (box.y === rowY ? index : -1))
        .filter((index) => index >= 0);
      const rowIconY = indexes.map((index) => iconBoxes[index].y);
      const rowTitleY = indexes.map((index) => titleBoxes[index].y);
      expect(new Set(rowIconY).size, `icons align @ ${width}`).toBe(1);
      expect(new Set(rowTitleY).size, `titles align @ ${width}`).toBe(1);
    }
    for (let index = 0; index < iconBoxes.length; index += 1) {
      const iconCenter = iconBoxes[index].y + iconBoxes[index].height / 2;
      const titleCenter = titleBoxes[index].y + titleBoxes[index].height / 2;
      expect(
        Math.abs(iconCenter - titleCenter),
        `icon and title must share a center @ ${width}`,
      ).toBeLessThanOrEqual(1);
    }

    await expect(grid).toBeVisible();
    await expect(page.getByTestId("stream-audience-detail")).toBeVisible();
  });
}

test("selection is one native, keyboard-accessible state without geometry shifts", async ({
  page,
}) => {
  const { cards } = await openStream(page, 390);
  const radios = page.getByRole("radio");
  const initialBoxes = await boxes(cards);

  for (const [index, title] of LOCALE_TITLES.en.entries()) {
    await expect(radios.nth(index)).toHaveAccessibleName(title);
  }
  await expect(radios.nth(0)).toBeChecked();
  await expect(page.getByRole("radio", { checked: true })).toHaveCount(1);

  await cards.nth(1).click();
  await expect(radios.nth(1)).toBeChecked();
  await expect(page.getByRole("radio", { checked: true })).toHaveCount(1);
  expect(
    await boxes(cards),
    "pointer selection must not change card boxes",
  ).toEqual(initialBoxes);

  await radios.nth(2).press("Space");
  await expect(radios.nth(2)).toBeChecked();
  await expect(page.getByRole("radio", { checked: true })).toHaveCount(1);
  expect(
    await boxes(cards),
    "keyboard selection must not change card boxes",
  ).toEqual(initialBoxes);

  const card3ShadowBeforeFocus = await cards
    .nth(3)
    .evaluate((element) => getComputedStyle(element).boxShadow);
  await radios.nth(2).press("ArrowDown");
  await expect(radios.nth(3)).toBeChecked();
  await expect(page.getByRole("radio", { checked: true })).toHaveCount(1);
  await expect(radios.nth(3)).toBeFocused();
  expect(
    await cards
      .nth(3)
      .evaluate((element) => getComputedStyle(element).boxShadow),
    "keyboard focus must change the card's box shadow",
  ).not.toBe(card3ShadowBeforeFocus);
  expect(
    await boxes(cards),
    "arrow-key selection must not change card boxes",
  ).toEqual(initialBoxes);

  await expect(page.getByTestId("stream-audience-detail")).toContainText(
    "Free — no 2Z is charged.",
  );

  await radios.nth(0).focus();
  await radios.nth(0).press("ArrowDown");
  await expect(radios.nth(1)).toBeFocused();
  await expect(radios.nth(1)).toBeChecked();
  await expect(page.getByRole("radio", { checked: true })).toHaveCount(1);

  await radios.nth(1).press("ArrowUp");
  await expect(radios.nth(0)).toBeFocused();
  await expect(radios.nth(0)).toBeChecked();
  await expect(page.getByRole("radio", { checked: true })).toHaveCount(1);
});

test("full selected-mode billing detail and PPV threshold stay visible before start", async ({
  page,
}) => {
  const { cards } = await openStream(page, 390);
  const detail = page.getByTestId("stream-audience-detail");

  await expect(detail).toContainText("a session of a minute or less is free");
  await cards.nth(2).click();
  await expect(detail).toContainText("30-minute entry reserve");
  await expect(detail).toContainText("rounded up to a whole 2Z");
  await expect(
    page.getByText("At 1 2Z/min, viewers need at least 45 2Z to join."),
  ).toBeVisible();
  await expect(page.locator('input[type="number"]')).toBeVisible();

  // The private choice is still a separate-link flow; selecting it alone must
  // not issue the public stream-init request.
  const publicInitRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/dyte/"))
      publicInitRequests.push(request.url());
  });
  await cards.nth(3).click();
  expect(publicInitRequests).toEqual([]);
});

for (const [locale, titles] of Object.entries(LOCALE_TITLES)) {
  test(`all audience copy ships in ${locale}`, async ({ page }) => {
    const { cards } = await openStream(page, 390, locale);
    const radios = page.getByRole("radio");
    await expect(cards.locator("[data-audience-title]")).toHaveText([
      ...titles,
    ]);
    for (const [index, title] of titles.entries()) {
      await expect(radios.nth(index)).toHaveAccessibleName(title);
    }

    if (locale !== "en") {
      const copy =
        NON_ENGLISH_AUDIENCE_COPY[
          locale as keyof typeof NON_ENGLISH_AUDIENCE_COPY
        ];
      const detail = page.getByTestId("stream-audience-detail");

      for (const [index, mode] of MODES.entries()) {
        await expect(
          cards.nth(index).locator("[data-audience-description]"),
        ).toHaveText(copy[mode].description);
        await expect(
          cards.nth(index).locator("[data-audience-summary]"),
        ).toContainText(copy[mode].summary);

        // Select each mode so the persistent billing surface is tested too;
        // checking only the initially selected card would miss three costs.
        await cards.nth(index).click();
        await expect(
          detail.locator("[data-audience-cost-detail]"),
        ).toContainText(copy[mode].cost);
      }
    }
    await expectCopyFits(page);
  });
}

test("audience copy remains readable at an approximate 200% text size", async ({
  page,
}) => {
  await openStream(page, 390);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await page.waitForTimeout(100);
  await expectAudienceNoHorizontalScroll(page, "stream audience @ 200% text");
  await expect(page.locator("[data-audience-card]")).toHaveCount(4);
  await expectCopyFits(page);
});

// Keep the closed UI enum visible in this focused spec so a future card cannot
// silently become a fifth or misspelled startup mode.
test("the card hooks cover exactly the four supported dashboard modes", async ({
  page,
}) => {
  const { cards } = await openStream(page, 390);
  await expect(cards).toHaveCount(MODES.length);
  await expect(page.locator("[data-audience-card]").first()).toHaveAttribute(
    "data-audience-card",
    MODES[0],
  );
  expect(
    await cards.evaluateAll((elements) =>
      elements.map((el) => el.getAttribute("data-audience-card")),
    ),
  ).toEqual(MODES);
});
