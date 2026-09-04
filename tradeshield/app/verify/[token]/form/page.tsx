"use client";

import { FormEvent, useState } from "react";
import { useParams } from "next/navigation";

export default function VerificationFormPage() {
  const params = useParams();
  const token = params.token as string;

  const [sellerName, setSellerName] = useState("");
  const [sellerEmail, setSellerEmail] = useState("");
  const [sellerPhone, setSellerPhone] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [fraudAcknowledged, setFraudAcknowledged] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [completedTransaction, setCompletedTransaction] = useState<any>(null);

  async function submitVerification(event: FormEvent) {
    event.preventDefault();

    setLoading(true);
    setError("");

    try {

      const formData = new FormData();

      formData.append("seller_name", sellerName);
      formData.append("seller_email", sellerEmail);
      formData.append("seller_phone", sellerPhone);
      formData.append(
        "seller_confirmed",
        confirmed ? "true" : "false"
      );

      formData.append(
  "fraud_acknowledged",
  fraudAcknowledged ? "true" : "false"
);

      const response = await fetch(`/api/verify/${token}`, {
        method: "POST",
        body: formData,
      });

      const text = await response.text();

      let result;

      try {
        result = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(
          `Server returned an invalid response. Status ${response.status}`
        );
      }

      if (!response.ok) {
        throw new Error(
          result.error || "Verification could not be completed."
        );
      }

   setCompletedTransaction(result.transaction);
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Something went wrong.");
      }
    } finally {
      setLoading(false);
    }
  }

  if (completedTransaction) {
    return (
  <main style={mainStyle}>
    <div style={cardStyle}>
      <h1
        style={{
          marginTop: 0,
          marginBottom: "8px",
        }}
      >
        Transaction Record Submitted
      </h1>

      <p
        style={{
          color: "#4b5563",
          lineHeight: 1.6,
        }}
      >
        Your seller information, identity documentation,
        acknowledgements, and transaction information have been
        recorded successfully.
      </p>

      <div
        style={{
          marginTop: "25px",
          border: "1px solid #d1d5db",
          borderRadius: "8px",
          overflow: "hidden",
        }}
      >
        <RecordRow
          label="Seller Certification"
          value="Confirmed"
        />

        <RecordRow
          label="Fraud Prevention Acknowledgement"
          value="Confirmed"
        />

        <RecordRow
          label="Submission Status"
          value="Recorded"
          last
        />
      </div>

      <p
        style={{
          marginTop: "22px",
          color: "#6b7280",
          fontSize: "14px",
          lineHeight: 1.6,
        }}
      >
        No further action is required on this verification page.
        The buyer may review the submitted transaction record
        before sending payment.
      </p>
    </div>
  </main>
);
}

  return (
    <main style={mainStyle}>
      <style jsx global>{`
        input {
          color: #111827 !important;
          background: #ffffff !important;
        }

        input::placeholder {
          color: #9ca3af !important;
          opacity: 1;
        }
      `}</style>

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
              marginTop: "7px",
              color: "#6b7280",
            }}
          >
            Seller Verification
          </p>
        </div>

        <div style={cardStyle}>
          <h2
            style={{
              marginTop: 0,
              marginBottom: "8px",
            }}
          >
            Seller Information
          </h2>

          <p
            style={{
              color: "#6b7280",
              lineHeight: 1.5,
              marginBottom: "25px",
            }}
          >
            Enter your information and verify your identity.
          </p>

          <form onSubmit={submitVerification}>
            <label style={labelStyle}>
              Full Name
            </label>

            <input
              type="text"
              required
              value={sellerName}
              onChange={(e) => setSellerName(e.target.value)}
              placeholder="John Smith"
              style={inputStyle}
            />

            <label style={labelStyle}>
              Email Address
            </label>

            <input
              type="email"
              required
              value={sellerEmail}
              onChange={(e) => setSellerEmail(e.target.value)}
              placeholder="john@example.com"
              style={inputStyle}
            />

            <label style={labelStyle}>
              Phone Number
            </label>

            <input
              type="tel"
              required
              value={sellerPhone}
              onChange={(e) => setSellerPhone(e.target.value)}
              placeholder="(555) 123-4567"
              style={inputStyle}
            />

<div
  style={{
    marginTop: "25px",
    padding: "20px",
    background: "#fff7ed",
    border: "1px solid #fed7aa",
    borderRadius: "8px",
  }}
>
  <h3
    style={{
      marginTop: 0,
      marginBottom: "8px",
      color: "#111827",
    }}
  >
    Fraud Prevention Notice
  </h3>

  <p
    style={{
      color: "#4b5563",
      lineHeight: 1.6,
      marginBottom: 0,
    }}
  >
    TradeShield records transaction details, seller-provided
    contact information, acknowledgements, and submission timestamps. These records
    may be retained for transaction security, dispute resolution,
    and documentation of suspected fraud.
  </p>
</div>

<div
  style={{
    marginTop: "18px",
    padding: "18px",
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: "8px",
  }}
>
  <label
    style={{
      display: "flex",
      alignItems: "flex-start",
      gap: "10px",
      cursor: "pointer",
    }}
  >
    <input
      type="checkbox"
      required
      checked={confirmed}
      onChange={(e) =>
        setConfirmed(e.target.checked)
      }
      style={{
        marginTop: "4px",
      }}
    />

    <span
      style={{
        color: "#374151",
        lineHeight: 1.55,
      }}
    >
      I certify that I am the person identified in the
      documentation provided, that I have agreed to this
      transaction, and that I intend to ship the agreed item
      after receiving payment. I confirm that the information
      I have provided is accurate.
    </span>
  </label>
</div>

<div
  style={{
    marginTop: "14px",
    padding: "18px",
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: "8px",
  }}
>
  <label
    style={{
      display: "flex",
      alignItems: "flex-start",
      gap: "10px",
      cursor: "pointer",
    }}
  >
    <input
      type="checkbox"
      required
      checked={fraudAcknowledged}
      onChange={(e) =>
        setFraudAcknowledged(e.target.checked)
      }
      style={{
        marginTop: "4px",
      }}
    />

    <span
      style={{
        color: "#374151",
        lineHeight: 1.55,
      }}
    >
      I understand that information and documentation submitted
      through TradeShield may be retained as part of the
      transaction record and may be provided to payment
      processors, marketplaces, financial institutions, or
      relevant authorities when reasonably necessary to
      investigate suspected fraud or resolve a transaction
      dispute.
    </span>
  </label>
</div>

            <button
              type="submit"
              disabled={loading}
              style={{
                width: "100%",
                marginTop: "25px",
                padding: "14px",
                background: loading ? "#9ca3af" : "#111827",
                color: "#ffffff",
                border: "none",
                borderRadius: "8px",
                fontSize: "16px",
                fontWeight: 600,
                cursor: loading ? "not-allowed" : "pointer",
              }}
            >
              {loading
  ? "Submitting Transaction Record..."
  : "Confirm & Submit Transaction Record"}
            </button>

            {error && (
              <div
                style={{
                  marginTop: "18px",
                  padding: "14px",
                  background: "#fee2e2",
                  color: "#991b1b",
                  borderRadius: "8px",
                }}
              >
                {error}
              </div>
            )}
          </form>
        </div>
      </div>
    </main>
  );
}

function RecordRow({
  label,
  value,
  last = false,
}: {
  label: string;
  value: string;
  last?: boolean;
}) {
  return (
    <div
      style={{
        padding: "16px",
        display: "flex",
        justifyContent: "space-between",
        gap: "20px",
        borderBottom: last
          ? "none"
          : "1px solid #e5e7eb",
        background: "#f9fafb",
      }}
    >
      <span
        style={{
          color: "#6b7280",
          fontSize: "14px",
        }}
      >
        {label}
      </span>

      <strong
        style={{
          color: "#111827",
          textAlign: "right",
        }}
      >
        {value}
      </strong>
    </div>
  );
}

const mainStyle = {
  minHeight: "100vh",
  background: "#f4f6f8",
  padding: "50px 20px",
  fontFamily: "Arial, Helvetica, sans-serif",
  color: "#111827",
};

const cardStyle = {
  background: "#ffffff",
  borderRadius: "12px",
  padding: "30px",
  boxShadow: "0 2px 10px rgba(0,0,0,0.08)",
};

const labelStyle = {
  display: "block",
  marginTop: "18px",
  marginBottom: "7px",
  fontSize: "14px",
  fontWeight: 600,
  color: "#374151",
};

const inputStyle = {
  width: "100%",
  boxSizing: "border-box" as const,
  padding: "12px",
  border: "1px solid #d1d5db",
  borderRadius: "7px",
  fontSize: "15px",
  outline: "none",
  color: "#111827",
  background: "#ffffff",
};