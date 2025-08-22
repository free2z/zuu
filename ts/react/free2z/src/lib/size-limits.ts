export const MB = 1024 * 1024;
export const GB = 1024 * MB;

export function maxBytesForTuzis(tuzisRaw: unknown): number {
    const t = Number.parseInt(String(tuzisRaw ?? "0"), 10) || 0;
    if (t >= 5000) return 5 * GB;
    if (t > 0) return 250 * MB;
    return 5 * MB;
}
export function humanBytes(n: number) {
    if (n >= GB) return `${(n / GB).toFixed(2)} GB`;
    if (n >= MB) return `${(n / MB).toFixed(2)} MB`;
    return `${n} B`;
}

export function getMessage(maxBytes: number): string {
    return {
        // "": "",
        // 10485760: "Free accounts can upload files up to 10MB each.",
        // 52428800: "Pro accounts can upload files up to 50MB each.",

        // With no tuzis, you can upload up to 5MB files.
        // With tuzis, you can upload up to 250MB files.
        // With 5000+ tuzis, you can upload up to 5GB files
        [5 * 1024 * 1024]: "Free accounts can upload files up to 5MB each.",
        [250 * 1024 * 1024]: "With tuzis, you can upload files up to 250MB each.",
        [5 * 1024 * 1024 * 1024]: "With 5000+ tuzis, you can upload files up to 5GB each.",
    }[maxBytes]
}
