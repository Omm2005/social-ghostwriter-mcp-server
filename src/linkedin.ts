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
  isError?: boolean;
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

type MentionInput = {
  entity_urn: string;
  start: number;
  length: number;
  entity_type: "member" | "company";
};

type CachedAccessToken = {
  accessToken: string;
  expiresAt: number;
};

type LinkArticleMedia = {
  status: "READY";
  originalUrl: string;
  title: { text: string };
  description: { text: string };
};

type PostMediaInputItem = {
  type?: "IMAGE" | "VIDEO";
  url: string;
  title?: string;
  description?: string;
};

type MentionAttribute = {
  start: number;
  length: number;
  value:
    | { "com.linkedin.common.MemberAttributedEntity": { member: string } }
    | { "com.linkedin.common.CompanyAttributedEntity": { company: string } };
};

class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

class LinkedInApiError extends Error {
  status: number;
  body: string;
  code?: string;
  serviceErrorCode?: number;

  constructor(input: {
    status: number;
    body: string;
    code?: string;
    serviceErrorCode?: number;
    context?: string;
  }) {
    const context = input.context ? `${input.context}: ` : "";
    super(`${context}LinkedIn API ${input.status}: ${input.body}`);
    this.name = "LinkedInApiError";
    this.status = input.status;
    this.body = input.body;
    this.code = input.code;
    this.serviceErrorCode = input.serviceErrorCode;
  }

  static fromResponse(response: Response, body: string, context?: string): LinkedInApiError {
    let code: string | undefined;
    let serviceErrorCode: number | undefined;

    try {
      const parsed = JSON.parse(body) as { code?: string; serviceErrorCode?: number };
      code = typeof parsed.code === "string" ? parsed.code : undefined;
      serviceErrorCode =
        typeof parsed.serviceErrorCode === "number" ? parsed.serviceErrorCode : undefined;
    } catch {
      // keep raw body only
    }

    return new LinkedInApiError({
      status: response.status,
      body,
      code,
      serviceErrorCode,
      context,
    });
  }
}

const tokenCacheByUser = new Map<string, CachedAccessToken>();
const LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const LINKEDIN_POST_URL = "https://api.linkedin.com/v2/ugcPosts";
const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const LINKEDIN_ASSET_REGISTER_URL = "https://api.linkedin.com/rest/assets?action=registerUpload";
const LINKEDIN_V2_ASSET_REGISTER_URL = "https://api.linkedin.com/v2/assets?action=registerUpload";

function successText(value: string): ToolResponse {
  return { content: [{ type: "text", text: value }] };
}

function errorText(value: string): ToolResponse {
  return { content: [{ type: "text", text: value }], isError: true };
}

function parseVisibility(value: string | undefined): "PUBLIC" | "CONNECTIONS" {
  return value === "CONNECTIONS" ? "CONNECTIONS" : "PUBLIC";
}

function normalizeLinkedInVersion(version: string | undefined): string {
  const raw = (version ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 6) {
    return digits.slice(0, 6);
  }
  return "202506";
}

function getRestliVersion(env: LinkedInEnv): string {
  return env.RESTLI_PROTOCOL_VERSION?.trim() || "2.0.0";
}

function summarizeError(error: unknown): string {
  if (error instanceof ToolInputError || error instanceof AuthError) {
    return error.message;
  }

  if (error instanceof LinkedInApiError) {
    if (error.status === 401) {
      return "LinkedIn authentication expired or invalid. Re-authenticate via OAuth.";
    }

    if (error.status === 403) {
      if (error.body.includes("partnerApiAssets")) {
        return "LinkedIn app lacks assets upload permission for this endpoint. Ensure Share on LinkedIn product and w_member_social scope are enabled, then re-authorize.";
      }
      return "LinkedIn denied this operation (403). Verify product access and OAuth scopes.";
    }

    if (error.status === 426 && error.code === "NONEXISTENT_VERSION") {
      return "LinkedIn-Version is not active. Use a current YYYYMM version (for example 202506).";
    }

    if (error.status === 422) {
      return `LinkedIn rejected payload (422): ${error.body}`;
    }

    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function parseJsonSafe<T>(response: Response): Promise<T | null> {
  const raw = await response.text();
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function requestJson<T>(input: {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  context: string;
}): Promise<{ data: T; headers: Headers }> {
  const response = await fetch(input.url, {
    method: input.method ?? "GET",
    headers: input.headers,
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });

  if (!response.ok) {
    const body = await response.text();
    throw LinkedInApiError.fromResponse(response, body, input.context);
  }

  const parsed = await parseJsonSafe<T>(response);
  return {
    data: (parsed ?? ({} as T)) as T,
    headers: response.headers,
  };
}

function linkedinApiHeaders(input: {
  env: LinkedInEnv;
  accessToken: string;
  includeVersion?: boolean;
  includeContentType?: boolean;
}): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.accessToken}`,
    "X-Restli-Protocol-Version": getRestliVersion(input.env),
  };

  if (input.includeVersion !== false) {
    headers["LinkedIn-Version"] = normalizeLinkedInVersion(input.env.LINKEDIN_VERSION);
  }

  if (input.includeContentType !== false) {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

async function refreshAccessToken(input: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; expiresAt: number }> {
  const response = await fetch(LINKEDIN_TOKEN_URL, {
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

  if (!response.ok) {
    const body = await response.text();
    throw LinkedInApiError.fromResponse(response, body, "Refreshing LinkedIn access token");
  }

  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!payload.access_token) {
    throw new AuthError("LinkedIn refresh response did not include access_token.");
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

  if (props.accessToken && props.expiresAt - 30_000 > now) {
    tokenCacheByUser.set(cacheKey, {
      accessToken: props.accessToken,
      expiresAt: props.expiresAt,
    });
    return props.accessToken;
  }

  if (!props.refreshToken) {
    throw new AuthError("LinkedIn access token is expired and no refresh token is available. Re-authenticate via OAuth.");
  }

  if (!env.LINKEDIN_CLIENT_ID || !env.LINKEDIN_CLIENT_SECRET) {
    throw new AuthError("Missing LINKEDIN_CLIENT_ID or LINKEDIN_CLIENT_SECRET for token refresh.");
  }

  const refreshed = await refreshAccessToken({
    refreshToken: props.refreshToken,
    clientId: env.LINKEDIN_CLIENT_ID,
    clientSecret: env.LINKEDIN_CLIENT_SECRET,
  });

  tokenCacheByUser.set(cacheKey, refreshed);
  return refreshed.accessToken;
}

async function getCurrentUser(accessToken: string): Promise<LinkedInUserInfo> {
  const response = await fetch(LINKEDIN_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw LinkedInApiError.fromResponse(response, body, "Fetching LinkedIn user profile");
  }

  const profile = (await response.json()) as LinkedInUserInfo;
  if (!profile.sub) {
    throw new AuthError("LinkedIn profile response missing user id (sub).");
  }

  return profile;
}

function buildArticleMedia(items: PostMediaInputItem[]): LinkArticleMedia[] {
  return items.map((item, index) => ({
    status: "READY",
    originalUrl: item.url,
    title: { text: item.title ?? `Link ${index + 1}` },
    description: { text: item.description ?? "" },
  }));
}

function buildMentionAttributes(input: {
  text: string;
  mentions?: MentionInput[];
}): MentionAttribute[] {
  const mentions = input.mentions ?? [];
  if (mentions.length === 0) {
    return [];
  }

  const charLength = [...input.text].length;

  return mentions.map((mention, index) => {
    if (mention.start < 0 || mention.length <= 0) {
      throw new ToolInputError(`mentions[${index}] has invalid range. start must be >= 0 and length > 0.`);
    }

    if (mention.start + mention.length > charLength) {
      throw new ToolInputError(
        `mentions[${index}] range is out of bounds for post text. text length=${charLength}, start=${mention.start}, length=${mention.length}.`,
      );
    }

    if (mention.entity_type === "member" && !mention.entity_urn.startsWith("urn:li:person:")) {
      throw new ToolInputError(`mentions[${index}] expects a person URN for member type.`);
    }

    if (
      mention.entity_type === "company" &&
      !mention.entity_urn.startsWith("urn:li:organization:")
    ) {
      throw new ToolInputError(`mentions[${index}] expects an organization URN for company type.`);
    }

    if (mention.entity_type === "member") {
      return {
        start: mention.start,
        length: mention.length,
        value: {
          "com.linkedin.common.MemberAttributedEntity": {
            member: mention.entity_urn,
          },
        },
      };
    }

    return {
      start: mention.start,
      length: mention.length,
      value: {
        "com.linkedin.common.CompanyAttributedEntity": {
          company: mention.entity_urn,
        },
      },
    };
  });
}

async function createUgcPost(input: {
  env: LinkedInEnv;
  accessToken: string;
  authorUrn: string;
  lifecycleState?: "PUBLISHED" | "DRAFT";
  text: string;
  visibility: "PUBLIC" | "CONNECTIONS";
  shareMediaCategory: "NONE" | "ARTICLE" | "IMAGE" | "VIDEO";
  media?: unknown[];
  mentions?: MentionInput[];
}): Promise<string> {
  const payload = {
    author: input.authorUrn,
    lifecycleState: input.lifecycleState ?? "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: {
          text: input.text,
          attributes: buildMentionAttributes({
            text: input.text,
            mentions: input.mentions,
          }),
        },
        shareMediaCategory: input.shareMediaCategory,
        ...(input.media ? { media: input.media } : {}),
      },
    },
    visibility: {
      "com.linkedin.ugc.MemberNetworkVisibility": input.visibility,
    },
  };

  const result = await requestJson<Record<string, unknown>>({
    url: LINKEDIN_POST_URL,
    method: "POST",
    context: "Creating UGC post",
    headers: linkedinApiHeaders({ env: input.env, accessToken: input.accessToken }),
    body: payload,
  });

  return result.headers.get("x-restli-id") ?? "(no post id in header)";
}

async function registerUpload(input: {
  accessToken: string;
  env: LinkedInEnv;
  ownerUrn: string;
  recipe: "urn:li:digitalmediaRecipe:feedshare-image" | "urn:li:digitalmediaRecipe:feedshare-video";
}): Promise<{ assetUrn: string; uploadUrl: string; uploadHeaders?: Record<string, string> }> {
  const registerPayload = {
    registerUploadRequest: {
      owner: input.ownerUrn,
      recipes: [input.recipe],
      serviceRelationships: [
        {
          identifier: "urn:li:userGeneratedContent",
          relationshipType: "OWNER",
        },
      ],
      supportedUploadMechanism: ["SYNCHRONOUS_UPLOAD"],
    },
  };

  const restResponse = await fetch(LINKEDIN_ASSET_REGISTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Linkedin-Version": normalizeLinkedInVersion(input.env.LINKEDIN_VERSION),
      "X-Restli-Protocol-Version": getRestliVersion(input.env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(registerPayload),
  });

  let responseToUse = restResponse;
  if (!restResponse.ok) {
    const restBody = await restResponse.text();
    const shouldFallback =
      restResponse.status === 403 &&
      (restBody.includes("partnerApiAssets") || restBody.includes("ACCESS_DENIED"));

    if (!shouldFallback) {
      throw LinkedInApiError.fromResponse(restResponse, restBody, "Registering upload (/rest/assets)");
    }

    const v2Response = await fetch(LINKEDIN_V2_ASSET_REGISTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "X-Restli-Protocol-Version": getRestliVersion(input.env),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(registerPayload),
    });

    if (!v2Response.ok) {
      const v2Body = await v2Response.text();
      throw LinkedInApiError.fromResponse(v2Response, v2Body, "Registering upload (/v2/assets)");
    }

    responseToUse = v2Response;
  }

  const payload = (await responseToUse.json()) as {
    value?: {
      asset?: string;
      uploadMechanism?: {
        "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"?: {
          uploadUrl?: string;
          headers?: Record<string, string>;
        };
      };
    };
  };

  const assetUrn = payload.value?.asset;
  const uploadRequest =
    payload.value?.uploadMechanism?.["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"];

  if (!assetUrn || !uploadRequest?.uploadUrl) {
    throw new AuthError("LinkedIn registerUpload response missing asset URN or upload URL.");
  }

  return {
    assetUrn,
    uploadUrl: uploadRequest.uploadUrl,
    uploadHeaders: uploadRequest.headers,
  };
}

async function uploadBinaryFromUrl(input: {
  sourceUrl: string;
  uploadUrl: string;
  uploadHeaders?: Record<string, string>;
  mediaKind: "image" | "video";
}): Promise<void> {
  const sourceResponse = await fetch(input.sourceUrl);
  if (!sourceResponse.ok) {
    throw new ToolInputError(`Failed to fetch media URL (${sourceResponse.status}): ${input.sourceUrl}`);
  }

  const bytes = await sourceResponse.arrayBuffer();
  const sourceContentType = sourceResponse.headers.get("content-type") ?? "application/octet-stream";
  const contentType = sourceContentType.split(";")[0].trim().toLowerCase();

  if (input.mediaKind === "image") {
    const supportedImageTypes = new Set(["image/jpeg", "image/jpg", "image/png", "image/gif"]);
    if (!supportedImageTypes.has(contentType)) {
      throw new ToolInputError(
        `LinkedIn image uploads support JPG/PNG/GIF. Detected content-type: ${sourceContentType}. Use a direct .jpg/.png/.gif URL.`,
      );
    }
  }

  const uploadHeaders = new Headers();
  uploadHeaders.set("Content-Type", contentType);
  for (const [key, value] of Object.entries(input.uploadHeaders ?? {})) {
    uploadHeaders.set(key, value);
  }

  const uploadResponse = await fetch(input.uploadUrl, {
    method: "PUT",
    headers: uploadHeaders,
    body: bytes,
  });

  if (!uploadResponse.ok) {
    const body = await uploadResponse.text();
    if (uploadResponse.status === 415) {
      throw new ToolInputError(
        `LinkedIn rejected media type (${contentType}) with 415. For images use JPG/PNG/GIF URLs.`,
      );
    }
    throw LinkedInApiError.fromResponse(uploadResponse, body, "Uploading media binary to LinkedIn");
  }
}

function mentionSchema() {
  return z
    .array(
      z.object({
        entity_urn: z.string().min(1),
        start: z.number().int().min(0),
        length: z.number().int().min(1),
        entity_type: z.enum(["member", "company"]),
      }),
    )
    .optional();
}

function mediaItemSchema() {
  return z.object({
    type: z.enum(["IMAGE", "VIDEO"]),
    url: z.string().url(),
    title: z.string().optional(),
    description: z.string().optional(),
  });
}

function normalizeAuthorUrn(authorUrn: string | undefined, fallbackAuthorUrn: string): string {
  const value = (authorUrn ?? "").trim();
  if (!value) {
    return fallbackAuthorUrn;
  }

  const isPerson = value.startsWith("urn:li:person:");
  const isOrganization = value.startsWith("urn:li:organization:");
  if (!isPerson && !isOrganization) {
    throw new ToolInputError(
      "author_urn must be a valid LinkedIn URN: urn:li:person:<id> or urn:li:organization:<id>.",
    );
  }

  return value;
}

async function withLinkedInSession<T>(
  env: LinkedInEnv,
  auth: { getOAuthProps: () => LinkedInOAuthProps | null },
  fn: (ctx: { accessToken: string; user: LinkedInUserInfo; userId: string; authorUrn: string }) => Promise<T>,
): Promise<T> {
  const props = auth.getOAuthProps();
  if (!props) {
    throw new AuthError("No LinkedIn OAuth session is available. Authenticate via OAuth first.");
  }

  const accessToken = await getAccessToken(env, props);
  const user = await getCurrentUser(accessToken);
  const userId = user.sub;
  if (!userId) {
    throw new AuthError("Could not resolve LinkedIn user ID from profile.");
  }

  return fn({
    accessToken,
    user,
    userId,
    authorUrn: `urn:li:person:${userId}`,
  });
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
  const runTool = async (action: string, fn: () => Promise<ToolResponse>): Promise<ToolResponse> => {
    try {
      return await fn();
    } catch (error: unknown) {
      return errorText(`${action} failed: ${summarizeError(error)}`);
    }
  };

  server.tool("linkedin_get_profile", {}, async () => {
    return runTool("Get profile", async () =>
      withLinkedInSession(env, auth, async ({ user }) => {
        return successText(
          JSON.stringify(
            {
              sub: user.sub ?? null,
              name: user.name ?? null,
              given_name: user.given_name ?? null,
              family_name: user.family_name ?? null,
              email: user.email ?? null,
              email_verified: user.email_verified ?? null,
              picture: user.picture ?? null,
            },
            null,
            2,
          ),
        );
      }),
    );
  });

  server.tool(
    "linkedin_create_post",
    {
      text: z.string().min(1),
      author_urn: z.string().min(1).optional(),
      lifecycle_state: z.enum(["PUBLISHED", "DRAFT"]).default("PUBLISHED"),
      visibility: z.enum(["PUBLIC", "CONNECTIONS"]).default("PUBLIC"),
      mentions: mentionSchema(),
      media: z.array(mediaItemSchema()).optional(),
    },
    async ({
      text,
      visibility,
      mentions,
      author_urn,
      lifecycle_state,
      media,
    }) => {
      return runTool("Create post", async () =>
        withLinkedInSession(env, auth, async ({ accessToken, authorUrn }) => {
          const effectiveAuthorUrn = normalizeAuthorUrn(author_urn, authorUrn);
          const mediaItems = media ?? [];
          const imageItems = mediaItems.filter((item: PostMediaInputItem) => item.type === "IMAGE");
          const videoItems = mediaItems.filter((item: PostMediaInputItem) => item.type === "VIDEO");
          const hasImage = imageItems.length > 0;
          const hasVideo = videoItems.length > 0;

          const createdPosts: Array<{ mode: "TEXT" | "IMAGE" | "VIDEO"; post_id: string }> = [];

          if (hasImage) {
            const uploads = await Promise.all(
              imageItems.map(async (image: PostMediaInputItem) => {
                const upload = await registerUpload({
                  accessToken,
                  env,
                  ownerUrn: effectiveAuthorUrn,
                  recipe: "urn:li:digitalmediaRecipe:feedshare-image",
                });

                await uploadBinaryFromUrl({
                  sourceUrl: image.url,
                  uploadUrl: upload.uploadUrl,
                  uploadHeaders: upload.uploadHeaders,
                  mediaKind: "image",
                });

                return { upload, meta: image };
              }),
            );

            const postId = await createUgcPost({
              env,
              accessToken,
              authorUrn: effectiveAuthorUrn,
              lifecycleState: lifecycle_state,
              text,
              visibility: parseVisibility(visibility),
              shareMediaCategory: "IMAGE",
              media: uploads.map(({ upload, meta }, index) => ({
                status: "READY",
                media: upload.assetUrn,
                title: {
                  text: meta.title ?? (uploads.length > 1 ? `Image ${index + 1}` : "Image"),
                },
                description: {
                  text: meta.description ?? "",
                },
              })),
              mentions,
            });
            createdPosts.push({ mode: "IMAGE", post_id: postId });
          }

          if (hasVideo) {
            const uploads = await Promise.all(
              videoItems.map(async (video: PostMediaInputItem) => {
                const upload = await registerUpload({
                  accessToken,
                  env,
                  ownerUrn: effectiveAuthorUrn,
                  recipe: "urn:li:digitalmediaRecipe:feedshare-video",
                });

                await uploadBinaryFromUrl({
                  sourceUrl: video.url,
                  uploadUrl: upload.uploadUrl,
                  uploadHeaders: upload.uploadHeaders,
                  mediaKind: "video",
                });

                return { upload, meta: video };
              }),
            );

            const postId = await createUgcPost({
              env,
              accessToken,
              authorUrn: effectiveAuthorUrn,
              lifecycleState: lifecycle_state,
              text,
              visibility: parseVisibility(visibility),
              shareMediaCategory: "VIDEO",
              media: uploads.map(({ upload, meta }, index) => ({
                status: "READY",
                media: upload.assetUrn,
                title: {
                  text: meta.title ?? (uploads.length > 1 ? `Video ${index + 1}` : "Video"),
                },
                description: {
                  text: meta.description ?? "",
                },
              })),
              mentions,
            });
            createdPosts.push({ mode: "VIDEO", post_id: postId });
          }

          if (!hasImage && !hasVideo) {
            const postId = await createUgcPost({
              env,
              accessToken,
              authorUrn: effectiveAuthorUrn,
              lifecycleState: lifecycle_state,
              text,
              visibility: parseVisibility(visibility),
              shareMediaCategory: "NONE",
              mentions,
            });
            createdPosts.push({ mode: "TEXT", post_id: postId });
          }

          return successText(
            JSON.stringify(
              {
                created_count: createdPosts.length,
                created_posts: createdPosts,
              },
              null,
              2,
            ),
          );
        }),
      );
    },
  );

  if (env.ENABLE_DEBUG_TOOLS === "true") {
    server.tool("linkedin_get_auth_diagnostics", {}, async () => {
      return runTool("Get auth diagnostics", async () => {
        const props = auth.getOAuthProps();
        if (!props) {
          throw new AuthError("No LinkedIn OAuth session is available.");
        }

        return successText(
          JSON.stringify(
            {
              userId: props.linkedinUserId,
              displayName: props.displayName,
              grantedScopes: props.grantedScopes,
              hasRefreshToken: Boolean(props.refreshToken),
              expiresInMs: props.expiresAt - Date.now(),
              normalizedApiVersion: normalizeLinkedInVersion(env.LINKEDIN_VERSION),
              restliProtocolVersion: getRestliVersion(env),
            },
            null,
            2,
          ),
        );
      });
    });
  }
}
