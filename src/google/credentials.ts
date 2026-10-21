import { promises as fs } from "node:fs";

export interface GoogleClientCredentials { clientId: string; clientSecret: string }
export interface GoogleCredentialResult extends GoogleClientCredentials { error?: string }

/** Only an operator-controlled backend environment path can select this file. Never expose its contents. */
export async function readGoogleWebCredentials(file: string): Promise<GoogleCredentialResult> {
  if (!file.trim()) return { clientId: "", clientSecret: "" };
  try {
    const info = await fs.stat(file);
    if (!info.isFile() || info.size > 64 * 1024) throw new Error("invalid");
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    const web = parsed?.web;
    if (!web || typeof web.client_id !== "string" || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(web.client_id)
      || typeof web.client_secret !== "string" || !web.client_secret.trim() || web.client_secret.length > 4096
      || (web.auth_uri && web.auth_uri !== "https://accounts.google.com/o/oauth2/auth"
        && web.auth_uri !== "https://accounts.google.com/o/oauth2/v2/auth")
      || (web.token_uri && web.token_uri !== "https://oauth2.googleapis.com/token")) throw new Error("invalid");
    return { clientId: web.client_id, clientSecret: web.client_secret };
  } catch {
    return { clientId: "", clientSecret: "", error: "Google OAuth 凭据文件不可读或不是有效的 Web 应用凭据；请检查后端 GOOGLE_OAUTH_CREDENTIALS_FILE。" };
  }
}

/** An explicit pair is atomic: never combine one client's ID with another client's secret. */
export function selectGoogleCredentials(clientId: string | undefined, clientSecret: string | undefined, shared: GoogleClientCredentials): GoogleClientCredentials {
  const id = clientId?.trim() || "", secret = clientSecret?.trim() || "";
  return id || secret ? { clientId: id, clientSecret: secret } : { clientId: shared.clientId, clientSecret: shared.clientSecret };
}
