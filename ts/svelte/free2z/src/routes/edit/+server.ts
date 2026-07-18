import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import type { ZPage } from "$lib/types/zpage";
import {
  buildBackendHeaders,
  getApiBase,
  getCsrfCookie,
  getSessionCookie,
} from "$lib/server/backend";

type SaveRequest = {
  identifier: string;
  title: string;
  content: string;
  description?: string;
  tags: string[];
  vanity?: string;
  p2paddr?: string;
  featured_image?: number | null;
  is_published: boolean;
  is_subscriber_only: boolean;
  publish_at: string | null;
};

type CurrentUser = {
  username: string;
};

function parseString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parseStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as string[];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function parseBoolean(value: unknown) {
  return value === true;
}

function parseNullableNumber(value: unknown) {
  if (value === null) {
    return null;
  }

  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function parsePublishAt(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);

    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return null;
}

function parseSaveRequest(raw: unknown): SaveRequest {
  const data =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  return {
    identifier: parseString(data.identifier) || "new",
    title: parseString(data.title),
    content: parseString(data.content),
    description: parseString(data.description) || undefined,
    tags: parseStringArray(data.tags),
    vanity: parseString(data.vanity) || undefined,
    p2paddr: parseString(data.p2paddr) || undefined,
    featured_image: parseNullableNumber(data.featured_image),
    is_published: parseBoolean(data.is_published),
    is_subscriber_only: parseBoolean(data.is_subscriber_only),
    publish_at: parsePublishAt(data.publish_at),
  };
}

function parseBackendError(rawBody: string) {
  let data: Record<string, any> = {};

  try {
    data = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    data = {};
  }

  const message =
    data.detail ||
    data.message ||
    data.error ||
    (rawBody ? rawBody.trim() : "") ||
    "Failed to save article";

  return { data, message };
}

function isCredentialIssue(status: number, message: string) {
  return (
    status === 500 &&
    /defaultcredentialserror|default credentials were not found/.test(
      message.toLowerCase(),
    )
  );
}

async function fetchZPageByIdentifier(
  fetchFn: typeof fetch,
  sessionId: string,
  identifier: string,
) {
  const response = await fetchFn(`${getApiBase()}/api/zpage/${identifier}/`, {
    redirect: "manual",
    headers: {
      Cookie: `sessionid=${sessionId}`,
    },
  });

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as ZPage;
}

async function fetchCurrentUser(fetchFn: typeof fetch, sessionId: string) {
  const response = await fetchFn(`${getApiBase()}/api/auth/user/`, {
    redirect: "manual",
    headers: {
      Cookie: `sessionid=${sessionId}`,
    },
  });

  if (
    response.status === 401 ||
    response.status === 403 ||
    (response.status >= 300 && response.status < 400)
  ) {
    return {
      error: "Your session has expired. Please log in again.",
      redirectTo: "/?login=true",
      status: 401,
    } as const;
  }

  if (!response.ok) {
    return {
      error: "Unable to verify your session. Please refresh and try again.",
      status: 502,
    } as const;
  }

  try {
    return {
      currentUser: (await response.json()) as CurrentUser,
      status: 200,
    } as const;
  } catch {
    return {
      error: "Unable to verify your session. Please refresh and try again.",
      status: 502,
    } as const;
  }
}

export const POST: RequestHandler = async ({ request, cookies, fetch }) => {
  const sessionId = getSessionCookie(cookies);
  const csrfToken = getCsrfCookie(cookies);

  if (!sessionId) {
    return json(
      {
        error: "Your session has expired. Please log in again.",
        redirectTo: "/?login=true",
      },
      { status: 401 },
    );
  }

  if (!csrfToken) {
    return json(
      {
        error:
          "Your session security token is missing. Please refresh the page and try again.",
      },
      { status: 403 },
    );
  }

  const authResult = await fetchCurrentUser(fetch, sessionId);

  if ("error" in authResult) {
    return json(
      {
        error: authResult.error,
        redirectTo: authResult.redirectTo,
      },
      { status: authResult.status },
    );
  }

  const currentUser = authResult.currentUser;
  const saveRequest = parseSaveRequest(await request.json());

  if (!saveRequest.title) {
    return json(
      {
        error: "Please fix the validation errors",
        validationErrors: { title: "Title is required" },
      },
      { status: 400 },
    );
  }

  if (!saveRequest.content) {
    return json({ error: "Content is required" }, { status: 400 });
  }

  const isCreate = saveRequest.identifier === "new";

  if (!isCreate) {
    const existingZPage = await fetchZPageByIdentifier(
      fetch,
      sessionId,
      saveRequest.identifier,
    );

    if (!existingZPage) {
      return json({ error: "Article not found" }, { status: 404 });
    }

    if (existingZPage.creator.username !== currentUser.username) {
      return json(
        {
          error: "You do not have permission to edit this article.",
          redirectTo: `/${currentUser.username}/dashboard/pages`,
        },
        { status: 403 },
      );
    }
  }

  const payload = {
    title: saveRequest.title,
    content: saveRequest.content,
    description: saveRequest.description,
    tags: saveRequest.tags,
    vanity: saveRequest.vanity,
    p2paddr: saveRequest.p2paddr,
    featured_image: saveRequest.featured_image,
    is_published: saveRequest.is_published,
    is_subscriber_only: saveRequest.is_subscriber_only,
    publish_at: saveRequest.publish_at,
  };

  const method = isCreate ? "POST" : "PUT";
  const target = isCreate
    ? `${getApiBase()}/api/zpage/`
    : `${getApiBase()}/api/zpage/${saveRequest.identifier}/`;

  const response = await fetch(target, {
    method,
    redirect: "manual",
    headers: buildBackendHeaders(sessionId, {
      csrfToken,
      contentType: "application/json",
    }),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const rawBody = await response.text();
    const { data, message } = parseBackendError(rawBody);

    if (isCredentialIssue(response.status, message)) {
      const fallbackIdentifier =
        (!isCreate && saveRequest.identifier) || saveRequest.vanity;

      if (fallbackIdentifier) {
        const recoveredZPage = await fetchZPageByIdentifier(
          fetch,
          sessionId,
          fallbackIdentifier,
        );

        if (recoveredZPage) {
          return json({
            identifier: recoveredZPage.vanity || recoveredZPage.free2zaddr,
            message: isCreate
              ? "Article saved successfully"
              : "Article updated successfully",
            recovered: true,
            savedAt: Date.now(),
            zpage: recoveredZPage,
          });
        }
      }
    }

    return json(
      {
        error:
          data.vanity || data.title
            ? "Please fix the validation errors"
            : message,
        validationErrors: {
          vanity: data.vanity?.[0] || data.vanity || undefined,
          title: data.title?.[0] || data.title || undefined,
        },
      },
      { status: response.status },
    );
  }

  const zpage = (await response.json()) as ZPage;

  return json({
    identifier: zpage.vanity || zpage.free2zaddr,
    message: isCreate
      ? "Article saved successfully"
      : "Article updated successfully",
    savedAt: Date.now(),
    zpage,
  });
};
