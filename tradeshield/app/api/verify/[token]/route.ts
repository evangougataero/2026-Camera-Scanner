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
        {
          error:
            "Supabase environment variables are missing.",
        },
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
          detectSessionInUrl: false,
        },
      }
    );

    const formData = await request.formData();

    const sellerName =
      formData.get("seller_name")?.toString();

    const sellerEmail =
      formData.get("seller_email")?.toString();

    const sellerPhone =
      formData.get("seller_phone")?.toString();

    const sellerConfirmed =
      formData.get("seller_confirmed")?.toString() === "true";

    const fraudAcknowledged =
      formData.get("fraud_acknowledged")?.toString() === "true";

    // -----------------------------
    // Validate seller information
    // -----------------------------

    if (!sellerName || !sellerEmail || !sellerPhone) {
      return Response.json(
        {
          error:
            "All seller information fields are required.",
        },
        { status: 400 }
      );
    }

    if (!sellerConfirmed) {
      return Response.json(
        {
          error:
            "You must confirm the transaction.",
        },
        { status: 400 }
      );
    }

    if (!fraudAcknowledged) {
      return Response.json(
        {
          error:
            "You must acknowledge the transaction record and fraud prevention notice.",
        },
        { status: 400 }
      );
    }

    // -----------------------------
    // Find transaction
    // -----------------------------

    const {
      data: transaction,
      error: transactionError,
    } = await supabase
      .from("transactions")
      .select("id, verification_status")
      .eq("public_token", token)
      .single();

    if (transactionError || !transaction) {
      return Response.json(
        {
          error: "Transaction not found.",
        },
        { status: 404 }
      );
    }

    // -----------------------------
    // Prevent verification-link reuse
    // -----------------------------

    if (
      transaction.verification_status !== "pending"
    ) {
      return Response.json(
        {
          error:
            "This verification link has already been submitted and can no longer be used.",
        },
        { status: 409 }
      );
    }

    // -----------------------------
    // Save verification
    // -----------------------------

    const {
      data,
      error,
    } = await supabase
      .from("transactions")
      .update({
        seller_name: sellerName,
        seller_email: sellerEmail,
        seller_phone: sellerPhone,

        seller_confirmed: true,
        fraud_acknowledged: true,

        verification_status: "submitted",
        verified_at: new Date().toISOString(),
      })
      .eq("public_token", token)
      .eq("verification_status", "pending")
      .select()
      .maybeSingle();

    if (error) {
      console.error(
        "Database update error:",
        error
      );

      return Response.json(
        {
          error:
            "Supabase error: " +
            error.message,
        },
        { status: 500 }
      );
    }

    // If another request already used the link,
    // there will no longer be a pending row.
    if (!data) {
      return Response.json(
        {
          error:
            "This verification link has already been submitted and can no longer be used.",
        },
        { status: 409 }
      );
    }

    return Response.json({
      success: true,
      transaction: data,
    });
  } catch (error) {
    console.error(
      "Verification error:",
      error
    );

    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unknown server error.",
      },
      { status: 500 }
    );
  }
}