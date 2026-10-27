import { goto } from "$app/navigation";
import { page } from "$app/state";
import { get } from "svelte/store";
import { translationJobs } from "$lib/stores/translationJobs";
import { editorVariantHref } from "$lib/zpage-language.js";

export function reviewTranslation(identifier: string, language: string) {
  translationJobs.requestReview(identifier, language);
  if (!(
    page.route.id === "/edit" && get(translationJobs).editorPage === identifier
  ))
    void goto(editorVariantHref(identifier, language));
}
