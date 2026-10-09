import {
  adminClient,
  apiError,
  eventManagementConfigured,
  validAdminSecret,
  validBookSecret,
} from "@/lib/transfer-server";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(
    { enabled: eventManagementConfigured() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const uuid = /^[a-f0-9-]{36}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ secret: string }> },
) {
  try {
    const { secret } = await params;
    if (!validBookSecret(secret)) throw new Error("invalid_link");
    const body = (await request.json()) as {
      eventId?: string;
      action?: string;
      adminSecret?: string;
    };
    if (
      !body.eventId ||
      !uuid.test(body.eventId) ||
      !["delete", "restore"].includes(body.action ?? "") ||
      typeof body.adminSecret !== "string"
    )
      throw new Error("invalid_request");

    if (!eventManagementConfigured()) throw new Error("admin_not_configured");
    const admin = adminClient();
    const { data: authorization, error: authError } = await admin.rpc(
      "authorize_event_admin",
      {
        p_secret: secret,
        p_verified: validAdminSecret(body.adminSecret),
      },
    );
    if (authError) throw new Error("admin_check_failed");
    if (authorization !== "allowed") throw new Error(String(authorization));

    const { data, error } = await admin.rpc("manage_event_lifecycle", {
      p_secret: secret,
      p_event: body.eventId,
      p_action: body.action,
    });
    if (error) throw new Error(error.message);
    return Response.json(
      { ok: true, result: data },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const response = apiError(error);
    return Response.json(
      { error: response.message },
      { status: response.status },
    );
  }
}
