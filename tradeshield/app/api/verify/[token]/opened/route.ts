import { createClient } from "@supabase/supabase-js";

type RouteContext = {
  params: Promise<{
    token: string;
  }>;
};

export async function POST(
  request: Request,
  context: RouteContext
) {
  try {
    const { token } = await context.params;

    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL;

    const supabaseSecretKey =
      process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseSecretKey) {
      return Response.json(
        { error: "Server configuration error." },
        { status: 500 }
      );
    }

    const supabase = createClient(
      supabaseUrl,
      supabaseSecretKey,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      }
    );

    // Only mark the FIRST click.
    const { data, error } = await supabase
      .from("transactions")
      .update({
        opened: true,
        opened_at: new Date().toISOString(),
      })
      .eq("public_token", token)
      .eq("opened", false)
      .eq("verification_status", "pending")
      .select("id")
      .maybeSingle();

    if (error) {
      console.error("Opened tracking error:", error);

      return Response.json(
        { error: "Could not record verification opening." },
        { status: 500 }
      );
    }

    return Response.json({
      success: true,
      newlyOpened: Boolean(data),
    });
  } catch (error) {
    console.error("Opened tracking error:", error);

    return Response.json(
      { error: "Unknown server error." },
      { status: 500 }
    );
  }
}