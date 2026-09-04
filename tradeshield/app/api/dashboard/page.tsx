"use client";

import { FormEvent, useState } from "react";

export default function DashboardPage() {
  const [itemName, setItemName] = useState("");
  const [itemPrice, setItemPrice] = useState("");
  const [listingUrl, setListingUrl] = useState("");
  const [shipByDate, setShipByDate] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [verificationUrl, setVerificationUrl] = useState("");
  const [verificationCode, setVerificationCode] = useState("");

  async function createTransaction(event: FormEvent) {
    event.preventDefault();

    setLoading(true);
    setError("");
    setVerificationUrl("");
    setVerificationCode("");

    try {
      const response = await fetch("/api/transactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          item_name: itemName,
          item_price: itemPrice,
          listing_url: listingUrl,
          ship_by_date: shipByDate,
        }),
      });

      const responseText = await response.text();

let result;

try {
  result = responseText ? JSON.parse(responseText) : {};
} catch {
  throw new Error(
    `Server returned an invalid response. Status: ${response.status}`
  );
}

      if (!response.ok) {
        throw new Error(result.error || "Failed to create transaction.");
      }

      const fullUrl =
        window.location.origin + result.verificationUrl;

      setVerificationUrl(fullUrl);
      setVerificationCode(
        result.transaction.verification_code
      );
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

  async function copyLink() {
    await navigator.clipboard.writeText(verificationUrl);
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f4f6f8",
        padding: "50px 20px",
        fontFamily: "Arial, Helvetica, sans-serif",
      }}
    >
      
      <div
        style={{
          maxWidth: "650px",
          margin: "0 auto",
        }}
      >
        <div
          style={{
            marginBottom: "25px",
          }}
        >
          <h1
            style={{
              margin: 0,
              fontSize: "32px",
              color: "#111827",
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
            Transaction Verification Dashboard
          </p>
        </div>

        <div
          style={{
            background: "white",
            borderRadius: "12px",
            padding: "30px",
            boxShadow: "0 2px 10px rgba(0,0,0,0.08)",
          }}
        >
          <h2
            style={{
              marginTop: 0,
              marginBottom: "25px",
              color: "#111827",
            }}
          >
            Create Transaction
          </h2>

          <form onSubmit={createTransaction}>
            <label style={labelStyle}>
              Item Name
            </label>

            <input
              type="text"
              required
              value={itemName}
              onChange={(e) => setItemName(e.target.value)}
              placeholder="Canon EOS Rebel T3i"
              style={inputStyle}
            />

            <label style={labelStyle}>
              Purchase Price
            </label>

            <input
              type="number"
              required
              min="0.01"
              step="0.01"
              value={itemPrice}
              onChange={(e) => setItemPrice(e.target.value)}
              placeholder="185.00"
              style={inputStyle}
            />

            <label style={labelStyle}>
              Facebook Marketplace URL
            </label>

            <input
              type="url"
              value={listingUrl}
              onChange={(e) => setListingUrl(e.target.value)}
              placeholder="https://www.facebook.com/marketplace/item/..."
              style={inputStyle}
            />

            <label style={labelStyle}>
              Ship-by Date
            </label>

            <input
              type="date"
              value={shipByDate}
              onChange={(e) => setShipByDate(e.target.value)}
              style={inputStyle}
            />

            <button
              type="submit"
              disabled={loading}
              style={{
                width: "100%",
                padding: "14px",
                marginTop: "10px",
                border: "none",
                borderRadius: "8px",
                background: loading ? "#9ca3af" : "#111827",
                color: "white",
                fontSize: "16px",
                fontWeight: 600,
                cursor: loading ? "not-allowed" : "pointer",
              }}
            >
              {loading
                ? "Creating..."
                : "Create Verification"}
            </button>
          </form>

          {error && (
            <div
              style={{
                marginTop: "20px",
                padding: "14px",
                borderRadius: "8px",
                background: "#fee2e2",
                color: "#991b1b",
              }}
            >
              {error}
            </div>
          )}

          {verificationUrl && (
            <div
              style={{
                marginTop: "25px",
                padding: "20px",
                borderRadius: "10px",
                background: "#f3f4f6",
              }}
            >
              <h3
                style={{
                  marginTop: 0,
                  color: "#111827",
                }}
              >
                Verification Created
              </h3>

              <p
                style={{
                  marginBottom: "5px",
                  color: "#6b7280",
                  fontSize: "14px",
                }}
              >
                Seller verification link
              </p>

              <div
                style={{
                  background: "white",
                  border: "1px solid #d1d5db",
                  borderRadius: "6px",
                  padding: "12px",
                  wordBreak: "break-all",
                  color: "#111827",
                }}
              >
                {verificationUrl}
              </div>

              <p
                style={{
                  marginTop: "18px",
                  marginBottom: "5px",
                  color: "#6b7280",
                  fontSize: "14px",
                }}
              >
                Possession verification code
              </p>

              <div
                style={{
                  fontSize: "24px",
                  fontWeight: "bold",
                  letterSpacing: "2px",
                  color: "#111827",
                }}
              >
                {verificationCode}
              </div>

              <button
                onClick={copyLink}
                style={{
                  marginTop: "20px",
                  padding: "10px 16px",
                  border: "1px solid #111827",
                  borderRadius: "7px",
                  background: "white",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                Copy Seller Link
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

const labelStyle = {
  display: "block",
  marginBottom: "7px",
  marginTop: "18px",
  color: "#374151",
  fontSize: "14px",
  fontWeight: 600,
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
  backgroundColor: "#ffffff",
};