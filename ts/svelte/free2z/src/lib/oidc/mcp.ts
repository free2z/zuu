import { apiFetch } from "$lib/api/config";

export interface AgentApplication {
  name: string;
  client_id: string;
}

export interface AgentAccount {
  id: string;
  username: string;
  scopes: string[];
  revoked: boolean;
  available: boolean;
}

export interface AgentConnection {
  id: string;
  application: AgentApplication;
  primary_username: string;
  scopes: string[];
  accounts: AgentAccount[];
  revoked: boolean;
  available?: boolean;
}

export interface AgentAccountGrant extends AgentAccount {
  connection_id: string;
  application: AgentApplication;
  primary_username: string;
}

export interface AgentConnections {
  connections: AgentConnection[];
  account_grants: AgentAccountGrant[];
  recent_actions?: {
    id: string;
    operation: string;
    status: string;
    created_at: string;
    primary_username: string;
    target_username: string;
    application: string | null;
  }[];
}

export interface AgentLinkPrompt {
  expected_username: string;
  signed_in_username: string;
  account_matches: boolean;
  application: AgentApplication;
  connection: { id: string; primary_username: string };
  scopes: string[];
  scope_descriptions: Record<string, string>;
  expires_at: string;
}

export class AgentRequestError extends Error {
  constructor(public status: number) {
    super("The agent account request did not complete.");
  }
}

/** Keep authorization URLs and server error payloads out of UI diagnostics. */
export async function agentRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await apiFetch(path, {
    ...init,
    cache: "no-store",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) throw new AgentRequestError(response.status);
  return response.status === 204 ? (undefined as T) : response.json();
}
