export function extractErrorMessage(data: any, fallback: string): string {
  if (!data) return fallback;
  if (typeof data === 'string') return data;
  if (data.detail) return data.detail;
  if (data.message) return data.message;
  const fields = ['new_password', 'old_password', 'email', 'token'];
  for (const field of fields) {
    if (data[field]) {
      const value = data[field];
      if (Array.isArray(value)) return value.join(' ');
      return String(value);
    }
  }
  return fallback;
}

export async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json();
    return extractErrorMessage(data, fallback);
  } catch {
    return fallback;
  }
}
