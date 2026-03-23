import { z } from "zod";
import type { LinkedInOAuthProps } from "./linkedin-handler";

type LinkedInEnv = {
  LINKEDIN_CLIENT_ID?: string;
  LINKEDIN_CLIENT_SECRET?: string;
  LINKEDIN_VERSION?: string;
  RESTLI_PROTOCOL_VERSION?: string;
  ENABLE_DEBUG_TOOLS?: string;
};

type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
};

type LinkedInUserInfo = {
  sub?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
  email_verified?: boolean;
  picture?: string;
};

type CachedAccessToken = {
  accessToken: string;
  expiresAt: number;
};

const tokenCacheByUser = new Map<string, CachedAccessToken>();
const LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const LINKEDIN_POST_URL = "https://api.linkedin.com/v2/ugcPosts";
const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";

function text(value: string): ToolResponse {
  return { content: [{ type: "text", text: value }] };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function parseVisibility(value: string | undefined): "PUBLIC" | "CONNECTIONS" {
  if (value === "CONNECTIONS") {
    return "CONNECTIONS";
  }

  return "PUBLIC";
}

async function refreshAccessToken(input: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; expiresAt: number }> {
  const tokenResponse = await fetch(LINKEDIN_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    }).toString(),
  });

  if (!tokenResponse.ok) {
    const details = await tokenResponse.text();
    throw new Error(`Failed to refresh LinkedIn access token (${tokenResponse.status}): ${details}`);
  }

  const payload = (await tokenResponse.json()) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!payload.access_token) {
    throw new Error("LinkedIn refresh response did not include access_token");
  }

  return {
    accessToken: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  };
}

async function getAccessToken(env: LinkedInEnv, props: LinkedInOAuthProps): Promise<string> {
  const now = Date.now();
  const cacheKey = props.linkedinUserId;
  const cached = tokenCacheByUser.get(cacheKey);
  if (cached && cached.expiresAt - 30_000 > now) {
    return cached.accessToken;
  }

  if (props.expiresAt - 30_000 > now && props.accessToken) {
    tokenCacheByUser.set(cacheKey, {
      accessToken: props.accessToken,
      expiresAt: props.expiresAt,
    });
    return props.accessToken;
  }

  if (props.refreshToken && env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET) {
    const refreshed = await refreshAccessToken({
      refreshToken: props.refreshToken,
      clientId: env.LINKEDIN_CLIENT_ID,
      clientSecret: env.LINKEDIN_CLIENT_SECRET,
    });

    tokenCacheByUser.set(cacheKey, refreshed);
    return refreshed.accessToken;
  }

  throw new Error("LinkedIn access token is expired. Re-authenticate via OAuth.");
}

async function linkedinRequest<T>(input: {
  accessToken: string;
  env: LinkedInEnv;
  url: string;
  method?: "GET" | "POST";
  body?: unknown;
}): Promise<{ data: T; headers: Headers }> {
  const response = await fetch(input.url, {
    method: input.method ?? "GET",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "X-Restli-Protocol-Version": input.env.RESTLI_PROTOCOL_VERSION ?? "2.0.0",
      "LinkedIn-Version": input.env.LINKEDIN_VERSION ?? "202210",
      ...(input.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(input.body ? { body: JSON.stringify(input.body) } : {}),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`LinkedIn API request failed (${response.status}): ${details}`);
  }

  const raw = await response.text();
  const data = raw ? (JSON.parse(raw) as T) : ({} as T);

  return {
    data,
    headers: response.headers,
  };
}

function buildArticleMedia(
  mediaUrls: string[],
  mediaTitles?: string[],
  mediaDescriptions?: string[],
): Array<{
  status: "READY";
  originalUrl: string;
  title: { text: string };
  description: { text: string };
}> {
  return mediaUrls.map((url, index) => ({
    status: "READY",
    originalUrl: url,
    title: {
      text: mediaTitles?.[index] ?? `Link ${index + 1}`,
    },
    description: {
      text: mediaDescriptions?.[index] ?? "",
    },
  }));
}

async function getCurrentUser(accessToken: string): Promise<LinkedInUserInfo> {
  const response = await fetch(LINKEDIN_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Failed to load LinkedIn profile (${response.status}): ${details}`);
  }

  return (await response.json()) as LinkedInUserInfo;
}

export function registerLinkedInTools(
  server: {
    tool: (
      name: string,
      schema: Record<string, z.ZodTypeAny>,
      handler: (args: any) => Promise<ToolResponse> | ToolResponse,
    ) => void;
  },
  env: LinkedInEnv,
  auth: {
    getOAuthProps: () => LinkedInOAuthProps | null;
  },
): void {
  const requireProps = (): LinkedInOAuthProps => {
    const props = auth.getOAuthProps();
    if (!props) {
      throw new Error("No LinkedIn OAuth session is available. Authenticate via OAuth first.");
    }

    return props;
  };

  server.tool("get_profile", {}, async () => {
    try {
      const props = requireProps();
      const accessToken = await getAccessToken(env, props);
      const user = await getCurrentUser(accessToken);

      const profileText = `LinkedIn Profile:\n- Name: ${user.name ?? "N/A"}\n- Given Name: ${user.given_name ?? "N/A"}\n- Family Name: ${user.family_name ?? "N/A"}\n- Email: ${user.email ?? "N/A"}\n- Email Verified: ${user.email_verified ?? "N/A"}\n- User ID (sub): ${user.sub ?? "N/A"}\n- Picture URL: ${user.picture ?? "N/A"}`;
      return text(profileText);
    } catch (error: unknown) {
      return text(`Failed to get profile: ${toErrorMessage(error)}`);
    }
  });

  server.tool(
    "create_post",
    {
      text: z.string().min(1),
      visibility: z.enum(["PUBLIC", "CONNECTIONS"]).default("PUBLIC"),
    },
    async ({ text: postText, visibility }) => {
      try {
        const props = requireProps();
        const accessToken = await getAccessToken(env, props);
        const user = await getCurrentUser(accessToken);
        const userId = user.sub;
        if (!userId) {
          throw new Error("Could not resolve LinkedIn user ID from profile");
        }

        const payload = {
          author: `urn:li:person:${userId}`,
          lifecycleState: "PUBLISHED",
          specificContent: {
            "com.linkedin.ugc.ShareContent": {
              shareCommentary: {
                text: postText,
              },
              shareMediaCategory: "NONE",
            },
          },
          visibility: {
            "com.linkedin.ugc.MemberNetworkVisibility": parseVisibility(visibility),
          },
        };

        const response = await linkedinRequest<Record<string, unknown>>({
          accessToken,
          env,
          method: "POST",
          url: LINKEDIN_POST_URL,
          body: payload,
        });

        const postId = response.headers.get("x-restli-id") ?? "(no post id in header)";
        return text(`Successfully created LinkedIn post with ID: ${postId}`);
      } catch (error: unknown) {
        return text(`Failed to create post: ${toErrorMessage(error)}`);
      }
    },
  );

  server.tool(
    "create_post_with_media",
    {
      text: z.string().min(1),
      media_urls: z.array(z.string().url()).min(1),
      media_titles: z.array(z.string()).optional(),
      media_descriptions: z.array(z.string()).optional(),
      visibility: z.enum(["PUBLIC", "CONNECTIONS"]).default("PUBLIC"),
    },
    async ({ text: postText, media_urls, media_titles, media_descriptions, visibility }) => {
      try {
        const props = requireProps();
        const accessToken = await getAccessToken(env, props);
        const user = await getCurrentUser(accessToken);
        const userId = user.sub;
        if (!userId) {
          throw new Error("Could not resolve LinkedIn user ID from profile");
        }

        const payload = {
          author: `urn:li:person:${userId}`,
          lifecycleState: "PUBLISHED",
          specificContent: {
            "com.linkedin.ugc.ShareContent": {
              shareCommentary: {
                text: postText,
              },
              shareMediaCategory: "ARTICLE",
              media: buildArticleMedia(media_urls, media_titles, media_descriptions),
            },
          },
          visibility: {
            "com.linkedin.ugc.MemberNetworkVisibility": parseVisibility(visibility),
          },
        };

        const response = await linkedinRequest<Record<string, unknown>>({
          accessToken,
          env,
          method: "POST",
          url: LINKEDIN_POST_URL,
          body: payload,
        });

        const postId = response.headers.get("x-restli-id") ?? "(no post id in header)";
        return text(`Successfully created LinkedIn post with media. Post ID: ${postId}`);
      } catch (error: unknown) {
        return text(`Failed to create post with media: ${toErrorMessage(error)}`);
      }
    },
  );

  if (env.ENABLE_DEBUG_TOOLS === "true") {
    server.tool("get_auth_diagnostics", {}, async () => {
      try {
        const props = requireProps();
        const now = Date.now();
        return text(
          JSON.stringify(
            {
              userId: props.linkedinUserId,
              displayName: props.displayName,
              grantedScopes: props.grantedScopes,
              hasRefreshToken: Boolean(props.refreshToken),
              expiresInMs: props.expiresAt - now,
            },
            null,
            2,
          ),
        );
      } catch (error: unknown) {
        return text(`Failed to inspect auth session: ${toErrorMessage(error)}`);
      }
    });
  }
}
