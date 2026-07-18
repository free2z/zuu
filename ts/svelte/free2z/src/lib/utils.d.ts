export type WithElementRef<T> = T & { ref?: any };
export function cn(...inputs: any[]): string;

// Utility types used by UI primitives (modeled to accept children props patterns)
export type WithoutChildren<T = any> = T & { children?: any };
export type WithoutChild<T = any> = T & { child?: any; children?: any };
export type WithoutChildrenOrChild<T = any> = T & {
  child?: any;
  children?: any;
};
