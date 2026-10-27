import { defineParams } from "@sveltejs/kit/params";
import { match } from "./params/storytimeLegacyCreator.ts";

export const params = defineParams({
  storytimeLegacyCreator: (segment: string) =>
    match(segment) ? segment : undefined,
});
