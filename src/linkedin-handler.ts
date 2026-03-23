import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import {
  addApprovedClient,
  bindStateToSession,
  createOAuthState,
  generateCSRFProtection,
  isClientApproved,
  OAuthError,
  renderApprovalDialog,
  validateCSRFToken,
  validateOAuthState,
} from "./workers-oauth-utils";

const LINKEDIN_AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const LINKEDIN_PROFILE_URL = "https://api.linkedin.com/v2/userinfo";

const LINKEDIN_SCOPES = ["openid", "profile", "email", "w_member_social"].join(" ");

type LinkedInUserProfile = {
  sub: string;
  name?: string;
  email?: string;
};

export type LinkedInOAuthProps = {
  linkedinUserId: string;
  displayName: string;
  email: string;
  accessToken: string;
  refreshToken: string | null;
  grantedScopes: string;
  expiresAt: number;
};

type Bindings = {
  LINKEDIN_CLIENT_ID?: string;
  LINKEDIN_CLIENT_SECRET?: string;
  COOKIE_ENCRYPTION_KEY: string;
  ALLOWED_MCP_CLIENT_IDS?: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
};

const app = new Hono<{ Bindings: Bindings }>();

function isClientAllowed(clientId: string, allowedCsv?: string): boolean {
  if (!allowedCsv || allowedCsv.trim().length === 0) {
    return true;
  }

  const allowed = new Set(
    allowedCsv
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );

  return allowed.has(clientId);
}

function redirectToLinkedIn(
  request: Request,
  input: { clientId: string; stateToken: string; scopes: string },
  headers?: Headers,
): Response {
  const authorizeUrl = new URL(LINKEDIN_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", input.clientId);
  authorizeUrl.searchParams.set("redirect_uri", new URL("/callback", request.url).href);
  authorizeUrl.searchParams.set("scope", input.scopes);
  authorizeUrl.searchParams.set("state", input.stateToken);

  const responseHeaders = headers ?? new Headers();
  responseHeaders.set("Location", authorizeUrl.toString());

  return new Response(null, {
    status: 302,
    headers: responseHeaders,
  });
}

async function exchangeCodeForLinkedInTokens(input: {
  code: string;
  requestUrl: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; refreshToken: string | null; grantedScopes: string; expiresIn: number }> {
  const tokenResponse = await fetch(LINKEDIN_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: new URL("/callback", input.requestUrl).href,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    }).toString(),
  });

  const raw = await tokenResponse.text();
  let payload: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    payload = {};
  }

  if (!tokenResponse.ok) {
    throw new OAuthError(
      "invalid_grant",
      payload.error_description ?? payload.error ?? `Failed token exchange (${tokenResponse.status})`,
      400,
    );
  }

  if (!payload.access_token) {
    throw new OAuthError("invalid_grant", "LinkedIn did not return an access_token", 400);
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    grantedScopes: payload.scope ?? LINKEDIN_SCOPES,
    expiresIn: payload.expires_in ?? 3600,
  };
}

async function fetchLinkedInProfile(accessToken: string): Promise<LinkedInUserProfile> {
  const response = await fetch(LINKEDIN_PROFILE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new OAuthError("invalid_grant", "Failed to fetch LinkedIn user profile", 400);
  }

  const profile = (await response.json()) as LinkedInUserProfile;
  if (!profile.sub) {
    throw new OAuthError("invalid_grant", "LinkedIn profile response missing user id", 400);
  }

  return profile;
}

app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const { clientId } = oauthReqInfo;

  if (!clientId) {
    return c.text("Invalid request", 400);
  }
  if (!isClientAllowed(clientId, c.env.ALLOWED_MCP_CLIENT_IDS)) {
    return c.text("OAuth client is not allowed for this server", 403);
  }

  const approved = await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY);
  if (approved) {
    const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie } = await bindStateToSession(stateToken);
    return redirectToLinkedIn(
      c.req.raw,
      {
        clientId: c.env.LINKEDIN_CLIENT_ID ?? "",
        stateToken,
        scopes: LINKEDIN_SCOPES,
      },
      new Headers({ "Set-Cookie": setCookie }),
    );
  }

  const { token: csrfToken, setCookie } = generateCSRFProtection();
  const mcpClient = await c.env.OAUTH_PROVIDER.lookupClient(clientId);
  return renderApprovalDialog(c.req.raw, {
    client: mcpClient,
    csrfToken,
    setCookie,
    server: {
      name: "LinkedIn MCP",
      description: "Authorize your MCP client to use your LinkedIn account",
    },
    state: { oauthReqInfo },
  });
});

app.post("/authorize", async (c) => {
  try {
    const formData = await c.req.raw.formData();
    const { clearCookie } = validateCSRFToken(formData, c.req.raw);

    const encodedState = formData.get("state");
    if (!encodedState || typeof encodedState !== "string") {
      return c.text("Missing state in form data", 400);
    }

    let state: { oauthReqInfo?: AuthRequest };
    try {
      state = JSON.parse(atob(encodedState)) as { oauthReqInfo?: AuthRequest };
    } catch {
      return c.text("Invalid state data", 400);
    }

    if (!state.oauthReqInfo?.clientId) {
      return c.text("Invalid request", 400);
    }
    if (!isClientAllowed(state.oauthReqInfo.clientId, c.env.ALLOWED_MCP_CLIENT_IDS)) {
      return c.text("OAuth client is not allowed for this server", 403);
    }

    const linkedinClientId = c.env.LINKEDIN_CLIENT_ID?.trim() ?? "";
    if (!linkedinClientId) {
      return c.text("Missing LINKEDIN_CLIENT_ID secret", 500);
    }

    const approvedClientCookie = await addApprovedClient(
      c.req.raw,
      state.oauthReqInfo.clientId,
      c.env.COOKIE_ENCRYPTION_KEY,
    );

    const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
    const stateCookie = await bindStateToSession(stateToken);

    const headers = new Headers();
    headers.append("Set-Cookie", clearCookie);
    headers.append("Set-Cookie", approvedClientCookie);
    headers.append("Set-Cookie", stateCookie.setCookie);

    return redirectToLinkedIn(
      c.req.raw,
      {
        clientId: linkedinClientId,
        stateToken,
        scopes: LINKEDIN_SCOPES,
      },
      headers,
    );
  } catch (error: unknown) {
    if (error instanceof OAuthError) {
      return error.toResponse();
    }

    return c.text("Internal server error", 500);
  }
});

app.get("/callback", async (c) => {
  let oauthReqInfo: AuthRequest;
  let clearSessionCookie: string;

  try {
    const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
    oauthReqInfo = result.oauthReqInfo;
    clearSessionCookie = result.clearCookie;
  } catch (error: unknown) {
    if (error instanceof OAuthError) {
      return error.toResponse();
    }

    return c.text("Internal server error", 500);
  }

  if (!oauthReqInfo.clientId) {
    return c.text("Invalid OAuth request data", 400);
  }

  const linkedinError = c.req.query("error");
  if (linkedinError) {
    return c.text(`LinkedIn authorization failed: ${linkedinError}`, 400);
  }

  const code = c.req.query("code");
  if (!code) {
    return c.text("Missing code in LinkedIn callback. Check redirect URI and consent flow.", 400);
  }

  try {
    const linkedinClientId = c.env.LINKEDIN_CLIENT_ID?.trim() ?? "";
    const linkedinClientSecret = c.env.LINKEDIN_CLIENT_SECRET?.trim() ?? "";
    if (!linkedinClientId || !linkedinClientSecret) {
      return c.text("Missing LINKEDIN_CLIENT_ID or LINKEDIN_CLIENT_SECRET", 500);
    }

    const tokens = await exchangeCodeForLinkedInTokens({
      code,
      requestUrl: c.req.url,
      clientId: linkedinClientId,
      clientSecret: linkedinClientSecret,
    });

    const profile = await fetchLinkedInProfile(tokens.accessToken);

    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      metadata: {
        label: profile.name ?? profile.sub,
      },
      props: {
        linkedinUserId: profile.sub,
        displayName: profile.name ?? profile.sub,
        email: profile.email ?? "",
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        grantedScopes: tokens.grantedScopes,
        expiresAt: Date.now() + tokens.expiresIn * 1000,
      } as LinkedInOAuthProps,
      request: oauthReqInfo,
      scope: oauthReqInfo.scope,
      userId: profile.sub,
    });

    const headers = new Headers({ Location: redirectTo });
    headers.set("Set-Cookie", clearSessionCookie);

    return new Response(null, {
      status: 302,
      headers,
    });
  } catch (error: unknown) {
    if (error instanceof OAuthError) {
      return error.toResponse();
    }

    return c.text("Failed LinkedIn OAuth callback handling", 500);
  }
});

export { app as LinkedInHandler };
