import { t, type TranslationFunction, type TranslationParams } from "$lib/i18n";

export interface MessageDescriptor {
  key: string;
  fallback: string;
}

export function defineMessage(
  key: string,
  fallback: string,
): MessageDescriptor {
  return Object.freeze({ key, fallback });
}

export function translateMessage(
  descriptor: MessageDescriptor,
  params?: TranslationParams,
  translator: TranslationFunction = t,
): string {
  return translator(descriptor.key, descriptor.fallback, params);
}

export class LocalizedError extends Error {
  readonly code: string;
  readonly descriptor: MessageDescriptor;
  readonly params?: TranslationParams;

  constructor(
    descriptor: MessageDescriptor,
    params?: TranslationParams,
    options?: ErrorOptions,
  ) {
    super(translateMessage(descriptor, params), options);
    this.name = "LocalizedError";
    this.code = descriptor.key;
    this.descriptor = descriptor;
    this.params = params;
  }
}

export function localizedError(
  descriptor: MessageDescriptor,
  params?: TranslationParams,
  cause?: unknown,
): LocalizedError {
  return new LocalizedError(descriptor, params, { cause });
}

export function safeLocalizedErrorMessage(
  error: unknown,
  fallback: MessageDescriptor,
  params?: TranslationParams,
): string {
  return error instanceof LocalizedError
    ? error.message
    : translateMessage(fallback, params);
}
