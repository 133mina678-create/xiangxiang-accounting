import { describe, it, expect } from "vitest";
import { validateDeploymentEnv } from "../scripts/check-deploy-env.mjs";
describe("Vercel deployment configuration", () => {
  const env = {
    VERCEL: "1",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
  };
  it("accepts public configuration and local checks without credentials", () => {
    expect(() => validateDeploymentEnv(env)).not.toThrow();
    expect(() => validateDeploymentEnv({})).not.toThrow();
  });
  it("rejects missing and placeholder values", () => {
    expect(() => validateDeploymentEnv({ VERCEL: "1" })).toThrow();
    expect(() =>
      validateDeploymentEnv({
        ...env,
        NEXT_PUBLIC_SUPABASE_URL: "https://your-project.supabase.co",
      }),
    ).toThrow();
  });
  it("rejects secret and service role keys", () => {
    expect(() =>
      validateDeploymentEnv({
        ...env,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_example",
      }),
    ).toThrow();
    const jwt =
      "a." +
      Buffer.from(JSON.stringify({ role: "service_role" })).toString(
        "base64url",
      ) +
      ".b";
    expect(() =>
      validateDeploymentEnv({
        ...env,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: jwt,
      }),
    ).toThrow();
  });
  it("accepts legacy anon keys", () => {
    const jwt =
      "a." +
      Buffer.from(JSON.stringify({ role: "anon" })).toString("base64url") +
      ".b";
    expect(() =>
      validateDeploymentEnv({
        ...env,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: jwt,
      }),
    ).not.toThrow();
  });
});
