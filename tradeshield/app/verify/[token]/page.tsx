import { createClient } from "@supabase/supabase-js";
import { notFound } from "next/navigation";
import BeginVerificationButton from "./BeginVerificationButton";

type PageProps = {
  params: Promise<{
    token: string;
  }>;
};

export default async function VerifyPage({ params }: PageProps) {
  const { token } = await params;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseSecretKey) {
    throw new Error("Supabase environment variables are missing.");
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

// Get transaction
const { data: transaction, error } = await supabase
  .from("transactions")
  .select("*")
  .eq("public_token", token)
  .single();

// 1. Make sure transaction exists
if (error || !transaction) {
  return (
    <main>
      <h1>Transaction Not Found</h1>
    </main>
  );
}

// 2. ADD YOUR NEW CHECK HERE
if (transaction.verification_status !== "pending") {
  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f4f6f8",
        padding: "50px 20px",
        fontFamily: "Arial, Helvetica, sans-serif",
        color: "#111827",
      }}
    >
      <div
        style={{
          maxWidth: "620px",
          margin: "0 auto",
          background: "#ffffff",
          padding: "30px",
          borderRadius: "12px",
          boxShadow: "0 2px 10px rgba(0,0,0,0.08)",
        }}
      >
        <h1 style={{ marginTop: 0 }}>
          Verification Already Submitted
        </h1>

        <p
          style={{
            color: "#4b5563",
            lineHeight: 1.6,
          }}
        >
          This transaction verification has already been submitted.
          This link can no longer be used to create another submission.
        </p>
      </div>
    </main>
  );
}

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f4f6f8",
        padding: "50px 20px",
        fontFamily: "Arial, Helvetica, sans-serif",
        color: "#111827",
      }}
    >
      <div
        style={{
          maxWidth: "620px",
          margin: "0 auto",
        }}
      >
        <div style={{ marginBottom: "25px" }}>
          <h1
            style={{
              margin: 0,
              fontSize: "32px",
            }}
          >
            TradeShield
          </h1>

          <p
            style={{
              color: "#6b7280",
              marginTop: "7px",
            }}
          >
            Transaction Verification
          </p>
        </div>

        <div
          style={{
            background: "#ffffff",
            borderRadius: "12px",
            padding: "30px",
            boxShadow: "0 2px 10px rgba(0,0,0,0.08)",
          }}
        >
          <p
            style={{
              fontSize: "13px",
              fontWeight: 700,
              letterSpacing: "1px",
              color: "#6b7280",
              marginTop: 0,
            }}
          >
            TRANSACTION VERIFICATION
          </p>

          <h2
            style={{
              marginBottom: "8px",
              fontSize: "25px",
            }}
          >
            {transaction.item_name}
          </h2>

          <div
            style={{
              fontSize: "28px",
              fontWeight: 700,
              marginBottom: "25px",
            }}
          >
            ${Number(transaction.item_price).toFixed(2)}
          </div>

          <p
            style={{
              lineHeight: 1.6,
              color: "#4b5563",
            }}
          >
            This buyer uses TradeShield to document shipped
            peer-to-peer purchases. Complete the verification process
            before payment is sent.
          </p>

<div style={{ marginTop: "25px" }}>
  <BeginVerificationButton token={token} />
</div>
        </div>
      </div>
    </main>
  );
}