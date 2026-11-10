import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppI18n, createLocaleChanger, loadCatalog } from "./index";
import { configureFormattingLocale, formatDate } from "@/lib/format";
import { savePreferenceLocale } from "./preferences";
import type { SupportedLocale } from "./locale";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("locale transitions", () => {
  afterEach(() => { vi.unstubAllGlobals(); configureFormattingLocale("en", "Pending"); });
  it("supersedes a deferred load and isolates instances", async () => {
    const first = await createAppI18n("en");
    const second = await createAppI18n("en");
    const delayed = deferred<Awaited<ReturnType<typeof loadCatalog>>>();
    const apply = vi.fn(); const save = vi.fn();
    const change = createLocaleChanger({ load: (locale) => locale === "es" ? delayed.promise : loadCatalog(locale), apply, save });
    const a = change(first, "es");
    await Promise.resolve();
    const b = change(first, "fr");
    const independent = change(second, "fr");
    await independent;
    delayed.resolve(await loadCatalog("es"));
    await Promise.all([a, b]);
    expect(first.resolvedLanguage).toBe("fr");
    expect(second.resolvedLanguage).toBe("fr");
    expect(save.mock.calls).toEqual([["fr"], ["fr"]]);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("serializes changes that overlap changeLanguage and retains the last successful state on failure", async () => {
    const instance = await createAppI18n("en");
    const gate = deferred<void>();
    const original = instance.changeLanguage.bind(instance);
    const spy = vi.spyOn(instance, "changeLanguage").mockImplementation(async (locale) => {
      if (locale === "es") await gate.promise;
      return original(locale);
    });
    const applied: SupportedLocale[] = []; const saved: SupportedLocale[] = [];
    const change = createLocaleChanger({ load: loadCatalog, apply: (locale) => applied.push(locale), save: (locale) => saved.push(locale) });
    const a = change(instance, "es");
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("es"));
    const b = change(instance, "fr");
    gate.resolve();
    await Promise.all([a, b]);
    expect(instance.resolvedLanguage).toBe("fr");
    expect(applied).toEqual(["es", "fr"]);
    expect(saved).toEqual(["es", "fr"]);
    spy.mockImplementationOnce(async () => { throw new Error("failed"); });
    await expect(change(instance, "en")).rejects.toThrow("failed");
    expect(instance.resolvedLanguage).toBe("fr");
    expect(applied[applied.length - 1]).toBe("fr");
    expect(saved[saved.length - 1]).toBe("fr");
  });
  it("keeps UI, formatting and document language usable when storage denies writes", async () => {
    const instance = await createAppI18n("en");
    const root = { lang: "en" };
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("denied"); } });
    const change = createLocaleChanger({ load: loadCatalog, apply: (locale, pending) => {
      root.lang = locale;
      configureFormattingLocale(locale, pending);
    }, save: savePreferenceLocale });
    await change(instance, "es");
    expect(instance.resolvedLanguage).toBe("es");
    expect(root.lang).toBe("es");
    expect(formatDate(null)).toBe("Pendiente");
  });

  it("restores the previous language if a transition mutates before failing", async () => {
    const instance = await createAppI18n("en");
    const original = instance.changeLanguage.bind(instance);
    vi.spyOn(instance, "changeLanguage").mockImplementationOnce(async (locale) => {
      await original(locale);
      throw new Error("change failed");
    });
    const apply = vi.fn(); const save = vi.fn();
    const change = createLocaleChanger({ load: loadCatalog, apply, save });
    await expect(change(instance, "fr")).rejects.toThrow("change failed");
    expect(instance.resolvedLanguage).toBe("en");
    expect(apply).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

});
