"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function BeginVerificationButton({
  token,
}: {
  token: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function beginVerification() {
    if (loading) return;

    setLoading(true);

    try {
      await fetch(
        `/api/verify/${encodeURIComponent(token)}/opened`,
        {
          method: "POST",
        }
      );
    } catch (error) {
      console.error(
        "Could not record verification opening:",
        error
      );
    }

    // Don't prevent the seller from continuing if
    // tracking happens to fail.
    router.push(
      `/verify/${encodeURIComponent(token)}/form`
    );
  }

  return (
    <button
      type="button"
      onClick={beginVerification}
      disabled={loading}
      style={{
        width: "100%",
        padding: "14px",
        background: loading ? "#374151" : "#111827",
        color: "#ffffff",
        border: "none",
        borderRadius: "8px",
        fontSize: "16px",
        fontWeight: 600,
        cursor: loading ? "wait" : "pointer",
      }}
    >
      {loading
        ? "Opening Verification..."
        : "Begin Verification"}
    </button>
  );
}