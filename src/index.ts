import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { LinkedInHandler, type LinkedInOAuthProps } from "./linkedin-handler";
import { registerLinkedInTools } from "./linkedin";

type WorkerEnv = {
  LINKEDIN_CLIENT_ID?: string;
  LINKEDIN_CLIENT_SECRET?: string;
  LINKEDIN_VERSION?: string;
  RESTLI_PROTOCOL_VERSION?: string;
  ENABLE_DEBUG_TOOLS?: string;
};

export class LinkedInMCP extends McpAgent<WorkerEnv, Record<string, never>, LinkedInOAuthProps> {
  server: any = new McpServer({
    name: "linkedin-mcp-cloudflare",
    version: "1.0.0",
  });

  async init() {
    registerLinkedInTools(this.server, this.env, {
      getOAuthProps: () => this.props ?? null,
    });
  }
}

export default new OAuthProvider({
  apiHandler: LinkedInMCP.serve("/mcp"),
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: LinkedInHandler as any,
  tokenEndpoint: "/token",
});
