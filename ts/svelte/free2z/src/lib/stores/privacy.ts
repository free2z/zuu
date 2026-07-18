/**
 * Privacy store for managing external embed consent
 * Persists user preferences in localStorage
 */

import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';
import { isExternalEmbedDomain } from '$lib/utils/embed-domains';

const TRUSTED_DOMAINS_KEY = 'trustedEmbedDomains';
const GLOBAL_CONSENT_KEY = 'globalEmbedConsent';

interface PrivacyState {
  trustedDomains: string[];
  globalConsent: boolean;
}

/**
 * Extract domain from URL
 */
export function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return '';
  }
}

/**
 * Check if a URL is an external embed (YouTube, Twitter, etc.)
 * Uses the centralized domain list from embed-domains.ts
 */
export function isExternalEmbed(url: string): boolean {
  if (isExternalEmbedDomain(url)) return true;

  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Load privacy state from localStorage
 */
function loadPrivacyState(): PrivacyState {
  if (!browser) {
    return { trustedDomains: [], globalConsent: false };
  }

  try {
    const trustedDomains = JSON.parse(
      localStorage.getItem(TRUSTED_DOMAINS_KEY) || '[]'
    );
    const globalConsent = localStorage.getItem(GLOBAL_CONSENT_KEY) === 'true';

    return { trustedDomains, globalConsent };
  } catch {
    return { trustedDomains: [], globalConsent: false };
  }
}

/**
 * Create the privacy store
 */
function createPrivacyStore() {
  const initialState = loadPrivacyState();
  const { subscribe, set, update } = writable<PrivacyState>(initialState);

  return {
    subscribe,

    /**
     * Check if a domain is trusted
     */
    isDomainTrusted: (domain: string): boolean => {
      const state = get({ subscribe });
      return state.globalConsent || state.trustedDomains.includes(domain);
    },

    /**
     * Check if a URL should be loaded (global consent or domain trusted)
     */
    canLoadUrl: (url: string): boolean => {
      const domain = extractDomain(url);
      if (!domain) return false;

      const state = get({ subscribe });
      return state.globalConsent || state.trustedDomains.includes(domain);
    },

    /**
     * Trust a specific domain
     */
    trustDomain: (domain: string) => {
      update(state => {
        if (!state.trustedDomains.includes(domain)) {
          const newTrustedDomains = [...state.trustedDomains, domain];

          if (browser) {
            localStorage.setItem(
              TRUSTED_DOMAINS_KEY,
              JSON.stringify(newTrustedDomains)
            );
          }

          return { ...state, trustedDomains: newTrustedDomains };
        }
        return state;
      });
    },

    /**
     * Revoke trust for a specific domain
     */
    revokeDomain: (domain: string) => {
      update(state => {
        const newTrustedDomains = state.trustedDomains.filter(d => d !== domain);

        if (browser) {
          localStorage.setItem(
            TRUSTED_DOMAINS_KEY,
            JSON.stringify(newTrustedDomains)
          );
        }

        return { ...state, trustedDomains: newTrustedDomains };
      });
    },

    /**
     * Enable global consent for all embeds
     */
    enableGlobalConsent: () => {
      update(state => {
        if (browser) {
          localStorage.setItem(GLOBAL_CONSENT_KEY, 'true');
        }
        return { ...state, globalConsent: true };
      });
    },

    /**
     * Disable global consent
     */
    disableGlobalConsent: () => {
      update(state => {
        if (browser) {
          localStorage.setItem(GLOBAL_CONSENT_KEY, 'false');
        }
        return { ...state, globalConsent: false };
      });
    },

    /**
     * Clear all privacy settings
     */
    clearAll: () => {
      if (browser) {
        localStorage.removeItem(TRUSTED_DOMAINS_KEY);
        localStorage.removeItem(GLOBAL_CONSENT_KEY);
      }
      set({ trustedDomains: [], globalConsent: false });
    },

    /**
     * Get all trusted domains
     */
    getTrustedDomains: (): string[] => {
      const state = get({ subscribe });
      return state.trustedDomains;
    },

    /**
     * Check if global consent is enabled
     */
    hasGlobalConsent: (): boolean => {
      const state = get({ subscribe });
      return state.globalConsent;
    }
  };
}

export const privacyStore = createPrivacyStore();
